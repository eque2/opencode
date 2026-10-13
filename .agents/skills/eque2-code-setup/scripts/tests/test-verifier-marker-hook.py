"""Tests for verifier-marker-hook.py — SubagentStart/Stop role-marker lifecycle
(verifier-only-minting, CAP-2). Runs the real script as a subprocess with
hook-shaped stdin JSON against a disposable store root."""

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "verifier-marker-hook.py"


def run_hook(action, agent_id, cwd, env=None):
    payload = {
        "session_id": "s1",
        "cwd": str(cwd),
        "agent_id": agent_id,
        "agent_type": "eque2-verifier",
        "hook_event_name": "SubagentStart" if action == "start" else "SubagentStop",
    }
    merged = {**os.environ, **(env or {})}
    return subprocess.run(
        [sys.executable, str(SCRIPT), action],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=30,
        env=merged,
        cwd=str(cwd),
    )


def marker_path(root):
    return Path(root) / ".eque2-tests" / "state" / ".verifier-marker.json"


def read_marker(root):
    return json.loads(marker_path(root).read_text())


def test_start_mints_marker_with_nonce_agentid_and_expiry(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    result = run_hook("start", "agent-A", tmp_path, env)
    assert result.returncode == 0
    marker = read_marker(tmp_path)
    assert marker["agentId"] == "agent-A"
    assert marker["agent"] == "eque2-verifier"
    assert len(marker["nonce"]) >= 32
    assert marker["expiresAt"] > marker["mintedAt"]


def test_start_writes_store_gitignore_for_marker_and_denial_log(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    run_hook("start", "agent-A", tmp_path, env)
    gitignore = (tmp_path / ".eque2-tests" / "state" / ".gitignore").read_text()
    assert ".verifier-marker.json" in gitignore
    assert "policy-denials.log" in gitignore


def test_paired_stop_revokes_marker(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    run_hook("start", "agent-A", tmp_path, env)
    assert marker_path(tmp_path).exists()
    result = run_hook("stop", "agent-A", tmp_path, env)
    assert result.returncode == 0
    assert not marker_path(tmp_path).exists()


def test_late_stop_does_not_delete_successor_marker(tmp_path):
    """Nonce-scoped deletion: a late-firing stop from verifier A must not
    delete verifier B's fresh marker."""
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    run_hook("start", "agent-A", tmp_path, env)
    nonce_a = read_marker(tmp_path)["nonce"]
    run_hook("start", "agent-B", tmp_path, env)  # successor replaces the marker
    nonce_b = read_marker(tmp_path)["nonce"]
    assert nonce_a != nonce_b

    result = run_hook("stop", "agent-A", tmp_path, env)  # late stop from A
    assert result.returncode == 0
    assert marker_path(tmp_path).exists(), "successor marker must survive a late stop"
    assert read_marker(tmp_path)["agentId"] == "agent-B"

    run_hook("stop", "agent-B", tmp_path, env)
    assert not marker_path(tmp_path).exists()


def test_stop_with_no_marker_is_a_quiet_noop(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    result = run_hook("stop", "agent-A", tmp_path, env)
    assert result.returncode == 0


def test_hook_never_crashes_on_garbage_stdin(tmp_path):
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "start"],
        input="not json at all",
        capture_output=True,
        text=True,
        timeout=30,
        env={**os.environ, "EQUE2_PROJECT_ROOT": str(tmp_path)},
        cwd=str(tmp_path),
    )
    assert result.returncode == 0  # never blocks the hook chain


def test_tests_db_path_override_is_respected(tmp_path):
    store = tmp_path / "custom-store"
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path), "TESTS_DB_PATH": str(store)}
    run_hook("start", "agent-A", tmp_path, env)
    assert (store / ".verifier-marker.json").exists()
