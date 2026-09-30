#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Smoke tests for init-sanctum.py.

Covers:
- Fresh scaffold: produces all 7 sanctum files (INDEX/PERSONA/CREED/BOND/MEMORY/PULSE + CAPABILITIES)
- Detect-and-skip: re-running on an existing sanctum returns status=skipped without mutation
- Variable substitution: {user_name} placeholders get replaced from config
- CAPABILITIES.md generation: only non-hidden capabilities appear

Run:
    uv run ./scripts/tests/test-init-sanctum.py
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent.resolve()
INIT_SCRIPT = SCRIPT_DIR.parent / "init-sanctum.py"
SKILL_ROOT = SCRIPT_DIR.parent.parent  # _bmad-output/eque2-code-agent-linus/


def _make_minimal_skill(skill_dest: Path) -> None:
    """Build a minimal skill structure sufficient for the init script to run."""
    (skill_dest / "assets").mkdir(parents=True, exist_ok=True)
    (skill_dest / "references").mkdir(parents=True, exist_ok=True)

    # Minimal templates — one per sanctum file
    templates = {
        "INDEX-template.md": "---\nbirth_status: incomplete\nbirth_date: {birth_date}\nbirth_started_at: {birth_date}\n---\n# Index\nFor {user_name}.\n",
        "PERSONA-template.md": "# Persona\nBorn {birth_date} for {user_name}.\n",
        "CREED-template.md": "# Creed\nServing {user_name}.\n",
        "BOND-template.md": "# Bond\n- Name: {user_name}\n- Language: {communication_language}\n",
        "MEMORY-template.md": "# Memory\nEmpty at birth.\n",
        "PULSE-template.md": "# Pulse\nOn-demand.\n",
    }
    for name, content in templates.items():
        (skill_dest / "assets" / name).write_text(content)

    # One reference file to verify copying
    (skill_dest / "references" / "memory-guidance.md").write_text("# Memory Guidance\n")
    # One skill-only file to verify it's NOT copied
    (skill_dest / "references" / "first-breath.md").write_text("# First Breath\n")

    # Manifest with one visible + one hidden capability
    manifest = {
        "module-code": "test",
        "capabilities": [
            {
                "name": "test-visible",
                "menu-code": "TV",
                "description": "Visible test capability.",
                "workflow-path": "workflows/test-visible/SKILL.md",
            },
            {
                "name": "test-hidden",
                "menu-code": "TH",
                "description": "Hidden test capability.",
                "workflow-path": "workflows/test-hidden/SKILL.md",
                "hidden": True,
            },
        ],
    }
    (skill_dest / "bmad-manifest.json").write_text(json.dumps(manifest))


def _make_project(project_dest: Path, user_name: str = "TestUser") -> None:
    """Build a minimal project structure with _bmad/config.yaml."""
    bmad = project_dest / "_bmad"
    bmad.mkdir(parents=True, exist_ok=True)
    (bmad / "config.yaml").write_text(
        f"user_name: {user_name}\ncommunication_language: English\n"
    )


def _run_init(project_root: Path, skill_path: Path) -> dict:
    """Invoke init-sanctum.py and return parsed JSON result."""
    result = subprocess.run(
        [sys.executable, str(INIT_SCRIPT), str(project_root), str(skill_path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def test_fresh_scaffold():
    """Fresh scaffold writes all sanctum files and copies references."""
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp) / "project"
        skill = Path(tmp) / "skill"
        _make_project(project, user_name="Alice")
        _make_minimal_skill(skill)

        result = _run_init(project, skill)

        assert result["status"] == "ok", f"Expected ok, got {result}"
        sanctum = project / "_bmad" / "_memory" / "linus-sidecar"
        assert sanctum.exists(), "sanctum dir should exist"

        # All 6 templates + auto-generated CAPABILITIES.md
        for f in ["INDEX.md", "PERSONA.md", "CREED.md", "BOND.md", "MEMORY.md", "PULSE.md", "CAPABILITIES.md"]:
            assert (sanctum / f).exists(), f"missing {f}"

        # References copied, first-breath.md excluded
        assert (sanctum / "references" / "memory-guidance.md").exists()
        assert not (sanctum / "references" / "first-breath.md").exists(), "first-breath.md should not be copied"

        # Variable substitution worked
        bond_content = (sanctum / "BOND.md").read_text()
        assert "Alice" in bond_content, "user_name should be substituted into BOND"


def test_detect_and_skip():
    """Re-running on an existing sanctum returns skipped without mutation."""
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp) / "project"
        skill = Path(tmp) / "skill"
        _make_project(project)
        _make_minimal_skill(skill)

        # First run — fresh
        first = _run_init(project, skill)
        assert first["status"] == "ok"

        # Mutate the sanctum to prove second run doesn't overwrite
        sanctum = project / "_bmad" / "_memory" / "linus-sidecar"
        (sanctum / "BOND.md").write_text("HAND-EDITED")

        # Second run — should skip
        second = _run_init(project, skill)
        assert second["status"] == "skipped", f"Expected skipped, got {second}"
        assert (sanctum / "BOND.md").read_text() == "HAND-EDITED", "existing files should not be overwritten"


def test_capabilities_md_excludes_hidden():
    """CAPABILITIES.md should include visible capabilities and exclude hidden ones."""
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp) / "project"
        skill = Path(tmp) / "skill"
        _make_project(project)
        _make_minimal_skill(skill)

        _run_init(project, skill)

        caps = (project / "_bmad" / "_memory" / "linus-sidecar" / "CAPABILITIES.md").read_text()
        assert "[TV]" in caps, "visible capability should appear"
        assert "test-visible" in caps
        assert "[TH]" not in caps, "hidden capability should NOT appear"
        assert "test-hidden" not in caps


def test_refresh_capabilities():
    """--refresh-capabilities regenerates only CAPABILITIES.md on an existing sanctum."""
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp) / "project"
        skill = Path(tmp) / "skill"
        _make_project(project)
        _make_minimal_skill(skill)
        _run_init(project, skill)

        sanctum = project / "_bmad" / "_memory" / "linus-sidecar"
        (sanctum / "BOND.md").write_text("HAND-EDITED")
        (sanctum / "CAPABILITIES.md").write_text("STALE")

        result = subprocess.run(
            [sys.executable, str(INIT_SCRIPT), str(project), str(skill), "--refresh-capabilities"],
            capture_output=True, text=True, check=True,
        )
        out = json.loads(result.stdout)
        assert out["status"] == "refreshed", out
        # CAPABILITIES.md regenerated, other sanctum files untouched
        assert "[TV]" in (sanctum / "CAPABILITIES.md").read_text()
        assert (sanctum / "BOND.md").read_text() == "HAND-EDITED", "refresh must not touch BOND"


def test_bootstrap():
    """--bootstrap scaffolds and marks birth_status complete with bootstrapped flag."""
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp) / "project"
        skill = Path(tmp) / "skill"
        _make_project(project)
        _make_minimal_skill(skill)

        result = subprocess.run(
            [sys.executable, str(INIT_SCRIPT), str(project), str(skill), "--bootstrap"],
            capture_output=True, text=True, check=True,
        )
        out = json.loads(result.stdout)
        assert out["status"] == "ok" and out["bootstrapped"] is True, out
        index = (project / "_bmad" / "_memory" / "linus-sidecar" / "INDEX.md").read_text()
        assert "birth_status: complete" in index, "bootstrap should flip birth_status"
        assert "bootstrapped: true" in index, "bootstrap should record the breadcrumb"


def test_help_flag():
    """--help should print usage and exit 0."""
    result = subprocess.run(
        [sys.executable, str(INIT_SCRIPT), "--help"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "project_root" in result.stdout
    assert "skill_path" in result.stdout


def main() -> int:
    tests = [
        ("fresh scaffold", test_fresh_scaffold),
        ("detect and skip", test_detect_and_skip),
        ("CAPABILITIES.md excludes hidden", test_capabilities_md_excludes_hidden),
        ("refresh-capabilities", test_refresh_capabilities),
        ("bootstrap", test_bootstrap),
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
