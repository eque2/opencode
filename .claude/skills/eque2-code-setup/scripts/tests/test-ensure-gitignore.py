#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Tests for ensure-gitignore.py — the managed .gitignore block.

Guards the SKILL.md ↔ IGNORE_ENTRIES parity that the v0.45.0 `.signer-key`
omission slipped through: every personal/runtime artifact SKILL.md names as
"must be ignored" is asserted via a real `git check-ignore`, and the shared
committed keyring is asserted NOT ignored.

Run:  uv run pytest scripts/tests/test-ensure-gitignore.py
"""

import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
GITIGNORE_SCRIPT = SCRIPT_DIR.parent / "ensure-gitignore.py"

# The personal/runtime class SKILL.md ("Ensure .gitignore Entries") requires.
MUST_IGNORE = [
    "_bmad/config.user.yaml",
    ".state-events.jsonl",
    "_bmad-output/features/spec-x/.signer-key",  # per-spec, any depth
    "_bmad-output/features/spec-x/.evidence-key",
    ".signer-key",
    ".evidence-key",
    ".codex/hooks.json",
]

# The shared class — committed by design, must NEVER be ignored by our block.
MUST_NOT_IGNORE = [
    "state/integrity-key.json",
    "_bmad/config.yaml",
]


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args],
                          capture_output=True, text=True)


def _fixture(tmp_path):
    _git(tmp_path, "init", "-q")
    r = subprocess.run([sys.executable, str(GITIGNORE_SCRIPT),
                        "--gitignore", str(tmp_path / ".gitignore")],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return tmp_path


def test_personal_runtime_artifacts_are_ignored(tmp_path):
    repo = _fixture(tmp_path)
    for path in MUST_IGNORE:
        r = _git(repo, "check-ignore", "-q", path)
        assert r.returncode == 0, f"{path} is NOT ignored by the managed block"


def test_shared_artifacts_are_not_ignored(tmp_path):
    repo = _fixture(tmp_path)
    for path in MUST_NOT_IGNORE:
        r = _git(repo, "check-ignore", "-q", path)
        assert r.returncode != 0, f"{path} IS ignored — shared artifacts must be committed"


def test_idempotent_rewrite(tmp_path):
    repo = _fixture(tmp_path)
    gitignore = repo / ".gitignore"
    before = gitignore.read_text()
    r = subprocess.run([sys.executable, str(GITIGNORE_SCRIPT),
                        "--gitignore", str(repo / ".gitignore")],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert gitignore.read_text() == before, "second run must rewrite block in place, not duplicate"
