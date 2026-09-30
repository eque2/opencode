#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Smoke tests for cs-append-catches.py.

Covers:
- Fresh create: produces a versioned envelope with one entry.
- Append: existing valid file gains a second entry, schema_version preserved.
- Rotation on schema mismatch: broken file moved aside, fresh envelope created.
- Rotation on parse failure: malformed JSON is rotated to .broken-<ts>.
- Missing --entry/--from-file → exit 2 with invalid_entry error.
- Both --entry and --from-file supplied → exit 2.
- Missing feature_root → exit 2 with feature_root_missing.
- --help works.

Run:
    uv run scripts/tests/test-cs-append-catches.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent.resolve()
APPEND_SCRIPT = SCRIPT_DIR.parent / "cs-append-catches.py"


def _run(*args: str, expect_exit: int = 0) -> dict:
    result = subprocess.run(
        [sys.executable, str(APPEND_SCRIPT), *args],
        capture_output=True,
        text=True,
    )
    assert result.returncode == expect_exit, (
        f"expected exit {expect_exit}, got {result.returncode}\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    return json.loads(result.stdout)


def test_fresh_create():
    """Catches file doesn't exist → create with one entry, schema_version='1'."""
    with tempfile.TemporaryDirectory() as tmp:
        feature = Path(tmp)
        entry_body = json.dumps({"added_scenarios": ["S5"], "rationale": "test"})
        result = _run(
            str(feature),
            "--skill", "bmad-party-mode",
            "--stage", "6",
            "--entry", entry_body,
        )

        assert result["status"] == "ok", result
        assert result["entry_count"] == 1
        catches = json.loads((feature / ".catches.json").read_text())
        assert catches["schema_version"] == "1"
        assert len(catches["entries"]) == 1
        assert catches["entries"][0]["skill"] == "bmad-party-mode"
        assert catches["entries"][0]["stage"] == 6
        assert catches["entries"][0]["added_scenarios"] == ["S5"]


def test_append_to_existing():
    """Second invocation appends to an existing valid envelope."""
    with tempfile.TemporaryDirectory() as tmp:
        feature = Path(tmp)
        first = _run(
            str(feature),
            "--skill", "bmad-party-mode",
            "--stage", "6",
            "--entry", json.dumps({"added_scenarios": ["S5"]}),
        )
        assert first["entry_count"] == 1

        second = _run(
            str(feature),
            "--skill", "bmad-review",
            "--stage", "7",
            "--entry", json.dumps({"added_test_cases": [{"task": "T2.3", "category": "Concurrency", "case": "race"}]}),
        )
        assert second["status"] == "ok", second
        assert second["entry_count"] == 2

        catches = json.loads((feature / ".catches.json").read_text())
        assert catches["schema_version"] == "1"
        assert len(catches["entries"]) == 2
        assert catches["entries"][0]["skill"] == "bmad-party-mode"
        assert catches["entries"][1]["skill"] == "bmad-review"


def test_rotation_on_schema_mismatch():
    """schema_version != '1' triggers rotation."""
    with tempfile.TemporaryDirectory() as tmp:
        feature = Path(tmp)
        (feature / ".catches.json").write_text(json.dumps({
            "schema_version": "999",
            "entries": [{"skill": "old", "stage": 1}],
        }))

        result = _run(
            str(feature),
            "--skill", "bmad-party-mode",
            "--stage", "6",
            "--entry", json.dumps({"added_scenarios": ["S1"]}),
        )
        assert result["status"] == "rotated", result
        assert "rotated_to" in result
        assert result["entry_count"] == 1

        # Original broken file preserved
        broken = list(feature.glob(".catches.json.broken-*"))
        assert len(broken) == 1, broken
        broken_content = json.loads(broken[0].read_text())
        assert broken_content["schema_version"] == "999"

        # Fresh file written
        catches = json.loads((feature / ".catches.json").read_text())
        assert catches["schema_version"] == "1"
        assert len(catches["entries"]) == 1
        assert catches["entries"][0]["skill"] == "bmad-party-mode"


def test_rotation_on_parse_failure():
    """Malformed JSON triggers rotation."""
    with tempfile.TemporaryDirectory() as tmp:
        feature = Path(tmp)
        (feature / ".catches.json").write_text("{ not json {")

        result = _run(
            str(feature),
            "--skill", "bmad-party-mode",
            "--stage", "6",
            "--entry", json.dumps({"foo": "bar"}),
        )
        assert result["status"] == "rotated", result
        broken = list(feature.glob(".catches.json.broken-*"))
        assert len(broken) == 1


def test_missing_entry_flag_errors():
    """Neither --entry nor --from-file → exit 2 with invalid_entry."""
    with tempfile.TemporaryDirectory() as tmp:
        feature = Path(tmp)
        result = _run(
            str(feature),
            "--skill", "bmad-party-mode",
            "--stage", "6",
            expect_exit=2,
        )
        assert result["status"] == "failed"
        assert result["error"] == "invalid_entry"


def test_both_entry_sources_errors():
    """Both --entry and --from-file → exit 2."""
    with tempfile.TemporaryDirectory() as tmp:
        feature = Path(tmp)
        entry_file = feature / "entry.json"
        entry_file.write_text(json.dumps({"x": 1}))
        result = _run(
            str(feature),
            "--skill", "bmad-party-mode",
            "--stage", "6",
            "--entry", "{}",
            "--from-file", str(entry_file),
            expect_exit=2,
        )
        assert result["error"] == "invalid_entry"


def test_missing_feature_root_errors():
    """Nonexistent feature root → exit 2 with feature_root_missing."""
    result = _run(
        "/nonexistent/path/that/does/not/exist",
        "--skill", "bmad-party-mode",
        "--stage", "6",
        "--entry", "{}",
        expect_exit=2,
    )
    assert result["error"] == "feature_root_missing"


def test_from_file_input():
    """--from-file reads entry body from a JSON file."""
    with tempfile.TemporaryDirectory() as tmp:
        feature = Path(tmp)
        entry_file = feature / "entry.json"
        entry_file.write_text(json.dumps({"applied": [{"file": "a.md", "severity": "high", "summary": "x"}]}))

        result = _run(
            str(feature),
            "--skill", "bmad-review",
            "--stage", "8",
            "--from-file", str(entry_file),
        )
        assert result["status"] == "ok", result
        catches = json.loads((feature / ".catches.json").read_text())
        assert catches["entries"][0]["applied"][0]["file"] == "a.md"


def test_help_flag():
    result = subprocess.run(
        [sys.executable, str(APPEND_SCRIPT), "--help"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "feature_root" in result.stdout
    assert "--skill" in result.stdout
    assert "--stage" in result.stdout


def main() -> int:
    tests = [
        ("fresh create", test_fresh_create),
        ("append to existing", test_append_to_existing),
        ("rotation on schema mismatch", test_rotation_on_schema_mismatch),
        ("rotation on parse failure", test_rotation_on_parse_failure),
        ("missing --entry/--from-file errors", test_missing_entry_flag_errors),
        ("both entry sources error", test_both_entry_sources_errors),
        ("missing feature_root errors", test_missing_feature_root_errors),
        ("--from-file input", test_from_file_input),
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
