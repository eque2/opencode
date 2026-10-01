"""Preflight cells for the verifier-only-minting gates (S10): claude-code
old / claude-code new / no `claude` binary, plus marker gitignore health.
Imports the hyphenated script via importlib (suite convention)."""

import importlib.util
import json
import os
import stat
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "preflight-check.py"
spec = importlib.util.spec_from_file_location("preflight_check", SCRIPT)
preflight = importlib.util.module_from_spec(spec)
sys.modules["preflight_check"] = preflight
spec.loader.exec_module(preflight)


def fake_claude(tmp_path, version_line):
    """Put a fake `claude` executable on PATH printing the given version."""
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    exe = bindir / "claude"
    exe.write_text(f"#!/bin/sh\necho '{version_line}'\n")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return str(bindir)


def with_path(monkeypatch, path_value):
    monkeypatch.setenv("PATH", path_value)


def test_new_claude_code_passes_named(tmp_path, monkeypatch):
    with_path(monkeypatch, fake_claude(tmp_path, "2.1.211 (Claude Code)") + os.pathsep + "/usr/bin" + os.pathsep + "/bin")
    check = preflight.check_claude_code_version()
    assert check["passed"] is True
    assert check["severity"] == "blocker"
    assert "2.1.211" in check["detail"]


def test_old_claude_code_is_a_named_blocker(tmp_path, monkeypatch):
    with_path(monkeypatch, fake_claude(tmp_path, "2.0.76 (Claude Code)") + os.pathsep + "/usr/bin" + os.pathsep + "/bin")
    check = preflight.check_claude_code_version()
    assert check["passed"] is False
    assert check["severity"] == "blocker"
    assert "2.1.195" in check["detail"]
    assert "SubagentStart" in check["detail"]


def test_no_claude_binary_is_an_informational_skip_naming_the_runner(tmp_path, monkeypatch):
    empty = tmp_path / "emptybin"
    empty.mkdir()
    with_path(monkeypatch, str(empty))
    check = preflight.check_claude_code_version()
    assert check["passed"] is True  # never a hard fail on Codex/no-claude installs
    assert check.get("skipped") is True
    assert "verification-runner.py" in check["detail"]


def test_marker_gitignore_passes_when_store_absent(tmp_path):
    check = preflight.check_marker_gitignore(tmp_path)
    assert check["passed"] is True


def test_marker_gitignore_warns_when_entries_missing(tmp_path):
    store = tmp_path / ".eque2-tests" / "state"
    store.mkdir(parents=True)
    (store / ".gitignore").write_text("something-else\n")
    check = preflight.check_marker_gitignore(tmp_path)
    assert check["passed"] is False
    assert ".verifier-marker.json" in check["detail"]


def test_marker_gitignore_passes_when_healthy(tmp_path):
    store = tmp_path / ".eque2-tests" / "state"
    store.mkdir(parents=True)
    (store / ".gitignore").write_text(".verifier-marker.json\npolicy-denials.log\n")
    check = preflight.check_marker_gitignore(tmp_path)
    assert check["passed"] is True


def test_checks_appear_in_full_run(tmp_path, monkeypatch):
    with_path(monkeypatch, fake_claude(tmp_path, "2.1.211 (Claude Code)") + os.pathsep + "/usr/bin" + os.pathsep + "/bin")
    result = preflight.run_all_checks(
        tmp_path,
        preflight.DEFAULT_CODING_STANDARDS_GLOB,
        preflight.DEFAULT_REVIEW_RULES_GLOB,
        preflight.DEFAULT_PROJECT_DOCS_GLOB,
    )
    names = [c["name"] for c in result["checks"]]
    assert "claude_code_version" in names
    assert "marker_gitignore" in names
    assert json.dumps(result)  # envelope stays JSON-serialisable
