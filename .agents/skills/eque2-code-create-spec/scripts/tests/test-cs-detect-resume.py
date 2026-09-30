#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Smoke tests for cs-detect-resume.py.

Covers:
- Empty root → unresolved (zero candidates)
- Single jira-only folder, no target → auto-detect, recommendation=new
- Existing in-progress spec → resume with correct next_stage_file
- Existing ready-for-build spec → restart
- Explicit target that doesn't exist → recommendation=new with that name
- Multiple jira-only folders, no target → unresolved with candidate list
- Malformed frontmatter doesn't crash → falls back to resume-from-zero
- --help works

Run:
    uv run scripts/tests/test-cs-detect-resume.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent.resolve()
DETECT_SCRIPT = SCRIPT_DIR.parent / "cs-detect-resume.py"


def _run(*args: str) -> dict:
    """Invoke cs-detect-resume.py and return parsed JSON stdout."""
    result = subprocess.run(
        [sys.executable, str(DETECT_SCRIPT), *args],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def _make_spec(folder: Path, *, status: str, steps: list[int], slug: str | None = None) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    steps_str = "[" + ", ".join(str(s) for s in steps) + "]"
    slug_line = f'specSlug: "{slug}"\n' if slug else ""
    (folder / "spec.md").write_text(
        f"---\n"
        f'title: "Test"\n'
        f"{slug_line}"
        f"stepsCompleted: {steps_str}\n"
        f"status: {status}\n"
        f"---\n\n"
        f"# Feature\n"
    )


def test_empty_root_is_unresolved():
    """No folders at all, no target → unresolved with empty candidate list."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        result = _run(str(root))
        assert result["status"] == "unresolved", result
        assert result["recommendation"] == "unresolved"
        assert result["feature_id"] is None
        assert result["candidates"] == []


def test_single_jira_only_folder_auto_detects():
    """Exactly one folder with jira/ but no spec.md → auto-pick, recommend new."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        feature = root / "PROJ-42"
        (feature / "jira").mkdir(parents=True)
        (feature / "jira" / "ticket.json").write_text("{}")

        result = _run(str(root))
        assert result["status"] == "ok", result
        assert result["recommendation"] == "new"
        assert result["feature_id"] == "PROJ-42"
        assert result["spec_path"] is None
        assert result["next_stage_file"] == "01-target.md"


def test_existing_in_progress_spec_resumes():
    """spec.md in-progress with stepsCompleted=[1,2,3] → resume, next=04-web-research.md."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        feature = root / "PROJ-7"
        _make_spec(feature, status="in-progress", steps=[1, 2, 3], slug="PROJ-7")

        result = _run(str(root), "PROJ-7")
        assert result["status"] == "ok", result
        assert result["recommendation"] == "resume"
        assert result["feature_id"] == "PROJ-7"
        assert result["stepsCompleted"] == [1, 2, 3]
        assert result["next_stage_file"] == "04-web-research.md"
        assert result["spec_path"] is not None and result["spec_path"].endswith("spec.md")


def test_ready_for_build_recommends_restart():
    """status=ready-for-build → restart (user must explicitly opt in)."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        feature = root / "PROJ-9"
        _make_spec(feature, status="ready-for-build", steps=[1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

        result = _run(str(root), "PROJ-9")
        assert result["recommendation"] == "restart", result
        # Restart always re-enters at Stage 1.
        assert result["next_stage_file"] == "01-target.md"


def test_explicit_target_missing_recommends_new():
    """Caller asked for PROJ-99 but it isn't on disk → recommend new with that id."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        result = _run(str(root), "PROJ-99")
        assert result["status"] == "ok"
        assert result["recommendation"] == "new"
        assert result["feature_id"] == "PROJ-99"
        assert result["spec_path"] is None
        assert result["stepsCompleted"] == []


def test_multiple_jira_only_folders_are_ambiguous():
    """Two unsolved candidates and no target → unresolved with both listed."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for fid in ("PROJ-1", "PROJ-2"):
            (root / fid / "jira").mkdir(parents=True)
        result = _run(str(root))
        assert result["status"] == "unresolved"
        ids = sorted(c["feature_id"] for c in result["candidates"])
        assert ids == ["PROJ-1", "PROJ-2"], result


def test_malformed_frontmatter_does_not_crash():
    """Spec with no frontmatter at all → still classified as resume-from-zero, not a crash."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        feature = root / "PROJ-X"
        feature.mkdir(parents=True)
        (feature / "spec.md").write_text("# No frontmatter here\n")

        result = _run(str(root), "PROJ-X")
        # spec.md exists, so this is not "new"; frontmatter is empty → resume from Stage 1.
        assert result["recommendation"] == "resume", result
        assert result["next_stage_file"] == "01-target.md"
        assert result["stepsCompleted"] == []


def test_help_flag():
    """--help prints usage and exits 0."""
    result = subprocess.run(
        [sys.executable, str(DETECT_SCRIPT), "--help"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "feature_artifacts_root" in result.stdout
    assert "target" in result.stdout


def main() -> int:
    tests = [
        ("empty root is unresolved", test_empty_root_is_unresolved),
        ("single jira-only folder auto-detects", test_single_jira_only_folder_auto_detects),
        ("existing in-progress spec resumes", test_existing_in_progress_spec_resumes),
        ("ready-for-build recommends restart", test_ready_for_build_recommends_restart),
        ("explicit target missing recommends new", test_explicit_target_missing_recommends_new),
        ("multiple jira-only folders are ambiguous", test_multiple_jira_only_folders_are_ambiguous),
        ("malformed frontmatter does not crash", test_malformed_frontmatter_does_not_crash),
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
