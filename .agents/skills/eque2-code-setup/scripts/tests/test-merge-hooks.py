"""Tests for merge-hooks.py — idempotent hooks-block merge into
.claude/settings.json (verifier-only-minting, CAP-8)."""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "merge-hooks.py"
spec = importlib.util.spec_from_file_location("merge_hooks", SCRIPT)
merge_hooks = importlib.util.module_from_spec(spec)
sys.modules["merge_hooks"] = merge_hooks
spec.loader.exec_module(merge_hooks)


def read(path):
    return json.loads(path.read_text())


def place_gate(root, relative=".claude/skills/eque2-code-goal-gate/goal-gate-stop.sh",
               executable=True):
    """Put a goal-gate-stop.sh where the resolver should find it.

    Executable by default because the shipped file is 0755 and the registration
    is a bare path the host executes directly. `executable=False` reproduces a
    copy that lost its mode bit — see the non-executable test below.
    """
    gate = root / relative
    gate.parent.mkdir(parents=True, exist_ok=True)
    gate.write_text("#!/usr/bin/env bash\nexit 0\n")
    gate.chmod(0o755 if executable else 0o644)
    return gate


def place_proof(gate):
    proof = gate.parent / "proof-of-fire.sh"
    proof.write_text(
        (SCRIPT.parents[2] / "eque2-code-goal-gate" / "proof-of-fire.sh").read_text()
    )
    for name in merge_hooks.GATE_REQUIRED_FILES:
        helper = gate.parent / name
        if not helper.exists():
            helper.write_text("#!/usr/bin/env bash\nexit 0\n")
        helper.chmod(0o755)
    return proof


def place_legacy_gate(root):
    gate = root / "goal-gate-runtime" / "gate" / "goal-gate-stop.sh"
    gate.parent.mkdir(parents=True, exist_ok=True)
    gate.write_text("#!/usr/bin/env bash\nexit 0\n")
    gate.chmod(0o755)
    (gate.parent / ".placed-from").write_text("eque2-code-goal-gate\n")
    return gate


def test_gate_not_found_is_not_registered(tmp_path):
    """A Stop hook whose command does not exist FAILS OPEN — the host reports a
    non-blocking error, the turn ends, and nothing is gated. Not registering is
    strictly safer: pursue-goal then refuses to bind, which is fail-closed."""
    settings = tmp_path / ".claude" / "settings.json"
    result = merge_hooks.merge(settings)
    assert result["goal_gate"] == "skipped-not-found"
    assert result["goal_gate_command"] is None
    assert result["hooks_added"] == 3
    assert "Stop" not in read(settings).get("hooks", {})


def test_stale_gate_registration_is_pruned(tmp_path):
    """The field failure: a previous install left a registration pointing at a
    path that no longer exists, so every turn end errored. Leaving it in place
    would preserve exactly the fail-open this check exists to close."""
    settings = tmp_path / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({"hooks": {"Stop": [{"matcher": "*", "hooks": [
        {"type": "command",
         "command": "$CLAUDE_PROJECT_DIR/.claude/skills/eque2-code-goal-gate/goal-gate-stop.sh"}
    ]}]}}))
    result = merge_hooks.merge(settings)
    assert result["goal_gate"] == "pruned-not-found"
    assert result["goal_gate_pruned"] == 1
    assert "Stop" not in read(settings).get("hooks", {})


def test_non_executable_gate_is_not_registered(tmp_path):
    """A gate that is PRESENT but not executable is the same fail-open as an
    absent one, and harder to see: the host reports a non-blocking hook error at
    every turn end, the turn ends, nothing is gated, and the registration looks
    correct in settings.json. Registering it would be worse than not registering,
    because pursue-goal's own refusal — the fail-closed backstop — never fires."""
    place_gate(tmp_path, executable=False)
    settings = tmp_path / ".claude" / "settings.json"
    result = merge_hooks.merge(settings)
    assert result["goal_gate_command"] is None
    assert result["goal_gate"] == "skipped-not-found"
    assert "Stop" not in read(settings).get("hooks", {})


def test_a_non_executable_gate_prunes_a_previous_registration(tmp_path):
    """Losing the mode bit on an upgrade must clear the old registration, not
    leave one that now errors every turn."""
    place_gate(tmp_path, executable=False)
    settings = tmp_path / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text(json.dumps({"hooks": {"Stop": [{"matcher": "*", "hooks": [
        {"type": "command",
         "command": "$CLAUDE_PROJECT_DIR/.claude/skills/eque2-code-goal-gate/goal-gate-stop.sh"}
    ]}]}}))
    result = merge_hooks.merge(settings)
    assert result["goal_gate"] == "pruned-not-found"
    assert result["goal_gate_pruned"] == 1


def test_gate_registration_pins_the_hosts_timeout(tmp_path):
    """The gate enforces a 120s decision budget and its own comments cite the
    registration as where that number comes from. The host default is 600s, so
    without this the tighter budget is a fiction and a decision the host is still
    waiting on can be cut short only by the gate itself."""
    place_gate(tmp_path)
    settings = tmp_path / ".claude" / "settings.json"
    merge_hooks.merge(settings)
    entry = read(settings)["hooks"]["Stop"][0]["hooks"][0]
    assert entry["timeout"] == 120


def test_unprefixed_source_layout_is_found(tmp_path):
    """jam-flow and any checkout of it carry `goal-gate/`, not
    `eque2-code-goal-gate/`. Registering the canonical name there is what
    produced the field failure."""
    place_gate(tmp_path, ".claude/skills/goal-gate/goal-gate-stop.sh")
    settings = tmp_path / ".claude" / "settings.json"
    result = merge_hooks.merge(settings)
    assert result["goal_gate"] == "registered"
    assert result["goal_gate_command"] == \
        '"$CLAUDE_PROJECT_DIR/.claude/skills/goal-gate/goal-gate-stop.sh"'


def test_codex_skills_root_is_found(tmp_path):
    place_gate(tmp_path, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh")
    settings = tmp_path / ".claude" / "settings.json"
    result = merge_hooks.merge(settings)
    assert result["goal_gate_command"] == \
        '"$CLAUDE_PROJECT_DIR/.agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"'


def test_codex_project_mode_writes_only_the_portable_stop_hook(tmp_path):
    """A project registration is visible to every Codex harness that opens the
    repository. It must not install Claude-only verifier and subagent hooks."""
    gate = place_gate(
        tmp_path, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    hooks_file = tmp_path / ".codex" / "hooks.json"

    result = merge_hooks.merge(hooks_file, runtime="codex")

    cfg = read(hooks_file)
    assert set(cfg["hooks"]) == {"Stop"}
    command = cfg["hooks"]["Stop"][0]["hooks"][0]["command"]
    assert command == str(gate.resolve())
    assert result["goal_gate_command"] == command


def test_codex_project_mode_preserves_unrelated_hooks_and_is_idempotent(tmp_path):
    place_gate(tmp_path, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh")
    hooks_file = tmp_path / ".codex" / "hooks.json"
    hooks_file.parent.mkdir(parents=True)
    hooks_file.write_text(json.dumps({
        "hooks": {
            "Stop": [{"matcher": "*", "hooks": [
                {"type": "command", "command": "/opt/other-stop.sh"}
            ]}],
            "SessionStart": [{"hooks": [
                {"type": "command", "command": "/opt/session-start.sh"}
            ]}],
        }
    }))

    merge_hooks.merge(hooks_file, runtime="codex")
    after_first = read(hooks_file)
    merge_hooks.merge(hooks_file, runtime="codex")

    assert read(hooks_file) == after_first
    stop_commands = [
        hook["command"]
        for group in after_first["hooks"]["Stop"]
        for hook in group["hooks"]
    ]
    assert "/opt/other-stop.sh" in stop_commands
    assert sum("goal-gate-stop.sh" in command for command in stop_commands) == 1
    assert after_first["hooks"]["SessionStart"][0]["hooks"][0]["command"] == \
        "/opt/session-start.sh"


def test_codex_project_mode_quotes_a_gate_path_with_spaces(tmp_path):
    spaced_root = tmp_path / "project with spaces"
    gate = place_gate(
        spaced_root, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    hooks_file = spaced_root / ".codex" / "hooks.json"

    merge_hooks.merge(hooks_file, runtime="codex")

    command = read(hooks_file)["hooks"]["Stop"][0]["hooks"][0]["command"]
    assert command == f"'{gate.resolve()}'"


def test_codex_project_mode_quotes_a_gate_path_with_an_apostrophe(tmp_path):
    quoted_root = tmp_path / "project's files"
    gate = place_gate(
        quoted_root, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    hooks_file = quoted_root / ".codex" / "hooks.json"

    merge_hooks.merge(hooks_file, runtime="codex")

    command = read(hooks_file)["hooks"]["Stop"][0]["hooks"][0]["command"]
    assert command == merge_hooks.shlex.quote(str(gate.resolve()))


def test_codex_project_mode_refuses_malformed_json_without_changing_it(tmp_path):
    place_gate(tmp_path, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh")
    hooks_file = tmp_path / ".codex" / "hooks.json"
    hooks_file.parent.mkdir(parents=True)
    original = '{"hooks": {"Stop": ['
    hooks_file.write_text(original)

    with pytest.raises(ValueError, match="refusing to overwrite malformed JSON"):
        merge_hooks.merge(hooks_file, runtime="codex")

    assert hooks_file.read_text() == original


def test_codex_cli_returns_a_failed_audit_for_malformed_project_json(tmp_path):
    project = tmp_path / "project"
    gate = place_gate(
        project, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    place_proof(gate)
    hooks_file = project / ".codex" / "hooks.json"
    hooks_file.parent.mkdir(parents=True)
    original = '{"hooks":{"Stop":['
    hooks_file.write_text(original)
    env = dict(
        os.environ,
        HOME=str(tmp_path / "home"),
        CODEX_HOME=str(tmp_path / "codex-home"),
    )

    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--runtime", "codex", str(hooks_file)],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )

    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert payload["hook_audit"]["status"] == "failed"
    assert payload["hook_audit"]["checked_sources"] == [str(hooks_file.resolve())]
    assert "malformed JSON" in payload["hook_audit"]["problems"][0]
    assert hooks_file.read_text() == original


@pytest.mark.parametrize(
    "invalid_hooks",
    [
        {"Stop": {}},
        {"Stop": ["bad-group"]},
        {"Stop": [{"matcher": 3, "hooks": []}]},
        {"Stop": [{"matcher": "*", "hooks": {}}]},
        {"Stop": [{"matcher": "*", "hooks": ["bad-hook"]}]},
        {"Stop": [{"matcher": "*", "hooks": [{"command": "/bin/true"}]}]},
        {"Stop": [{"matcher": "*", "hooks": [
            {"type": "command", "command": ""}
        ]}]},
        {"Stop": [{"matcher": "*", "hooks": [
            {"type": "command", "command": "/bin/true", "timeout": False}
        ]}]},
        {"Stop": [{"matcher": "*", "hooks": [
            {"type": "command", "command": "/bin/true", "timeout": 0}
        ]}]},
        {"Stop": [{"matcher": "*", "hooks": [
            {"type": "command", "command": "/bin/true", "timeout": float("nan")}
        ]}]},
        {"Stop": [{"matcher": "*", "hooks": [
            {"type": "command", "command": "/bin/true", "timeout": float("inf")}
        ]}]},
    ],
)
def test_codex_project_mode_refuses_invalid_hook_shapes(tmp_path, invalid_hooks):
    place_gate(tmp_path, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh")
    hooks_file = tmp_path / ".codex" / "hooks.json"
    hooks_file.parent.mkdir(parents=True)
    original = json.dumps({"hooks": invalid_hooks})
    hooks_file.write_text(original)

    with pytest.raises(ValueError):
        merge_hooks.merge(hooks_file, runtime="codex")

    assert hooks_file.read_text() == original


def test_codex_project_mode_removes_duplicate_gates_but_keeps_a_wrapper(tmp_path):
    gate = place_gate(
        tmp_path, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    hooks_file = tmp_path / ".codex" / "hooks.json"
    hooks_file.parent.mkdir(parents=True)
    wrapper = f'/opt/audit-wrapper "{gate}"'
    hooks_file.write_text(json.dumps({
        "hooks": {"Stop": [
            {"matcher": "old", "hooks": [
                {"type": "command", "command": "/old/.agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"},
                {"type": "command", "command": "/opt/other/goal-gate-stop.sh"},
                {"type": "command", "command": wrapper},
            ]},
            {"matcher": "*", "hooks": [
                {"type": "command", "command": str(gate)},
            ]},
        ]}
    }))

    merge_hooks.merge(hooks_file, runtime="codex")

    commands = [
        hook["command"]
        for group in read(hooks_file)["hooks"]["Stop"]
        for hook in group["hooks"]
    ]
    assert wrapper in commands
    assert "/opt/other/goal-gate-stop.sh" in commands
    assert sum(merge_hooks.is_gate_command(command) for command in commands) == 1
    assert str(gate) in commands


def test_remove_gate_file_migrates_only_old_eque2_user_hooks(tmp_path):
    hooks_file = tmp_path / ".codex" / "hooks.json"
    hooks_file.parent.mkdir(parents=True)
    legacy = tmp_path / "goal-gate-runtime" / "gate" / "goal-gate-stop.sh"
    legacy.parent.mkdir(parents=True)
    (legacy.parent / ".placed-from").write_text("eque2-code-goal-gate\n")
    wrapper = f'/opt/audit-wrapper "{legacy}"'
    third_party = "/opt/another-tool/goal-gate-stop.sh"
    generic_runtime = "/opt/team/goal-gate/gate/goal-gate-stop.sh"
    relative = "tools/goal-gate/goal-gate-stop.sh"
    hooks_file.write_text(json.dumps({
        "name": "preserve-me",
        "hooks": {
            "Stop": [{"matcher": "*", "hooks": [
                {"type": "command", "command": str(legacy), "timeout": 120},
                {"type": "command", "command": wrapper},
                {"type": "command", "command": third_party},
                {"type": "command", "command": generic_runtime},
                {"type": "command", "command": relative},
                {"type": "command", "command": "/opt/unrelated-stop.sh"},
            ]}],
            "SessionStart": [{"hooks": [
                {"type": "command", "command": "/opt/session-start.sh"}
            ]}],
        },
    }))

    result = merge_hooks.remove_gate_file(hooks_file)

    assert result["goal_gate_removed"] == 1
    cfg = read(hooks_file)
    assert cfg["name"] == "preserve-me"
    commands = [hook["command"] for hook in cfg["hooks"]["Stop"][0]["hooks"]]
    assert wrapper in commands
    assert third_party in commands
    assert generic_runtime in commands
    assert relative in commands
    assert "/opt/unrelated-stop.sh" in commands
    assert cfg["hooks"]["SessionStart"][0]["hooks"][0]["command"] == \
        "/opt/session-start.sh"


def test_remove_gate_cli_is_idempotent_for_a_missing_file(tmp_path):
    hooks_file = tmp_path / ".codex" / "hooks.json"

    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--remove-gate", str(hooks_file)],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["goal_gate_removed"] == 0
    assert not hooks_file.exists()


def test_remove_gate_file_refuses_malformed_json_without_changing_it(tmp_path):
    hooks_file = tmp_path / ".codex" / "hooks.json"
    hooks_file.parent.mkdir(parents=True)
    original = '{"hooks":'
    hooks_file.write_text(original)

    with pytest.raises(ValueError, match="refusing to overwrite malformed JSON"):
        merge_hooks.remove_gate_file(hooks_file)

    assert hooks_file.read_text() == original


def test_user_gate_migration_waits_for_this_codex_home_proof(tmp_path, monkeypatch):
    home = tmp_path / "home"
    active_home = tmp_path / "air-home"
    project = tmp_path / "project"
    gate = place_gate(
        project, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    proof = place_proof(gate)
    project_hooks = project / ".codex" / "hooks.json"
    project_hooks.parent.mkdir(parents=True)
    project_hooks.write_text(json.dumps({"hooks": {"Stop": [{"matcher": "*", "hooks": [
        {"type": "command", "command": str(gate), "timeout": 120}
    ]}]}}))

    legacy = place_legacy_gate(tmp_path)
    active_hooks = active_home / "hooks.json"
    active_hooks.parent.mkdir(parents=True)
    active_hooks.write_text(json.dumps({"hooks": {"Stop": [{"matcher": "*", "hooks": [
        {"type": "command", "command": str(legacy), "timeout": 120},
        {"type": "command", "command": "/opt/unrelated-stop.sh"},
    ]}]}}))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(active_home))
    project_result = {
        "path": str(project_hooks),
        "goal_gate_command": str(gate),
    }

    before_proof = merge_hooks.migrate_proven_user_hooks(project_result)

    assert before_proof["removed"] == 0
    assert str(active_hooks.resolve()) in before_proof["deferred"]
    assert merge_hooks.is_legacy_user_gate_command(
        read(active_hooks)["hooks"]["Stop"][0]["hooks"][0]["command"]
    )

    env = dict(os.environ, HOME=str(home), CODEX_HOME=str(active_home))
    recorded = subprocess.run(
        ["bash", str(proof), "record", "codex", str(gate)],
        check=False,
        env=env,
    )
    assert recorded.returncode == 0

    after_proof = merge_hooks.migrate_proven_user_hooks(project_result)

    assert after_proof["removed"] == 1
    commands = [
        hook["command"]
        for group in read(active_hooks)["hooks"]["Stop"]
        for hook in group["hooks"]
    ]
    assert commands == ["/opt/unrelated-stop.sh"]


def test_user_gate_migration_never_removes_the_project_hook(tmp_path, monkeypatch):
    project = tmp_path / "project"
    gate = place_gate(
        project, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    place_proof(gate)
    project_hooks = project / ".codex" / "hooks.json"
    project_hooks.parent.mkdir(parents=True)
    project_hooks.write_text(json.dumps({"hooks": {"Stop": [{"matcher": "*", "hooks": [
        {"type": "command", "command": str(gate), "timeout": 120}
    ]}]}}))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CODEX_HOME", str(project / ".codex"))

    result = merge_hooks.migrate_proven_user_hooks({
        "path": str(project_hooks),
        "goal_gate_command": str(gate),
    })

    assert result == {
        "removed": 0,
        "deferred": [],
        "checked": [],
        "errors": [],
    }
    assert project_hooks.is_file()
    assert len(read(project_hooks)["hooks"]["Stop"]) == 1


def test_codex_project_cli_writes_the_main_checkout_hook(tmp_path):
    main_root = tmp_path / "main checkout"
    worktree_root = tmp_path / "linked checkout"
    gate = place_gate(
        main_root, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    place_proof(gate)
    worktree_root.mkdir()
    (worktree_root / ".git").write_text("gitdir: elsewhere\n")
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_git = fake_bin / "git"
    fake_git.write_text(
        "#!/bin/sh\n"
        f"printf 'worktree %s\\n\\n' '{main_root}'\n"
    )
    fake_git.chmod(0o755)
    env = dict(
        os.environ,
        PATH=f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        HOME=str(tmp_path / "home"),
        CODEX_HOME=str(tmp_path / "codex-home"),
    )

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--runtime",
            "codex",
            "--project-root",
            str(worktree_root),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["hook_audit"]["status"] == "pending-trust"
    assert str((main_root / ".codex" / "hooks.json").resolve()) in \
        payload["hook_audit"]["checked_sources"]
    hooks_file = main_root / ".codex" / "hooks.json"
    assert hooks_file.is_file()
    assert not (worktree_root / ".codex" / "hooks.json").exists()
    command = read(hooks_file)["hooks"]["Stop"][0]["hooks"][0]["command"]
    assert command == merge_hooks.shlex.quote(str(gate.resolve()))


def test_codex_project_cli_copies_a_worktree_only_gate_to_main(tmp_path):
    main_root = tmp_path / "main"
    worktree_root = tmp_path / "linked"
    main_root.mkdir()
    gate = place_gate(
        worktree_root, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    place_proof(gate)
    (worktree_root / ".git").write_text("gitdir: elsewhere\n")
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_git = fake_bin / "git"
    fake_git.write_text(
        "#!/bin/sh\n"
        f"printf 'worktree %s\\n\\n' '{main_root}'\n"
    )
    fake_git.chmod(0o755)
    env = dict(
        os.environ,
        PATH=f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        HOME=str(tmp_path / "home"),
        CODEX_HOME=str(tmp_path / "codex-home"),
    )

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--runtime",
            "codex",
            "--project-root",
            str(worktree_root),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )

    assert result.returncode == 0, result.stderr
    copied_gate = (
        main_root
        / ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    assert copied_gate.is_file()
    assert os.access(copied_gate, os.X_OK)
    assert all(
        (copied_gate.parent / name).is_file()
        for name in merge_hooks.GATE_REQUIRED_FILES
    )
    hooks_file = main_root / ".codex" / "hooks.json"
    assert hooks_file.is_file()
    command = read(hooks_file)["hooks"]["Stop"][0]["hooks"][0]["command"]
    assert command == str(copied_gate.resolve())


def test_codex_project_cli_uses_real_git_linked_worktree_output(tmp_path):
    main_root = tmp_path / "repository"
    subprocess.run(["git", "init", "--quiet", str(main_root)], check=True)
    (main_root / ".gitignore").write_text("/.claude/worktrees/\n")
    subprocess.run(["git", "-C", str(main_root), "add", ".gitignore"], check=True)
    subprocess.run(
        [
            "git", "-C", str(main_root),
            "-c", "user.name=Fixture",
            "-c", "user.email=fixture@example.invalid",
            "commit", "--quiet", "-m", "fixture",
        ],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(main_root), "branch", "linked-fixture"],
        check=True,
    )
    linked_root = main_root / ".claude" / "worktrees" / "linked"
    linked_root.parent.mkdir(parents=True)
    subprocess.run(
        [
            "git", "-C", str(main_root), "worktree", "add", "--quiet",
            str(linked_root), "linked-fixture",
        ],
        check=True,
    )
    gate = place_gate(
        linked_root, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    place_proof(gate)
    env = dict(
        os.environ,
        HOME=str(tmp_path / "home"),
        CODEX_HOME=str(tmp_path / "codex-home"),
    )

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--runtime",
            "codex",
            "--project-root",
            str(linked_root),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )

    assert result.returncode == 0, result.stderr
    hooks_file = main_root / ".codex" / "hooks.json"
    copied_gate = (
        main_root
        / ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    assert hooks_file.is_file()
    assert copied_gate.is_file()
    command = read(hooks_file)["hooks"]["Stop"][0]["hooks"][0]["command"]
    assert command == str(copied_gate.resolve())


def test_registered_command_resolves_to_a_real_file(tmp_path):
    """The property that actually matters: whatever we write must exist once
    $CLAUDE_PROJECT_DIR is expanded. This is the assertion that would have
    caught the field failure before it shipped."""
    place_gate(tmp_path)
    settings = tmp_path / ".claude" / "settings.json"
    cmd = merge_hooks.merge(settings)["goal_gate_command"]
    word = merge_hooks.shlex.split(cmd)[0]
    resolved = tmp_path / word.replace("$CLAUDE_PROJECT_DIR/", "")
    assert resolved.is_file(), f"registered a command that does not exist: {cmd}"


def test_codex_hook_audit_reports_pending_trust_and_keeps_fallback(
    tmp_path, monkeypatch
):
    home = tmp_path / "home"
    active_home = tmp_path / "air-home"
    project = tmp_path / "project"
    gate = place_gate(
        project, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    place_proof(gate)
    hooks_file = project / ".codex" / "hooks.json"
    result = merge_hooks.merge(hooks_file, runtime="codex")
    legacy = place_legacy_gate(tmp_path)
    active_hooks = active_home / "hooks.json"
    active_hooks.parent.mkdir(parents=True)
    active_hooks.write_text(json.dumps({"hooks": {"Stop": [{
        "matcher": "*",
        "hooks": [
            {"type": "command", "command": str(legacy), "timeout": 120},
            {"type": "command", "command": "/opt/unrelated-stop.sh"},
        ],
    }]}}))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(active_home))
    monkeypatch.setenv("GOAL_GATE_PROOF_DIR", str(tmp_path / "proof"))

    migration = merge_hooks.migrate_proven_user_hooks(result)
    audit = merge_hooks.audit_hook_install(result, "codex", migration)

    assert audit["status"] == "pending-trust"
    assert audit["proof"] in {"missing", "scope-or-command-mismatch"}
    assert str(hooks_file.resolve()) in audit["checked_sources"]
    assert str(active_hooks.resolve()) in audit["checked_sources"]
    assert audit["legacy_fallbacks"] == [{
        "source": str(active_hooks.resolve()),
        "active": True,
        "count": 1,
        "state": "retained-unproven",
    }]
    commands = [
        hook["command"]
        for group in read(active_hooks)["hooks"]["Stop"]
        for hook in group["hooks"]
    ]
    assert commands == [str(legacy), "/opt/unrelated-stop.sh"]


def test_codex_pending_trust_without_fallback_reports_fail_closed_start(
    tmp_path, monkeypatch
):
    project = tmp_path / "project"
    gate = place_gate(
        project, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    place_proof(gate)
    result = merge_hooks.merge(project / ".codex" / "hooks.json", runtime="codex")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "air-home"))

    audit = merge_hooks.audit_hook_install(result, "codex")

    assert audit["status"] == "pending-trust"
    assert audit["legacy_fallbacks"] == []
    assert any(
        "pursue-goal remains unavailable" in action
        for action in audit["actions"]
    )


def test_codex_hook_audit_passes_for_active_home_and_keeps_dormant_fallback(
    tmp_path, monkeypatch
):
    home = tmp_path / "home"
    normal_home = home / ".codex"
    active_home = tmp_path / "air-home"
    project = tmp_path / "project"
    gate = place_gate(
        project, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    proof = place_proof(gate)
    hooks_file = project / ".codex" / "hooks.json"
    result = merge_hooks.merge(hooks_file, runtime="codex")
    legacy = place_legacy_gate(tmp_path)
    for codex_home in (normal_home, active_home):
        user_hooks = codex_home / "hooks.json"
        user_hooks.parent.mkdir(parents=True)
        user_hooks.write_text(json.dumps({"hooks": {"Stop": [{
            "matcher": "*",
            "hooks": [
                {"type": "command", "command": str(legacy), "timeout": 120},
                {"type": "command", "command": "/opt/unrelated-stop.sh"},
            ],
        }]}}))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(active_home))
    monkeypatch.setenv("GOAL_GATE_PROOF_DIR", str(tmp_path / "proof"))
    env = dict(os.environ)
    recorded = subprocess.run(
        ["bash", str(proof), "record", "codex", str(gate)],
        check=False,
        env=env,
    )
    assert recorded.returncode == 0

    migration = merge_hooks.migrate_proven_user_hooks(result)
    audit = merge_hooks.audit_hook_install(result, "codex", migration)

    assert migration["removed"] == 1
    assert audit["status"] == "passed"
    assert audit["proof"] == "current"
    assert audit["legacy_fallbacks"] == [{
        "source": str((normal_home / "hooks.json").resolve()),
        "active": False,
        "count": 1,
        "state": "retained-inactive",
    }]
    active_commands = [
        hook["command"]
        for group in read(active_home / "hooks.json")["hooks"]["Stop"]
        for hook in group["hooks"]
    ]
    assert active_commands == ["/opt/unrelated-stop.sh"]


def test_codex_hook_audit_fails_for_duplicate_owned_fallbacks_without_editing(
    tmp_path, monkeypatch
):
    home = tmp_path / "home"
    active_home = tmp_path / "air-home"
    project = tmp_path / "project"
    gate = place_gate(
        project, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    place_proof(gate)
    result = merge_hooks.merge(project / ".codex" / "hooks.json", runtime="codex")
    legacy = place_legacy_gate(tmp_path)
    active_hooks = active_home / "hooks.json"
    active_hooks.parent.mkdir(parents=True)
    original = json.dumps({"keep": "unchanged", "hooks": {"Stop": [{
        "matcher": "*",
        "hooks": [
            {"type": "command", "command": str(legacy), "timeout": 120},
            {"type": "command", "command": str(legacy), "timeout": 120},
            {"type": "command", "command": "/opt/unrelated-stop.sh"},
        ],
    }]}})
    active_hooks.write_text(original)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(active_home))
    monkeypatch.setenv("GOAL_GATE_PROOF_DIR", str(tmp_path / "proof"))

    migration = merge_hooks.migrate_proven_user_hooks(result)
    audit = merge_hooks.audit_hook_install(result, "codex", migration)

    assert audit["status"] == "failed"
    assert any("2 owned user goal gates" in problem for problem in audit["problems"])
    assert active_hooks.read_text() == original


def test_codex_hook_audit_fails_for_malformed_user_source_without_editing(
    tmp_path, monkeypatch
):
    home = tmp_path / "home"
    active_home = tmp_path / "air-home"
    project = tmp_path / "project"
    gate = place_gate(
        project, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    place_proof(gate)
    result = merge_hooks.merge(project / ".codex" / "hooks.json", runtime="codex")
    active_hooks = active_home / "hooks.json"
    active_hooks.parent.mkdir(parents=True)
    original = '{"hooks":{"Stop":['
    active_hooks.write_text(original)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(active_home))
    monkeypatch.setenv("GOAL_GATE_PROOF_DIR", str(tmp_path / "proof"))

    audit = merge_hooks.audit_hook_install(result, "codex")

    assert audit["status"] == "failed"
    assert any("malformed JSON" in problem for problem in audit["problems"])
    assert active_hooks.read_text() == original


def test_codex_hook_audit_rejects_a_claude_variable_command(tmp_path, monkeypatch):
    project = tmp_path / "project"
    gate = place_gate(
        project, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    place_proof(gate)
    hooks_file = project / ".codex" / "hooks.json"
    hooks_file.parent.mkdir(parents=True)
    command = "$CLAUDE_PROJECT_DIR/.agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    hooks_file.write_text(json.dumps({"hooks": {"Stop": [{
        "matcher": "*",
        "hooks": [{"type": "command", "command": command, "timeout": 120}],
    }]}}))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    result = {
        "path": str(hooks_file),
        "goal_gate_command": command,
    }

    audit = merge_hooks.audit_hook_install(result, "codex")

    assert audit["status"] == "failed"
    assert any("without Claude variables" in problem for problem in audit["problems"])


def test_codex_hook_audit_rejects_a_missing_runtime_helper(tmp_path, monkeypatch):
    project = tmp_path / "project"
    gate = place_gate(
        project, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    place_proof(gate)
    (gate.parent / "cancel.sh").unlink()
    hooks_file = project / ".codex" / "hooks.json"
    result = merge_hooks.merge(hooks_file, runtime="codex")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))

    audit = merge_hooks.audit_hook_install(result, "codex")

    assert audit["status"] == "failed"
    assert any("cancel.sh" in problem for problem in audit["problems"])


def test_codex_hook_audit_rejects_a_gate_wrapper_without_removing_it(
    tmp_path, monkeypatch
):
    project = tmp_path / "project"
    gate = place_gate(
        project, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    place_proof(gate)
    hooks_file = project / ".codex" / "hooks.json"
    wrapper = f'/opt/audit-wrapper "{gate}"'
    hooks_file.parent.mkdir(parents=True)
    hooks_file.write_text(json.dumps({"hooks": {"Stop": [{
        "matcher": "*",
        "hooks": [{"type": "command", "command": wrapper}],
    }]}}))
    result = merge_hooks.merge(hooks_file, runtime="codex")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))

    audit = merge_hooks.audit_hook_install(result, "codex")

    assert audit["status"] == "failed"
    assert any("wrapper command" in problem for problem in audit["problems"])
    commands = [
        hook["command"]
        for group in read(hooks_file)["hooks"]["Stop"]
        for hook in group["hooks"]
    ]
    assert wrapper in commands


def test_codex_hook_audit_preserves_an_ambiguous_user_skill_gate(
    tmp_path, monkeypatch
):
    project = tmp_path / "project"
    gate = place_gate(
        project, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    place_proof(gate)
    result = merge_hooks.merge(project / ".codex" / "hooks.json", runtime="codex")
    active_home = tmp_path / "air-home"
    user_hooks = active_home / "hooks.json"
    user_hooks.parent.mkdir(parents=True)
    ambiguous = tmp_path / "other-project/.agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    original = json.dumps({"hooks": {"Stop": [{
        "matcher": "*",
        "hooks": [{"type": "command", "command": str(ambiguous), "timeout": 120}],
    }]}})
    user_hooks.write_text(original)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CODEX_HOME", str(active_home))

    migration = merge_hooks.migrate_proven_user_hooks(result)
    audit = merge_hooks.audit_hook_install(result, "codex", migration)

    assert migration["removed"] == 0
    assert audit["status"] == "failed"
    assert any("ownership is ambiguous" in problem for problem in audit["problems"])
    assert user_hooks.read_text() == original


def test_codex_hook_audit_rejects_a_non_executable_owned_fallback(
    tmp_path, monkeypatch
):
    project = tmp_path / "project"
    gate = place_gate(
        project, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    place_proof(gate)
    result = merge_hooks.merge(project / ".codex" / "hooks.json", runtime="codex")
    active_home = tmp_path / "air-home"
    legacy = place_legacy_gate(tmp_path)
    legacy.chmod(0o644)
    user_hooks = active_home / "hooks.json"
    user_hooks.parent.mkdir(parents=True)
    user_hooks.write_text(json.dumps({"hooks": {"Stop": [{
        "matcher": "*",
        "hooks": [{"type": "command", "command": str(legacy), "timeout": 120}],
    }]}}))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CODEX_HOME", str(active_home))

    audit = merge_hooks.audit_hook_install(result, "codex")

    assert audit["status"] == "failed"
    assert any("non-canonical or non-executable" in problem for problem in audit["problems"])


def test_proof_check_timeout_fails_the_audit(tmp_path, monkeypatch):
    gate = place_gate(
        tmp_path, ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    )
    proof = gate.parent / "proof-of-fire.sh"
    proof.write_text("#!/usr/bin/env bash\nsleep 1\n")
    proof.chmod(0o755)
    monkeypatch.setattr(merge_hooks, "PROOF_TIMEOUT_SECONDS", 0.01)

    name, code = merge_hooks.check_codex_proof(gate, tmp_path / "codex-home")

    assert (name, code) == ("check-error", 5)


def test_fresh_settings_gets_all_four_hooks(tmp_path):
    place_gate(tmp_path)
    settings = tmp_path / ".claude" / "settings.json"
    result = merge_hooks.merge(settings)
    assert result["hooks_added"] == 4
    cfg = read(settings)
    assert len(cfg["hooks"]["SubagentStart"]) == 1
    assert cfg["hooks"]["SubagentStart"][0]["matcher"] == "eque2-verifier"
    assert "verifier-marker-hook.py" in cfg["hooks"]["SubagentStart"][0]["hooks"][0]["command"]
    assert cfg["hooks"]["SubagentStop"][0]["matcher"] == "eque2-verifier"
    assert cfg["hooks"]["PreToolUse"][0]["matcher"] == "Bash"
    assert "--mode=session" in cfg["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
    assert cfg["hooks"]["Stop"][0]["matcher"] == "*"
    assert "goal-gate-stop.sh" in cfg["hooks"]["Stop"][0]["hooks"][0]["command"]


def test_goal_gate_command_is_one_quoted_path(tmp_path):
    place_gate(tmp_path)
    """pursue-goal.sh proves the gate is runnable by applying `[ -x ]` to the
    direct command after it expands $HOME and $CLAUDE_PROJECT_DIR. Quoting the
    one path keeps a project path with spaces executable without adding a
    wrapper command.
    """
    settings = tmp_path / ".claude" / "settings.json"
    merge_hooks.merge(settings)
    cmd = read(settings)["hooks"]["Stop"][0]["hooks"][0]["command"]
    assert cmd.startswith('"$CLAUDE_PROJECT_DIR/')
    assert merge_hooks.shlex.split(cmd) == [
        "$CLAUDE_PROJECT_DIR/.claude/skills/eque2-code-goal-gate/goal-gate-stop.sh"
    ]


def test_rerun_is_idempotent(tmp_path):
    settings = tmp_path / ".claude" / "settings.json"
    merge_hooks.merge(settings)
    before = read(settings)
    result = merge_hooks.merge(settings)
    assert result["hooks_added"] == 0
    assert result["hooks_updated"] == 0
    assert read(settings) == before


def test_existing_unrelated_hooks_and_settings_survive(tmp_path):
    settings = tmp_path / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({
        "permissions": {"deny": ["Read(.signer-key)"]},
        "hooks": {
            "Stop": [{"hooks": [{"type": "command", "command": "./my-stop.sh"}]}],
            "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "./other-guard.sh"}]}],
        },
    }))
    merge_hooks.merge(settings)
    cfg = read(settings)
    assert cfg["permissions"]["deny"] == ["Read(.signer-key)"]
    assert cfg["hooks"]["Stop"][0]["hooks"][0]["command"] == "./my-stop.sh"
    # The pre-existing Bash PreToolUse group is untouched; ours is a new group.
    commands = [h["hooks"][0]["command"] for h in cfg["hooks"]["PreToolUse"]]
    assert "./other-guard.sh" in commands
    assert any("mint-guard-hook.py" in c for c in commands)


def test_stale_command_is_updated_in_place(tmp_path):
    settings = tmp_path / ".claude" / "settings.json"
    merge_hooks.merge(settings)
    cfg = read(settings)
    cfg["hooks"]["SubagentStart"][0]["hooks"][0]["command"] = (
        'python3 "$CLAUDE_PROJECT_DIR/old/path/verifier-marker-hook.py" start'
    )
    settings.write_text(json.dumps(cfg))
    result = merge_hooks.merge(settings)
    assert result["hooks_updated"] == 1
    assert result["hooks_added"] == 0
    cfg = read(settings)
    assert len(cfg["hooks"]["SubagentStart"]) == 1
    assert ".claude/skills/eque2-code-setup" in cfg["hooks"]["SubagentStart"][0]["hooks"][0]["command"]
