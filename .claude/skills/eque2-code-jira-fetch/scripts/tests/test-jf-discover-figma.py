#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Smoke tests for jf-discover-figma.py.

Covers:
- Discovery from ticket.json description / comments / custom fields, with source tags.
- Discovery from ticket.md text scrape.
- Node ID extraction from URL query string (URL-encoded and raw).
- Deduplication by (file_id, node_id).
- Invalid file IDs rejected.
- Custom --patterns file is loaded.
- Missing both ticket.json and ticket.md → exit 2.
- Missing jira_dir → exit 2.
- --help works.

Run:
    uv run scripts/tests/test-jf-discover-figma.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent.resolve()
DISCOVER_SCRIPT = SCRIPT_DIR.parent / "jf-discover-figma.py"

GOOD_FILE_ID = "abc123DEF456GHI789j"  # 19 alphanumeric chars, in the 15-22 range
GOOD_FILE_ID_2 = "xyz987UVW654RST321"   # 18 chars
SHORT_FILE_ID = "tooshort"             # 8 chars → rejected as figma.com pattern


def _run(jira_dir: Path, *extra: str, expect_exit: int = 0) -> dict:
    result = subprocess.run(
        [sys.executable, str(DISCOVER_SCRIPT), str(jira_dir), *extra],
        capture_output=True,
        text=True,
    )
    assert result.returncode == expect_exit, (
        f"expected exit {expect_exit}, got {result.returncode}\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    return json.loads(result.stdout)


def test_discovery_from_ticket_json():
    """ticket.json description + comments + custom fields produce tagged sources."""
    with tempfile.TemporaryDirectory() as tmp:
        jira_dir = Path(tmp) / "jira"
        jira_dir.mkdir()
        payload = {
            "key": "PROJ-42",
            "fields": {
                "description": f"See design: https://www.figma.com/design/{GOOD_FILE_ID}/My-Design",
                "comment": {
                    "comments": [
                        {"body": f"Comment 1 https://figma.com/file/{GOOD_FILE_ID_2}/Other"},
                        {"body": "No link here"},
                    ],
                },
                "customfield_10100": f"https://www.figma.com/design/{GOOD_FILE_ID}/Mock?node-id=1%3A23",
            },
        }
        (jira_dir / "ticket.json").write_text(json.dumps(payload))

        result = _run(jira_dir)
        assert result["status"] == "ok", result
        urls = result["urls"]

        # Dedup rule: when a file_id has any node-id-bearing variant, the
        # no-node-id variants for that same file_id are dropped (less rich).
        # So GOOD_FILE_ID survives once — only the (GOOD_FILE_ID, "1:23")
        # entry. GOOD_FILE_ID_2 has no competing richer variant, so it
        # survives as (GOOD_FILE_ID_2, None).
        file_ids = {(u["file_id"], u["node_id"]) for u in urls}
        assert (GOOD_FILE_ID, "1:23") in file_ids
        assert (GOOD_FILE_ID_2, None) in file_ids
        assert (GOOD_FILE_ID, None) not in file_ids
        assert result["count"] == 2

        # Source tags should be present — at least one custom_field
        # (the richest variant survived), and one comment (GOOD_FILE_ID_2).
        sources = {u["source"] for u in urls}
        assert any(s.startswith("custom_field:") for s in sources)
        assert any(s.startswith("comment_") for s in sources)


def test_discovery_from_ticket_md_only():
    """No ticket.json, ticket.md has URLs → scrape works."""
    with tempfile.TemporaryDirectory() as tmp:
        jira_dir = Path(tmp) / "jira"
        jira_dir.mkdir()
        (jira_dir / "ticket.md").write_text(
            f"# PROJ-42\n\n[Design](https://www.figma.com/design/{GOOD_FILE_ID}/Foo)\n"
            f"Short link: https://fig.ma/short123\n"
        )

        result = _run(jira_dir)
        assert result["status"] == "ok"
        urls_by_id = {u["file_id"]: u for u in result["urls"]}
        assert GOOD_FILE_ID in urls_by_id
        assert urls_by_id[GOOD_FILE_ID]["source"] == "text:ticket.md"
        # fig.ma short link should be present and tagged.
        assert "short123" in urls_by_id
        assert urls_by_id["short123"]["pattern"] == "fig.ma"


def test_deduplication():
    """Same (file_id, node_id) found in multiple places → one entry."""
    with tempfile.TemporaryDirectory() as tmp:
        jira_dir = Path(tmp) / "jira"
        jira_dir.mkdir()
        url = f"https://www.figma.com/design/{GOOD_FILE_ID}/Foo?node-id=42%3A1"
        payload = {
            "fields": {
                "description": f"first: {url}",
                "comment": {"comments": [{"body": f"second: {url}"}]},
                "customfield_10100": f"third: {url}",
            }
        }
        (jira_dir / "ticket.json").write_text(json.dumps(payload))

        result = _run(jira_dir)
        assert result["count"] == 1, result
        assert result["duplicates_removed"] >= 2, result
        assert result["urls"][0]["node_id"] == "42:1"


def test_invalid_file_id_rejected():
    """A figma.com URL with a too-short file ID is rejected."""
    with tempfile.TemporaryDirectory() as tmp:
        jira_dir = Path(tmp) / "jira"
        jira_dir.mkdir()
        (jira_dir / "ticket.md").write_text(
            f"Valid: https://figma.com/design/{GOOD_FILE_ID}/X\n"
            f"Invalid: https://figma.com/file/{SHORT_FILE_ID}/Y\n"
        )
        result = _run(jira_dir)
        ids = {u["file_id"] for u in result["urls"]}
        assert GOOD_FILE_ID in ids
        assert SHORT_FILE_ID not in ids
        assert result["invalid_rejected"] >= 1


def test_custom_patterns_file():
    """--patterns overrides the default patterns file location."""
    with tempfile.TemporaryDirectory() as tmp:
        jira_dir = Path(tmp) / "jira"
        jira_dir.mkdir()
        (jira_dir / "ticket.md").write_text(
            f"https://figma.com/design/{GOOD_FILE_ID}/Y\n"
        )
        # Custom patterns file with the canonical figma.com pattern in a fenced
        # regex block.
        patterns_file = Path(tmp) / "patterns.md"
        patterns_file.write_text(
            "# Patterns\n\n"
            "```regex\nhttps?://(?:www\\.)?figma\\.com/(?:file|design)/[a-zA-Z0-9]+[^\"',}\\s]*\n```\n"
        )

        result = _run(jira_dir, "--patterns", str(patterns_file))
        assert result["count"] == 1, result
        assert result["urls"][0]["file_id"] == GOOD_FILE_ID


def test_missing_input_files():
    """jira_dir exists but no ticket.json or ticket.md → exit 2."""
    with tempfile.TemporaryDirectory() as tmp:
        jira_dir = Path(tmp) / "jira"
        jira_dir.mkdir()
        result = subprocess.run(
            [sys.executable, str(DISCOVER_SCRIPT), str(jira_dir)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 2
        payload = json.loads(result.stdout)
        assert payload["error"] == "no_input_files"


def test_missing_jira_dir():
    """Nonexistent jira_dir → exit 2."""
    result = subprocess.run(
        [sys.executable, str(DISCOVER_SCRIPT), "/nonexistent/jira/dir"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert payload["error"] == "jira_dir_missing"


def test_help_flag():
    result = subprocess.run(
        [sys.executable, str(DISCOVER_SCRIPT), "--help"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "jira_dir" in result.stdout
    assert "--patterns" in result.stdout


def main() -> int:
    tests = [
        ("discovery from ticket.json", test_discovery_from_ticket_json),
        ("discovery from ticket.md only", test_discovery_from_ticket_md_only),
        ("deduplication", test_deduplication),
        ("invalid file_id rejected", test_invalid_file_id_rejected),
        ("custom patterns file", test_custom_patterns_file),
        ("missing input files", test_missing_input_files),
        ("missing jira_dir", test_missing_jira_dir),
        ("--help flag", test_help_flag),
    ]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS  {name}")
        except AssertionError as e:
            print(f"  FAIL  {name}: {e}")
            failed += 1
        except Exception as e:
            print(f"  ERROR {name}: {type(e).__name__}: {e}")
            failed += 1

    print()
    print(f"{len(tests) - failed}/{len(tests)} passed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
