#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Tests for sanctum-status.py.

Covers:
- Absent sanctum: present=false, exit 1
- Complete sanctum: present=true, files_complete=true, birth_status=complete, exit 0
- Incomplete + old birth: birth_stale=true, exit 1
- Placeholder accounting: seed_placeholders, unresolved_vars, not_yet_discovered
- Stale-session listing and --prune-sessions deletion
- --help exits 0

Run:
    uv run ./scripts/tests/test-sanctum-status.py
"""

import json
import subprocess
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
STATUS_SCRIPT = SCRIPT_DIR.parent / "sanctum-status.py"
STANDARD_FILES = ["PERSONA", "CREED", "BOND", "MEMORY", "CAPABILITIES", "PULSE"]


def _make_sanctum(project: Path, birth_status="complete", birth_started_at=None, extra=None):
    """Write a minimal sanctum under project/_bmad/_memory/linus-sidecar."""
    sanctum = project / "_bmad" / "_memory" / "linus-sidecar"
    (sanctum / "sessions").mkdir(parents=True, exist_ok=True)
    started = birth_started_at or date.today().isoformat()
    (sanctum / "INDEX.md").write_text(
        f"---\nbirth_status: {birth_status}\nbirth_started_at: {started}\n---\n# Index\n"
    )
    for name in STANDARD_FILES:
        (sanctum / f"{name}.md").write_text(f"# {name}\nreal content\n")
    if extra:
        for rel, body in extra.items():
            (sanctum / rel).write_text(body)
    return sanctum


def _run(project=None, sanctum=None, extra_args=None):
    args = [sys.executable, str(STATUS_SCRIPT)]
    if sanctum is not None:
        args += ["--sanctum", str(sanctum)]
    else:
        args += ["--project-root", str(project)]
    args += extra_args or []
    proc = subprocess.run(args, capture_output=True, text=True)
    return proc.returncode, json.loads(proc.stdout)


def test_absent_sanctum():
    with tempfile.TemporaryDirectory() as tmp:
        code, d = _run(project=Path(tmp))
        assert d["present"] is False, d
        assert code == 1, f"absent sanctum should exit 1, got {code}"


def test_complete_sanctum():
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp)
        _make_sanctum(project, birth_status="complete")
        code, d = _run(project=project)
        assert d["present"] is True
        assert d["files_complete"] is True, d["files_missing"]
        assert d["birth_status"] == "complete"
        assert d["birth_stale"] is False
        assert code == 0, f"complete sanctum should exit 0, got {code}"


def test_stale_incomplete_birth():
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp)
        old = (date.today() - timedelta(days=10)).isoformat()
        _make_sanctum(project, birth_status="incomplete", birth_started_at=old)
        code, d = _run(project=project)
        assert d["birth_status"] == "incomplete"
        assert d["birth_stale"] is True, "10-day-old incomplete birth should be stale"
        assert d["birth_age_days"] >= 10
        assert code == 1


def test_placeholder_accounting():
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp)
        # BOND with an instructional placeholder, a Not-yet-discovered marker,
        # and (pathologically) an un-substituted token.
        _make_sanctum(
            project,
            extra={
                "BOND.md": "# Bond\n{Discovered during First Breath.}\n"
                "Sprint cadence: Not yet discovered — ask.\nName: {user_name}\n"
            },
        )
        _, d = _run(project=project)
        assert d["seed_placeholders"].get("BOND.md") == 1, d["seed_placeholders"]
        assert d["seed_placeholders_total"] >= 1
        assert d["unresolved_vars"].get("BOND.md") == 1, d["unresolved_vars"]
        assert d["not_yet_discovered_total"] >= 1


def test_stale_sessions_and_prune():
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp)
        sanctum = _make_sanctum(project)
        old = (date.today() - timedelta(days=30)).isoformat()
        recent = (date.today() - timedelta(days=2)).isoformat()
        (sanctum / "sessions" / f"{old}.md").write_text("old")
        (sanctum / "sessions" / f"{recent}.md").write_text("recent")

        _, d = _run(project=project)
        assert f"sessions/{old}.md" in d["stale_sessions"]
        assert f"sessions/{recent}.md" not in d["stale_sessions"]

        _, d2 = _run(project=project, extra_args=["--prune-sessions"])
        assert f"sessions/{old}.md" in d2.get("sessions_pruned", [])
        assert not (sanctum / "sessions" / f"{old}.md").exists(), "old session should be deleted"
        assert (sanctum / "sessions" / f"{recent}.md").exists(), "recent session should survive"


def test_help_flag():
    proc = subprocess.run(
        [sys.executable, str(STATUS_SCRIPT), "--help"],
        capture_output=True, text=True, check=True,
    )
    assert "project-root" in proc.stdout
    assert "sanctum" in proc.stdout


def main() -> int:
    tests = [
        ("absent sanctum", test_absent_sanctum),
        ("complete sanctum", test_complete_sanctum),
        ("stale incomplete birth", test_stale_incomplete_birth),
        ("placeholder accounting", test_placeholder_accounting),
        ("stale sessions + prune", test_stale_sessions_and_prune),
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
