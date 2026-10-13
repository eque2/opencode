#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Tests for verify-jira-credentials.py — the advisory (non-blocking) Jira check.

Jira credentials are OPTIONAL (spec-jira-optional CAP-1/CAP-5). This script must
NEVER block an install: it always exits 0, reporting whether Jira-sourced
workflows will be available.

Covers:
- No .env             → exit 0 (advisory), guidance printed.
- .env missing a key  → exit 0 (advisory), names the missing key.
- .env malformed URL  → exit 0 (advisory), still does not block.
- All three present   → exit 0, ✅ present message.
- --help works.

Run:
    uv run scripts/tests/test-verify-jira-credentials.py
"""

import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent.resolve()
VERIFY_SCRIPT = SCRIPT_DIR.parent / "verify-jira-credentials.py"


def _run(root: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(VERIFY_SCRIPT), str(root)],
        capture_output=True,
        text=True,
    )


def test_no_env_exits_zero_advisory():
    """No .env at all → exit 0 (never blocks), guidance surfaced."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        result = _run(root)
        assert result.returncode == 0, (result.returncode, result.stderr, result.stdout)
        combined = result.stdout + result.stderr
        assert "optional" in combined.lower()
        # Must not announce a hard block / refusal.
        assert "BLOCKER" not in combined
        assert "will not proceed" not in combined


def test_missing_key_exits_zero_and_names_it():
    """.env missing JIRA_API_TOKEN → exit 0, the missing key is named."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ".env").write_text("JIRA_URL=https://x.atlassian.net\nJIRA_EMAIL=a@b.com\n")
        result = _run(root)
        assert result.returncode == 0, result.stderr
        assert "JIRA_API_TOKEN" in (result.stdout + result.stderr)


def test_malformed_url_exits_zero():
    """Present-but-malformed values are advisory, not blocking."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ".env").write_text(
            "JIRA_URL=not-a-url\nJIRA_EMAIL=a@b.com\nJIRA_API_TOKEN=tok\n"
        )
        result = _run(root)
        assert result.returncode == 0, result.stderr


def test_all_present_exits_zero_with_ok():
    """All three present + well-formed → exit 0, ✅ present message."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ".env").write_text(
            "JIRA_URL=https://x.atlassian.net\n"
            "JIRA_EMAIL=a@b.com\n"
            "JIRA_API_TOKEN=tok-123\n"
        )
        result = _run(root)
        assert result.returncode == 0, result.stderr
        assert "✅" in result.stdout
        assert "available" in result.stdout.lower()


def test_help_flag():
    result = subprocess.run(
        [sys.executable, str(VERIFY_SCRIPT), "--help"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "project_root" in result.stdout


def main() -> int:
    tests = [
        ("no env exits zero (advisory)", test_no_env_exits_zero_advisory),
        ("missing key exits zero and names it", test_missing_key_exits_zero_and_names_it),
        ("malformed url exits zero", test_malformed_url_exits_zero),
        ("all present exits zero with ok", test_all_present_exits_zero_with_ok),
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
