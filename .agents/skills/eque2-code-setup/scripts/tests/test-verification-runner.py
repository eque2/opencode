"""Tests for verification-runner.py — the sanctioned hookless marker path
(verifier-only-minting, S9)."""

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "verification-runner.py"


def run_runner(cmd, cwd, env=None):
    merged = {**os.environ, **(env or {})}
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--", *cmd],
        capture_output=True,
        text=True,
        timeout=60,
        env=merged,
        cwd=str(cwd),
    )


def marker_path(root):
    return Path(root) / ".eque2-tests" / "state" / ".verifier-marker.json"


def test_marker_exists_during_wrapped_command_and_is_revoked_after(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    probe = (
        "import json,sys;"
        f"m=json.load(open(r'{marker_path(tmp_path)}'));"
        "print(m['nonce']); sys.exit(0)"
    )
    result = run_runner([sys.executable, "-c", probe], tmp_path, env)
    assert result.returncode == 0, result.stderr
    assert len(result.stdout.strip()) >= 32  # a real nonce was live during the run
    assert not marker_path(tmp_path).exists()  # revoked after


def test_wrapped_exit_code_propagates_and_marker_still_revoked(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    result = run_runner([sys.executable, "-c", "import sys; sys.exit(7)"], tmp_path, env)
    assert result.returncode == 7
    assert not marker_path(tmp_path).exists()


def test_scoped_revoke_leaves_a_successor_marker(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    replace = (
        "import json;"
        f"p=r'{marker_path(tmp_path)}';"
        "json.dump({'nonce':'successor','agentId':'someone-else','agent':'eque2-verifier',"
        "'expiresAt':'2099-01-01T00:00:00Z'}, open(p,'w'))"
    )
    result = run_runner([sys.executable, "-c", replace], tmp_path, env)
    assert result.returncode == 0
    assert marker_path(tmp_path).exists(), "a marker the runner did not mint must survive"
    assert json.loads(marker_path(tmp_path).read_text())["agentId"] == "someone-else"


def test_no_command_is_a_usage_error(tmp_path):
    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        capture_output=True, text=True, timeout=30,
        env={**os.environ, "EQUE2_PROJECT_ROOT": str(tmp_path)},
        cwd=str(tmp_path),
    )
    assert result.returncode == 2
    assert "usage" in result.stderr
