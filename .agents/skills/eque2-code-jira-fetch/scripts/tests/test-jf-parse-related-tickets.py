#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Smoke tests for jf-parse-related-tickets.py.

Covers:
- Stage-3 shape: parent_epic / subtasks / blockers / linked_issues at top level.
- Raw Jira shape: fields.subtasks / fields.issuelinks / fields.parent.
- Blocker detection: only inward "is blocked by" links count.
- Empty / missing fields: counts are zero, no crashes.
- Missing jira_dir → exit 2.
- Missing related-tickets.json → exit 2.
- Malformed JSON → exit 2.
- --help works.

Run:
    uv run scripts/tests/test-jf-parse-related-tickets.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent.resolve()
PARSE_SCRIPT = SCRIPT_DIR.parent / "jf-parse-related-tickets.py"


def _run(jira_dir: Path, expect_exit: int = 0) -> dict:
    result = subprocess.run(
        [sys.executable, str(PARSE_SCRIPT), str(jira_dir)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == expect_exit, (
        f"expected exit {expect_exit}, got {result.returncode}\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    return json.loads(result.stdout)


def _write_related(jira_dir: Path, payload: dict) -> None:
    jira_dir.mkdir(parents=True, exist_ok=True)
    (jira_dir / "related-tickets.json").write_text(json.dumps(payload))


def test_stage3_shape():
    """Stage-3 output shape parses into expected normalised summary."""
    with tempfile.TemporaryDirectory() as tmp:
        jira_dir = Path(tmp) / "jira"
        _write_related(jira_dir, {
            "ticket_key": "PROJ-42",
            "parent_epic": {"key": "PROJ-1", "summary": "Big rollout"},
            "subtasks": [
                {"key": "PROJ-43", "fields": {"summary": "Wire endpoint", "status": {"name": "Done"}}},
                {"key": "PROJ-44", "summary": "Add tests", "status": "In Progress"},
            ],
            "blockers": [
                {"key": "PROJ-99", "summary": "Migration first", "status": "Open"},
            ],
            "linked_issues": [
                {"key": "PROJ-50", "type": "Relates", "summary": "Adjacent work"},
            ],
            "fetch_metadata": {"timestamp": "2026-01-01T00:00:00Z"},
        })

        result = _run(jira_dir)
        assert result["status"] == "ok"
        assert result["ticket_key"] == "PROJ-42"
        assert result["shape_detected"] == "stage3"

        s = result["summary"]
        assert s["counts"] == {"subtasks": 2, "blockers": 1, "linked": 1}
        assert s["parent_epic"] == {"key": "PROJ-1", "summary": "Big rollout"}
        assert s["subtasks"][0]["key"] == "PROJ-43"
        assert s["subtasks"][0]["summary"] == "Wire endpoint"
        assert s["subtasks"][0]["status"] == "Done"
        assert s["subtasks"][1]["status"] == "In Progress"
        assert s["blockers"][0]["key"] == "PROJ-99"
        assert s["linked_issues"][0]["key"] == "PROJ-50"


def test_raw_jira_shape():
    """Raw Jira REST response shape parses correctly."""
    with tempfile.TemporaryDirectory() as tmp:
        jira_dir = Path(tmp) / "jira"
        _write_related(jira_dir, {
            "key": "PROJ-42",
            "fields": {
                "summary": "Main ticket",
                "subtasks": [
                    {"key": "PROJ-43", "fields": {"summary": "ST1", "status": {"name": "Open"}}},
                ],
                "parent": {"key": "PROJ-1", "fields": {"summary": "Epic Name"}},
                "issuelinks": [
                    {
                        "type": {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
                        "inwardIssue": {"key": "PROJ-99", "fields": {"summary": "Blocker A"}},
                    },
                    {
                        "type": {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
                        "outwardIssue": {"key": "PROJ-100", "fields": {"summary": "We block this"}},
                    },
                    {
                        "type": {"name": "Relates", "inward": "relates to", "outward": "relates to"},
                        "inwardIssue": {"key": "PROJ-50", "fields": {"summary": "Related"}},
                    },
                ],
            },
        })

        result = _run(jira_dir)
        assert result["shape_detected"] == "raw_jira"
        assert result["ticket_key"] == "PROJ-42"
        s = result["summary"]
        assert s["counts"]["subtasks"] == 1
        # Only the inward "is blocked by" should be a blocker; outward "blocks"
        # means we block someone else and lands in linked_issues.
        assert s["counts"]["blockers"] == 1
        assert s["blockers"][0]["key"] == "PROJ-99"
        # Linked: outward Blocks + inward Relates → 2 entries
        assert s["counts"]["linked"] == 2
        linked_keys = {l["key"] for l in s["linked_issues"]}
        assert linked_keys == {"PROJ-100", "PROJ-50"}
        assert s["parent_epic"] == {"key": "PROJ-1", "summary": "Epic Name"}


def test_empty_payload():
    """Empty payload returns zero counts and null parent_epic without crashing."""
    with tempfile.TemporaryDirectory() as tmp:
        jira_dir = Path(tmp) / "jira"
        _write_related(jira_dir, {})

        result = _run(jira_dir)
        assert result["status"] == "ok"
        s = result["summary"]
        assert s["counts"] == {"subtasks": 0, "blockers": 0, "linked": 0}
        assert s["parent_epic"] is None


def test_missing_jira_dir():
    """Nonexistent jira dir → exit 2 with jira_dir_missing."""
    result = subprocess.run(
        [sys.executable, str(PARSE_SCRIPT), "/nonexistent/jira/dir"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert payload["error"] == "jira_dir_missing"


def test_missing_related_file():
    """jira_dir exists but related-tickets.json missing → exit 2."""
    with tempfile.TemporaryDirectory() as tmp:
        jira_dir = Path(tmp) / "jira"
        jira_dir.mkdir()
        result = subprocess.run(
            [sys.executable, str(PARSE_SCRIPT), str(jira_dir)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 2
        payload = json.loads(result.stdout)
        assert payload["error"] == "related_tickets_missing"


def test_malformed_json():
    """Bad JSON → exit 2 with parse_error."""
    with tempfile.TemporaryDirectory() as tmp:
        jira_dir = Path(tmp) / "jira"
        jira_dir.mkdir()
        (jira_dir / "related-tickets.json").write_text("{not json")
        result = subprocess.run(
            [sys.executable, str(PARSE_SCRIPT), str(jira_dir)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 2
        payload = json.loads(result.stdout)
        assert payload["error"] == "parse_error"


def test_help_flag():
    result = subprocess.run(
        [sys.executable, str(PARSE_SCRIPT), "--help"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "jira_dir" in result.stdout
    assert "--pretty" in result.stdout


def main() -> int:
    tests = [
        ("stage3 shape", test_stage3_shape),
        ("raw jira shape", test_raw_jira_shape),
        ("empty payload", test_empty_payload),
        ("missing jira_dir", test_missing_jira_dir),
        ("missing related file", test_missing_related_file),
        ("malformed JSON", test_malformed_json),
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
