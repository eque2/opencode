#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Tests for install-github-review.py — installing the PR-review Actions.

Guards the one promise that matters: a re-run of setup updates files the user
never touched and never overwrites a file the user edited.

Run:  uv run pytest scripts/tests/test-install-github-review.py
"""

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parent.resolve().parent / "install-github-review.py"
ASSETS = SCRIPT.parent.parent / "assets" / "github"


def run(root: Path, source: Path) -> dict:
    out = subprocess.run([sys.executable, str(SCRIPT), "--project-root", str(root), "--source", str(source)],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_install_update_and_keep(tmp_path):
    src = tmp_path / "src"
    (src / "workflows").mkdir(parents=True)
    (src / "workflows/a.yml").write_text("v1")
    (src / "workflows/b.yml").write_text("v1")
    repo = tmp_path / "repo"
    repo.mkdir()

    assert run(repo, src)["installed"] == ["workflows/a.yml", "workflows/b.yml"]
    assert run(repo, src)["unchanged"] == ["workflows/a.yml", "workflows/b.yml"]

    # New release ships v2; the user edited b.yml in the meantime.
    (src / "workflows/a.yml").write_text("v2")
    (src / "workflows/b.yml").write_text("v2")
    (repo / ".github/workflows/b.yml").write_text("mine")
    result = run(repo, src)
    assert result["updated"] == ["workflows/a.yml"]
    assert result["kept"] == ["workflows/b.yml"]
    assert (repo / ".github/workflows/a.yml").read_text() == "v2"
    assert (repo / ".github/workflows/b.yml").read_text() == "mine"

    # Still kept on the next run — the user's edit is never adopted as "ours".
    assert run(repo, src)["kept"] == ["workflows/b.yml"]


def test_shipped_assets_install_with_exec_bit_and_new_rules_path(tmp_path):
    result = run(tmp_path, ASSETS)
    assert "workflows/pr-review.yml" in result["installed"]
    assert os.access(tmp_path / ".github/scripts/fetch-jira-tickets.sh", os.X_OK)
    review = (tmp_path / ".github/workflows/code-review.yml").read_text()
    assert ".github/review-rules" in review and ".ai/" not in review and "NPM_AUTH_TOKEN" not in review
