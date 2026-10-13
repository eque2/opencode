#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Tests for cleanup-legacy.py — the legacy-directory removal step.

Covers (spec bmad-help-catalog-gap, CAP-1/CAP-4):
- A populated _bmad/_config/bmad-help.csv survives cleanup content-identical
  (it is NOT in the remove list) while the module dir + core are removed.
- directories_removed does not list _config; module dir + core present.
- Cleanup is idempotent (second run on a cleaned tree exits 0, removes nothing).
- The SKILL.md cleanup invocation does NOT pass `--also-remove _config`
  (binds CAP-1 to the install step — re-adding the wipe fails this test).

Run:  uv run pytest scripts/tests/test-cleanup-legacy.py
"""

import csv
import json
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
CLEANUP_SCRIPT = SCRIPT_DIR.parent / "cleanup-legacy.py"
SKILL_MD = SCRIPT_DIR.parent.parent / "SKILL.md"


def _run(*args):
    r = subprocess.run([sys.executable, str(CLEANUP_SCRIPT), *map(str, args)],
                       capture_output=True, text=True)
    return r


def _fixture(tmp_path):
    """A _bmad/ with a populated _config catalog, a module dir, and core."""
    bmad = tmp_path / "_bmad"
    (bmad / "_config").mkdir(parents=True)
    catalog = bmad / "_config" / "bmad-help.csv"
    with open(catalog, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["module", "skill", "preceded-by", "followed-by"])
        w.writerow(["bmm", "bmm-plan", "", ""])
    (bmad / "eque2-code").mkdir()
    (bmad / "eque2-code" / "leftover.txt").write_text("junk")
    (bmad / "core").mkdir()
    (bmad / "core" / "leftover.txt").write_text("junk")
    skills = tmp_path / ".claude" / "skills"
    skills.mkdir(parents=True)
    return bmad, catalog, skills


def test_cleanup_preserves_config_and_removes_module_and_core(tmp_path):
    bmad, catalog, skills = _fixture(tmp_path)
    before = catalog.read_bytes()

    # Same invocation SKILL.md uses: module-code + skills-dir, NO --also-remove _config.
    r = _run("--bmad-dir", bmad, "--module-code", "eque2-code", "--skills-dir", skills)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)

    assert "_config" not in out["directories_removed"]
    assert set(out["directories_removed"]) == {"eque2-code", "core"}
    assert catalog.exists() and catalog.read_bytes() == before, "_config catalog must survive byte-identical"
    assert not (bmad / "eque2-code").exists()
    assert not (bmad / "core").exists()


def test_cleanup_idempotent(tmp_path):
    bmad, catalog, skills = _fixture(tmp_path)
    _run("--bmad-dir", bmad, "--module-code", "eque2-code", "--skills-dir", skills)
    r2 = _run("--bmad-dir", bmad, "--module-code", "eque2-code", "--skills-dir", skills)
    assert r2.returncode == 0, r2.stderr
    out = json.loads(r2.stdout)
    assert out["directories_removed"] == []
    assert catalog.exists(), "_config still present after a second run"


def test_skill_md_cleanup_invocation_omits_config_wipe():
    text = SKILL_MD.read_text()
    cleanup_lines = [ln for ln in text.splitlines() if "cleanup-legacy.py" in ln and "--bmad-dir" in ln]
    assert cleanup_lines, "expected a cleanup-legacy.py invocation in SKILL.md"
    for ln in cleanup_lines:
        assert "--also-remove _config" not in ln, \
            "SKILL.md must not wipe _config — it holds the bmad-help catalog"


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-q"]))
