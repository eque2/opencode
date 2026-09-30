"""Tests for mint-guard-hook.py — the PreToolUse mint-verb guard
(verifier-only-minting, CAP-1). Session mode = marker-aware orchestrator
friction; builder mode = unconditional deny. Deny text must carry both
clauses and name CMC-32874; denials append to the policy denial log."""

import datetime
import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "mint-guard-hook.py"


def run_guard(mode, command, cwd, env=None, tool_name="Bash"):
    payload = {
        "session_id": "s1",
        "cwd": str(cwd),
        "hook_event_name": "PreToolUse",
        "tool_name": tool_name,
        "tool_input": {"command": command},
    }
    merged = {**os.environ, **(env or {})}
    return subprocess.run(
        [sys.executable, str(SCRIPT), f"--mode={mode}"],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=30,
        env=merged,
        cwd=str(cwd),
    )


def write_live_marker(root, nonce="live-nonce"):
    store = Path(root) / ".eque2-tests" / "state"
    store.mkdir(parents=True, exist_ok=True)
    expires = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=30)).isoformat()
    (store / ".verifier-marker.json").write_text(
        json.dumps({"nonce": nonce, "agent": "eque2-verifier", "expiresAt": expires})
    )
    return store


MINT_COMMANDS = [
    "node .claude/skills/eque2-code-setup/scripts/tests-cli.mjs verdict --verdict=pass --testId=X --reason=probe",
    "node scripts/tests-cli.mjs force-reset --testId=X --confirm=true",
    "npx tsx src/eque2-code/scripts/tests-cli.ts verification-reset --confirm=true",
    "node tests-cli.mjs retract --testId=X --reason=oops",
]


def test_session_mode_denies_all_mint_verbs_without_marker(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    for cmd in MINT_COMMANDS:
        result = run_guard("session", cmd, tmp_path, env)
        assert result.returncode == 2, f"should deny: {cmd}"
        assert "Clause A" in result.stderr
        assert "Clause B" in result.stderr
        assert "CMC-32874" in result.stderr


def test_builder_mode_denies_even_with_live_marker(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    write_live_marker(tmp_path)
    for cmd in MINT_COMMANDS:
        result = run_guard("builder", cmd, tmp_path, env)
        assert result.returncode == 2, f"builder must never mint: {cmd}"
        assert "BUILD_COMPLETE" in result.stderr


def test_session_mode_allows_when_marker_is_live(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    write_live_marker(tmp_path)
    result = run_guard("session", MINT_COMMANDS[0], tmp_path, env)
    assert result.returncode == 0


def test_session_mode_denies_on_expired_marker(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    store = tmp_path / ".eque2-tests" / "state"
    store.mkdir(parents=True)
    past = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=5)).isoformat()
    (store / ".verifier-marker.json").write_text(
        json.dumps({"nonce": "n", "agent": "eque2-verifier", "expiresAt": past})
    )
    result = run_guard("session", MINT_COMMANDS[0], tmp_path, env)
    assert result.returncode == 2


def test_help_only_invocation_passes_both_modes(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    for mode in ("session", "builder"):
        result = run_guard(mode, "node scripts/tests-cli.mjs verdict --help", tmp_path, env)
        assert result.returncode == 0, f"--help must pass in {mode} mode"


def test_sanctioned_admin_command_passes_session_mode_only(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    cmd = "EQUE2_TESTS_ADMIN=1 node scripts/tests-cli.mjs retract --testId=X --reason=fix"
    assert run_guard("session", cmd, tmp_path, env).returncode == 0
    assert run_guard("builder", cmd, tmp_path, env).returncode == 2


def test_non_mint_commands_pass(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    for cmd in (
        "node scripts/tests-cli.mjs summary",
        "node scripts/tests-cli.mjs update --testId=X --event=BUILD_COMPLETE",
        "git verdict-unrelated status",  # mint word without tests-cli
        "echo verdict",
    ):
        for mode in ("session", "builder"):
            assert run_guard(mode, cmd, tmp_path, env).returncode == 0, f"{mode} should allow: {cmd}"


def test_non_bash_tools_pass(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    result = run_guard("builder", MINT_COMMANDS[0], tmp_path, env, tool_name="Read")
    assert result.returncode == 0


def test_denials_append_to_policy_denial_log(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    run_guard("session", MINT_COMMANDS[0], tmp_path, env)
    run_guard("builder", MINT_COMMANDS[1], tmp_path, env)
    log = (tmp_path / ".eque2-tests" / "state" / "policy-denials.log").read_text()
    lines = [l for l in log.strip().split("\n") if l]
    assert len(lines) == 2
    assert "hook-deny:session" in lines[0] and "verdict" in lines[0]
    assert "hook-deny:builder" in lines[1] and "force-reset" in lines[1]


def test_mint_word_in_reason_of_non_mint_command_passes(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    cmd = "node scripts/tests-cli.mjs update --testId=X --event=BUILD_COMPLETE --reason='verdict pending retract'"
    for mode in ("session", "builder"):
        assert run_guard(mode, cmd, tmp_path, env).returncode == 0


def test_help_substring_inside_argument_does_not_bypass(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    cmd = "node scripts/tests-cli.mjs verdict --verdict=pass --testId=X --reason='see --help.'"
    assert run_guard("session", cmd, tmp_path, env).returncode == 2


def test_admin_substring_inside_argument_does_not_bypass(tmp_path, monkeypatch):
    monkeypatch.delenv("EQUE2_TESTS_ADMIN", raising=False)
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path)}
    cmd = "node scripts/tests-cli.mjs verdict --verdict=pass --testId=X --reason='EQUE2_TESTS_ADMIN=1'"
    assert run_guard("session", cmd, tmp_path, env).returncode == 2


def test_exported_admin_env_passes_session_mode(tmp_path):
    env = {"EQUE2_PROJECT_ROOT": str(tmp_path), "EQUE2_TESTS_ADMIN": "1"}
    cmd = "node scripts/tests-cli.mjs retract --testId=X --reason=fix"
    assert run_guard("session", cmd, tmp_path, env).returncode == 0


def test_non_dict_json_stdin_passes(tmp_path):
    for weird in ("[]", '"x"', "42"):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--mode=builder"],
            input=weird,
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "EQUE2_PROJECT_ROOT": str(tmp_path)},
            cwd=str(tmp_path),
        )
        assert result.returncode == 0, f"stdin {weird!r} must never crash the hook"


def test_garbage_stdin_passes(tmp_path):
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--mode=session"],
        input="{{{",
        capture_output=True,
        text=True,
        timeout=30,
        env={**os.environ, "EQUE2_PROJECT_ROOT": str(tmp_path)},
        cwd=str(tmp_path),
    )
    assert result.returncode == 0
