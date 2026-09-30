#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""Merge eque2-code hooks into a target project's hook configuration.

Claude mode installs verifier-only-minting hooks and the Stop goal gate:
  - SubagentStart, matcher `eque2-verifier` → verifier-marker-hook.py start
    (mints the role marker the tests CLI reads at lease time)
  - SubagentStop,  matcher `eque2-verifier` → verifier-marker-hook.py stop
    (revokes ONLY its own paired marker — nonce-scoped)
  - PreToolUse,    matcher `Bash`           → mint-guard-hook.py --mode=session
    (marker-aware friction: denies mint verbs when no verifier is running —
    the ORCHESTRATOR's gate; the CLI remains the load-bearing control)

Codex mode installs only the Stop goal gate in `.codex/hooks.json`. The project
file is visible when a harness gives Codex a separate user configuration home.

Idempotent by direct command identity: setup leaves one canonical gate entry
and preserves all unrelated hooks. Safe to re-run on every setup.

Exit codes: 0=success, 2=runtime error
"""

import json
import math
import os
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS_PREFIX = "$CLAUDE_PROJECT_DIR/.claude/skills/eque2-code-setup/scripts"
SKILLS_PREFIX = "$CLAUDE_PROJECT_DIR/.claude/skills"

HOOK_SPECS = [
    {
        "event": "SubagentStart",
        "matcher": "eque2-verifier",
        "command": f'python3 "{SCRIPTS_PREFIX}/verifier-marker-hook.py" start',
        "ident": "verifier-marker-hook.py\" start",
    },
    {
        "event": "SubagentStop",
        "matcher": "eque2-verifier",
        "command": f'python3 "{SCRIPTS_PREFIX}/verifier-marker-hook.py" stop',
        "ident": "verifier-marker-hook.py\" stop",
    },
    {
        "event": "PreToolUse",
        "matcher": "Bash",
        "command": f'python3 "{SCRIPTS_PREFIX}/mint-guard-hook.py" --mode=session',
        "ident": "mint-guard-hook.py",
    },
]

# --- the goal-gate stop hook ------------------------------------------------
#
# Registered SEPARATELY from the three above because, unlike them, its target
# location is not knowable in advance and MUST be verified before it is written.
#
# A Stop hook whose command does not exist FAILS OPEN: the host reports a
# non-blocking error, the turn ends, and nothing is gated — silently, at every
# turn end. That is the exact outcome the goal gate exists to prevent, so
# registering a path we have not confirmed is worse than not registering at all.
# An ABSENT registration makes pursue-goal REFUSE to bind, which is the correct
# behaviour when the gate cannot run.
#
# Found in the field: a repo carrying the skills UNPREFIXED (`goal-gate/`, the
# source-repo layout) got a registration pointing at `eque2-code-goal-gate/` and
# errored on every turn end while appearing installed.
#
# The command is a direct path, never `bash "<path>"`. Codex project mode can
# shell-quote the path as one token when the project path contains spaces.
GATE_IDENT = "goal-gate-stop.sh"

GATE_RELATIVE_CANDIDATES = [
    ".claude/skills/eque2-code-goal-gate/goal-gate-stop.sh",   # marketplace, Claude Code
    ".agents/skills/eque2-code-goal-gate/goal-gate-stop.sh",   # marketplace, Codex root
    ".claude/skills/goal-gate/goal-gate-stop.sh",              # unprefixed source layout
    ".agents/skills/goal-gate/goal-gate-stop.sh",
]

GATE_PATH_SUFFIXES = tuple(
    tuple(Path(relative).parts) for relative in GATE_RELATIVE_CANDIDATES
)
LEGACY_RUNTIME_SUFFIXES = (
    ("goal-gate", "gate", GATE_IDENT),
    ("goal-gate-runtime", "gate", GATE_IDENT),
)
GATE_REQUIRED_FILES = (
    "goal-gate-stop.sh",
    "cancel.sh",
    "loop-state.sh",
    "parse-acs.sh",
    "validate-acs.sh",
    "proof-of-fire.sh",
)
PROOF_TIMEOUT_SECONDS = 30


# The host allows a command hook 600s by default. The gate enforces its own
# 120s decision budget and its comments cite the registration as the source of
# that number — so the registration has to actually say it, or the two disagree
# and the tighter of the two is a fiction.
GATE_TIMEOUT = 120


def resolve_gate_command(project_root: Path, runtime: str = "claude-code"):
    """The runtime-specific gate command, or None to not register.

    EXECUTABILITY IS PART OF EXISTING. The command is registered as a bare path,
    so the host executes it directly: a present-but-non-executable gate is a
    non-blocking hook error at every turn end, which means the turn ENDS and
    nothing is gated — the precise fail-open this function's caller exists to
    avoid, wearing the disguise of a successful install. Checking is_file() alone
    could not tell the two apart.
    """
    candidates = GATE_RELATIVE_CANDIDATES
    if runtime == "codex":
        candidates = sorted(candidates, key=lambda rel: not rel.startswith(".agents/"))

    for rel in candidates:
        candidate = project_root / rel
        if candidate.is_file() and os.access(candidate, os.X_OK):
            if runtime == "codex":
                # Codex does not expand $CLAUDE_PROJECT_DIR for project JSON
                # hooks. Use the absolute installed path. shell quoting keeps a
                # project path with spaces executable as one command.
                return shlex.quote(str(candidate.resolve()))
            return f'"$CLAUDE_PROJECT_DIR/{rel}"'
    return None


def direct_command_path(command):
    """Return the one command path, or None for a wrapper or invalid command."""
    if not isinstance(command, str):
        return None
    try:
        words = shlex.split(command, posix=True)
    except ValueError:
        return None
    if len(words) != 1:
        return None
    return Path(words[0])


def has_path_suffix(path: Path, suffixes) -> bool:
    parts = path.parts
    return any(len(parts) >= len(suffix) and parts[-len(suffix):] == suffix
               for suffix in suffixes)


def is_gate_command(command) -> bool:
    """Return true only for a direct command in a known eque2 skill path.

    A wrapper that mentions the gate as an argument belongs to its owner. A
    same-named third-party script also belongs to its owner.
    """
    path = direct_command_path(command)
    return path is not None and has_path_suffix(path, GATE_PATH_SUFFIXES)


def is_legacy_user_gate_command(command) -> bool:
    """Identify an eque2 gate from the former user-wide installation.

    A third party can use the same basename. Removal therefore also requires a
    directory name that an eque2 installer used for the gate.
    """
    path = direct_command_path(command)
    if path is None or not path.is_absolute():
        return False
    # The old shared runtime carries an installer-written ownership stamp.
    # A generic `goal-gate/gate` directory without that stamp is not ours.
    if not has_path_suffix(path, LEGACY_RUNTIME_SUFFIXES):
        return False
    stamp = path.parent / ".placed-from"
    try:
        return stamp.is_file() and stamp.read_text().strip() == "eque2-code-goal-gate"
    except OSError:
        return False


def command_words(command) -> list[str]:
    """Return shell words, or an empty list for an invalid command."""
    if not isinstance(command, str):
        return []
    try:
        return shlex.split(command, posix=True)
    except ValueError:
        return []


def is_managed_gate_wrapper(command) -> bool:
    """Detect a wrapper that can execute a known or stamped eque2 gate."""
    words = command_words(command)
    if len(words) < 2:
        return False
    for word in words:
        path = Path(word)
        if has_path_suffix(path, GATE_PATH_SUFFIXES):
            return True
        if is_legacy_user_gate_command(shlex.quote(word)):
            return True
    return False


def is_managed_gate_command(command) -> bool:
    """Identify only a gate registration that eque2-code owns."""
    return is_gate_command(command) or is_legacy_user_gate_command(command)


def prune_gate_registrations(hooks: dict) -> int:
    """Drop every goal-gate Stop registration. Returns how many were removed.

    Used when the gate cannot be located: a stale entry from a previous install
    is precisely the fail-open case, so leaving it in place would preserve the
    bug this function exists to clear.
    """
    removed = 0
    stop_groups = hooks.get("Stop")
    if not isinstance(stop_groups, list):
        return 0
    for group in stop_groups:
        if not isinstance(group, dict):
            continue
        group_hooks = group.get("hooks")
        if not isinstance(group_hooks, list):
            continue
        keep = [
            h for h in group_hooks
            if not (
                isinstance(h, dict)
                and is_managed_gate_command(h.get("command"))
            )
        ]
        removed += len(group_hooks) - len(keep)
        group["hooks"] = keep
    # Drop groups we emptied, but never groups that were already empty-and-ours.
    hooks["Stop"] = [
        g for g in stop_groups
        if not (isinstance(g, dict) and isinstance(g.get("hooks"), list) and not g["hooks"])
    ]
    if not hooks["Stop"]:
        del hooks["Stop"]
    return removed


def ensure_gate_registration(hooks: dict, command: str) -> tuple[int, int, int]:
    """Leave exactly one canonical goal-gate Stop entry.

    Returns added, updated, and duplicate entries removed. Unrelated hooks and
    their groups keep their order.
    """
    entry = {"type": "command", "command": command, "timeout": GATE_TIMEOUT}
    stop_groups = hooks.setdefault("Stop", [])
    if not isinstance(stop_groups, list):
        raise ValueError("the hooks.Stop value must be an array")

    owned = []
    canonical = []
    for group_index, group in enumerate(stop_groups):
        if not isinstance(group, dict):
            continue
        group_hooks = group.get("hooks")
        if not isinstance(group_hooks, list):
            continue
        for hook_index, hook in enumerate(group_hooks):
            if (
                isinstance(hook, dict)
                and is_managed_gate_command(hook.get("command"))
            ):
                owned.append((group_index, hook_index))
                if group.get("matcher") == "*" and hook == entry:
                    canonical.append((group_index, hook_index))

    if len(owned) == 1 and canonical == owned:
        return 0, 0, 0

    removed = prune_gate_registrations(hooks)
    stop_groups = hooks.setdefault("Stop", [])
    target_group = next(
        (
            group
            for group in stop_groups
            if isinstance(group, dict)
            and group.get("matcher") == "*"
            and isinstance(group.get("hooks"), list)
        ),
        None,
    )
    if target_group is None:
        stop_groups.append({"matcher": "*", "hooks": [entry]})
    else:
        target_group["hooks"].append(entry)

    if removed:
        return 0, 1, max(0, removed - 1)
    return 1, 0, 0


def primary_worktree_root(project_root: Path) -> Path:
    """Resolve the main checkout whose project hook Codex loads.

    Codex uses the main checkout's project configuration for a linked
    worktree. A worktree-local hook file is inert.
    """
    root = project_root.resolve()
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "worktree", "list", "--porcelain"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError as error:
        if (root / ".git").is_file():
            raise ValueError("cannot resolve the main checkout for this linked worktree") from error
        return root

    if result.returncode == 0:
        for line in result.stdout.splitlines():
            if line.startswith("worktree "):
                primary = Path(line.removeprefix("worktree "))
                if primary.is_absolute() and primary.is_dir():
                    return primary.resolve()
                break

    if (root / ".git").is_file():
        raise ValueError("cannot resolve the main checkout for this linked worktree")
    return root


def gate_runtime_problems(gate: Path) -> list[str]:
    """Return missing or unusable files for one installed gate runtime."""
    problems = []
    for name in GATE_REQUIRED_FILES:
        path = gate.parent / name
        if not path.is_file():
            problems.append(f"the goal-gate runtime helper is missing: {path}")
        elif not os.access(path, os.R_OK):
            problems.append(f"the goal-gate runtime helper is not readable: {path}")
    if gate.is_file() and not os.access(gate, os.X_OK):
        problems.append(f"the registered goal gate is not executable: {gate}")
    return problems


def sync_gate_to_primary(project_root: Path, primary_root: Path, runtime: str) -> None:
    """Copy the installed gate skill into the main checkout when required.

    Codex reads the main checkout's project hook for a linked worktree. A fresh
    install can place the skill only in that linked worktree. Copying the whole
    goal-gate skill gives the main hook one stable executable and all helpers.
    """
    source_root = project_root.resolve()
    target_root = primary_root.resolve()
    if source_root == target_root:
        return

    candidates = GATE_RELATIVE_CANDIDATES
    if runtime == "codex":
        candidates = sorted(candidates, key=lambda rel: not rel.startswith(".agents/"))
    source_relative = next(
        (
            relative for relative in candidates
            if (source_root / relative).is_file()
            and os.access(source_root / relative, os.X_OK)
        ),
        None,
    )
    if source_relative is None:
        if resolve_gate_command(target_root, runtime):
            return
        raise ValueError("the linked worktree has no executable goal gate to install")

    source_skill = (source_root / source_relative).parent
    target_skill = (target_root / source_relative).parent
    source_problems = gate_runtime_problems(source_skill / GATE_IDENT)
    if source_problems:
        raise ValueError("; ".join(source_problems))
    target_skill.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(
        prefix=f".{target_skill.name}.stage-", dir=target_skill.parent
    ))
    backup = target_skill.parent / (
        f".{target_skill.name}.backup-{os.getpid()}-{secrets.token_hex(6)}"
    )
    moved_old = False
    try:
        shutil.copytree(
            source_skill,
            stage,
            dirs_exist_ok=True,
            copy_function=shutil.copy2,
            ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"),
        )
        stage_problems = gate_runtime_problems(stage / GATE_IDENT)
        if stage_problems:
            raise ValueError("; ".join(stage_problems))
        if target_skill.exists():
            os.replace(target_skill, backup)
            moved_old = True
        os.replace(stage, target_skill)
        if moved_old:
            shutil.rmtree(backup)
            moved_old = False
    except ValueError:
        if moved_old and not target_skill.exists() and backup.exists():
            os.replace(backup, target_skill)
        raise
    except OSError as error:
        if moved_old and not target_skill.exists() and backup.exists():
            os.replace(backup, target_skill)
        raise ValueError(
            f"cannot install the goal gate in the main checkout at {target_skill}: {error}"
        ) from error
    finally:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
        if backup.exists() and target_skill.exists():
            shutil.rmtree(backup, ignore_errors=True)

    target_gate = target_root / source_relative
    if not target_gate.is_file() or not os.access(target_gate, os.X_OK):
        raise ValueError(
            f"the copied main-checkout gate is not executable at {target_gate}"
        )


def atomic_write_json(path: Path, value: dict) -> None:
    """Replace one JSON file from a fully written same-directory temporary."""
    path.parent.mkdir(parents=True, exist_ok=True)
    old_mode = None
    try:
        old_mode = path.stat().st_mode & 0o777
    except FileNotFoundError:
        pass
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(value, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        if old_mode is not None:
            os.chmod(temporary_path, old_mode)
        os.replace(temporary_path, path)
    except Exception:
        try:
            temporary_path.unlink()
        except OSError:
            pass
        raise


def reject_json_constant(value):
    raise ValueError(f"non-standard JSON constant: {value}")


def load_json(text: str, path: Path):
    try:
        return json.loads(text, parse_constant=reject_json_constant)
    except (json.JSONDecodeError, ValueError) as error:
        raise ValueError(f"refusing to overwrite malformed JSON in {path}") from error


def validate_hooks_shape(hooks: dict) -> None:
    """Reject structures that Codex or Claude cannot load safely."""
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            raise ValueError(f"the hooks.{event} value must be an array")
        for group in groups:
            if not isinstance(group, dict):
                raise ValueError(f"the hooks.{event} array contains a non-object group")
            if "matcher" in group and not isinstance(group["matcher"], str):
                raise ValueError(f"a hooks.{event} group has a non-string matcher")
            group_hooks = group.get("hooks")
            if not isinstance(group_hooks, list):
                raise ValueError(f"a hooks.{event} group has no hooks array")
            if any(not isinstance(hook, dict) for hook in group_hooks):
                raise ValueError(f"a hooks.{event} group contains a non-object hook")
            for hook in group_hooks:
                if not isinstance(hook.get("type"), str):
                    raise ValueError(f"a hooks.{event} handler has no string type")
                if hook["type"] == "command":
                    if not isinstance(hook.get("command"), str) or not hook["command"]:
                        raise ValueError(
                            f"a hooks.{event} command handler has no command"
                        )
                    timeout = hook.get("timeout")
                    if timeout is not None and (
                        not isinstance(timeout, (int, float))
                        or isinstance(timeout, bool)
                        or not math.isfinite(timeout)
                        or timeout <= 0
                    ):
                        raise ValueError(
                            f"a hooks.{event} command handler has an invalid timeout"
                        )


def remove_gate_file(settings_path: Path) -> dict:
    """Remove only direct eque2 goal-gate commands from one hook file."""
    if not settings_path.exists():
        return {"path": str(settings_path), "goal_gate_removed": 0}
    try:
        cfg = load_json(settings_path.read_text(), settings_path)
    except OSError as error:
        raise ValueError(f"cannot read {settings_path}: {error}") from error
    if not isinstance(cfg, dict):
        raise ValueError(f"refusing to overwrite non-object JSON in {settings_path}")
    hooks = cfg.get("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("the hooks value must be an object")
    validate_hooks_shape(hooks)
    removed = 0
    stop_groups = hooks.get("Stop")
    if isinstance(stop_groups, list):
        for group in stop_groups:
            group_hooks = group.get("hooks")
            keep = [
                hook for hook in group_hooks
                if not is_legacy_user_gate_command(hook.get("command"))
            ]
            removed += len(group_hooks) - len(keep)
            group["hooks"] = keep
        hooks["Stop"] = [group for group in stop_groups if group["hooks"]]
        if not hooks["Stop"]:
            del hooks["Stop"]
    if removed:
        atomic_write_json(settings_path, cfg)
    return {"path": str(settings_path), "goal_gate_removed": removed}


def migrate_proven_user_hooks(project_result: dict) -> dict:
    """Remove an old user gate only after this Codex home proved the project gate.

    The old user hook remains the safe fallback until the new project hook has
    gained trust and fired in that exact Codex home. A dormant IDE home is left
    untouched until setup runs under that home.
    """
    command = project_result.get("goal_gate_command")
    gate = direct_command_path(command)
    if gate is None or not gate.is_absolute():
        return {"removed": 0, "deferred": [], "checked": [], "errors": []}
    proof = gate.parent / "proof-of-fire.sh"
    if not proof.is_file():
        return {
            "removed": 0,
            "deferred": ["proof-helper-missing"],
            "checked": [],
            "errors": [],
        }

    project_hooks = Path(project_result["path"]).resolve()
    home = Path(os.environ.get("HOME", str(Path.home()))).expanduser()
    normal_home = home / ".codex"
    active_home = Path(os.environ.get("CODEX_HOME", str(normal_home))).expanduser()
    homes = []
    for codex_home in (normal_home, active_home):
        resolved = codex_home.resolve()
        if resolved not in homes:
            homes.append(resolved)

    removed = 0
    deferred = []
    checked = []
    errors = []
    for codex_home in homes:
        hooks_file = (codex_home / "hooks.json").resolve()
        if hooks_file == project_hooks or not hooks_file.is_file():
            continue
        checked.append(str(hooks_file))
        env = os.environ.copy()
        env["CODEX_HOME"] = str(codex_home)
        env["GOAL_GATE_PROOF_REQUIRE_DEFINITION"] = "1"
        env["GOAL_GATE_PROOF_REQUIRE_SCOPE"] = "1"
        try:
            proof_result = subprocess.run(
                ["bash", str(proof), "check", "codex", str(gate)],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=env,
                timeout=PROOF_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            errors.append(f"{hooks_file}: proof check failed: {error}")
            continue
        if proof_result.returncode not in {0, 4}:
            deferred.append(str(hooks_file))
            continue
        try:
            removed += remove_gate_file(hooks_file)["goal_gate_removed"]
        except (ValueError, OSError) as error:
            errors.append(f"{hooks_file}: {error}")

    return {
        "removed": removed,
        "deferred": deferred,
        "checked": checked,
        "errors": errors,
    }


def hook_entries(hooks: dict, predicate) -> list[tuple[dict, dict]]:
    """Return matcher groups and handlers selected by one command predicate."""
    selected = []
    for group in hooks.get("Stop", []):
        if not isinstance(group, dict):
            continue
        for hook in group.get("hooks", []):
            if isinstance(hook, dict) and predicate(hook.get("command")):
                selected.append((group, hook))
    return selected


def read_hooks_file(path: Path) -> dict:
    """Read and validate one hook source without changing it."""
    try:
        cfg = load_json(path.read_text(), path)
    except OSError as error:
        raise ValueError(f"cannot read {path}: {error}") from error
    if not isinstance(cfg, dict):
        raise ValueError(f"the hook source in {path} must be a JSON object")
    hooks = cfg.get("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError(f"the hooks value in {path} must be an object")
    validate_hooks_shape(hooks)
    return hooks


def codex_hook_homes(project_hooks: Path) -> list[tuple[str, Path, bool]]:
    """Return each known Codex hook home and mark the effective one."""
    home = Path(os.environ.get("HOME", str(Path.home()))).expanduser()
    normal_home = (home / ".codex").resolve()
    active_home = Path(
        os.environ.get("CODEX_HOME", str(normal_home))
    ).expanduser().resolve()
    homes = []
    for label, codex_home in (("default-user", normal_home), ("active-user", active_home)):
        hooks_file = (codex_home / "hooks.json").resolve()
        if hooks_file == project_hooks.resolve():
            continue
        existing = next((item for item in homes if item[1] == hooks_file), None)
        if existing is not None:
            if codex_home == active_home and not existing[2]:
                homes.remove(existing)
                homes.append(("active-user", hooks_file, True))
            continue
        homes.append((label, hooks_file, codex_home == active_home))
    return homes


def check_codex_proof(gate: Path, codex_home: Path) -> tuple[str, int]:
    """Check proof for one command and one effective Codex trust store."""
    proof = gate.parent / "proof-of-fire.sh"
    if not proof.is_file():
        return "helper-missing", 2
    env = os.environ.copy()
    env["CODEX_HOME"] = str(codex_home)
    env["GOAL_GATE_PROOF_REQUIRE_DEFINITION"] = "1"
    env["GOAL_GATE_PROOF_REQUIRE_SCOPE"] = "1"
    try:
        result = subprocess.run(
            ["bash", str(proof), "check", "codex", str(gate)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            timeout=PROOF_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "check-error", 5
    names = {0: "current", 1: "missing", 2: "scope-or-command-mismatch", 4: "drift"}
    return names.get(result.returncode, "check-error"), result.returncode


def audit_hook_install(
    project_result: dict,
    runtime: str,
    migration=None,
) -> dict:
    """Audit the hook sources that can affect this runtime.

    `pending-trust` is safe but incomplete. Codex must run the project hook once
    before setup can remove the trusted user fallback. `failed` means the
    managed configuration is malformed or can run the wrong command.
    """
    project_hooks = Path(project_result["path"]).resolve()
    expected_command = project_result.get("goal_gate_command")
    expected_gate = direct_command_path(expected_command)
    checked_sources = [str(project_hooks)]
    source_results = []
    problems = []
    actions = []
    legacy_fallbacks = []
    gate_count = 0
    command_executable = False
    timeout = None
    proof_name = "not-required" if runtime == "claude-code" else "not-checked"
    pending = False

    try:
        hooks = read_hooks_file(project_hooks)
    except ValueError as error:
        hooks = {}
        problems.append(str(error))
        source_results.append({
            "source": str(project_hooks),
            "kind": "project",
            "status": "failed",
        })
    else:
        managed = hook_entries(hooks, is_managed_gate_command)
        wrappers = hook_entries(hooks, is_managed_gate_wrapper)
        gate_count = len(managed)
        source_status = "passed"
        if gate_count != 1:
            problems.append(
                f"{project_hooks} has {gate_count} managed Stop gates; exactly one is required"
            )
            source_status = "failed"
        if wrappers:
            problems.append(
                f"{project_hooks} has {len(wrappers)} wrapper command(s) that reference a managed goal gate"
            )
            source_status = "failed"
        elif expected_gate is None:
            problems.append("setup did not resolve a canonical goal-gate command")
            source_status = "failed"
        else:
            group, hook = managed[0]
            timeout = hook.get("timeout")
            actual = hook.get("command")
            actual_gate = direct_command_path(actual)
            if group.get("matcher") != "*" or hook.get("type") != "command":
                problems.append("the project goal gate is not a canonical Stop command")
                source_status = "failed"
            if actual != expected_command:
                problems.append("the project goal gate command differs from the installed gate")
                source_status = "failed"
            if timeout != GATE_TIMEOUT:
                problems.append(
                    f"the project goal gate timeout is {timeout!r}; {GATE_TIMEOUT} is required"
                )
                source_status = "failed"
            if runtime == "codex" and (
                actual_gate is None
                or not actual_gate.is_absolute()
                or "$CLAUDE_PROJECT_DIR" in str(actual)
            ):
                problems.append(
                    "the Codex project gate must use one direct absolute command without Claude variables"
                )
                source_status = "failed"
            resolved_gate = actual_gate
            if runtime == "claude-code" and actual_gate is not None:
                resolved_gate = Path(
                    str(actual_gate).replace(
                        "$CLAUDE_PROJECT_DIR", str(project_hooks.parent.parent)
                    )
                )
            command_executable = bool(
                resolved_gate
                and resolved_gate.is_file()
                and os.access(resolved_gate, os.X_OK)
            )
            if not command_executable:
                problems.append("the registered project goal gate is missing or not executable")
                source_status = "failed"
            if resolved_gate:
                helper_problems = gate_runtime_problems(resolved_gate)
                problems.extend(helper_problems)
                if helper_problems:
                    source_status = "failed"
        source_results.append({
            "source": str(project_hooks),
            "kind": "project",
            "status": source_status,
            "managed_gates": gate_count,
        })

    if runtime == "codex" and expected_gate is not None and expected_gate.is_absolute():
        active_home = Path(
            os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))
        ).expanduser().resolve()
        proof_name, proof_rc = check_codex_proof(expected_gate, active_home)
        if proof_name in {"helper-missing", "check-error"}:
            problems.append(
                f"the Codex proof check cannot run for {expected_gate}: {proof_name}"
            )
        elif proof_rc not in {0, 4}:
            pending = True
            actions.append(
                "Restart Codex, open /hooks, trust the project Stop hook, let it fire once, then rerun setup."
            )
        for label, hooks_file, active in codex_hook_homes(project_hooks):
            checked_sources.append(str(hooks_file))
            if not hooks_file.exists():
                source_results.append({
                    "source": str(hooks_file),
                    "kind": label,
                    "active": active,
                    "status": "absent",
                    "managed_gates": 0,
                })
                continue
            try:
                user_hooks = read_hooks_file(hooks_file)
            except ValueError as error:
                problems.append(str(error))
                source_results.append({
                    "source": str(hooks_file),
                    "kind": label,
                    "active": active,
                    "status": "failed",
                })
                continue
            owned = hook_entries(user_hooks, is_legacy_user_gate_command)
            ambiguous = hook_entries(user_hooks, is_gate_command)
            wrappers = hook_entries(user_hooks, is_managed_gate_wrapper)
            count = len(owned)
            if count:
                legacy_fallbacks.append({
                    "source": str(hooks_file),
                    "active": active,
                    "count": count,
                    "state": (
                        "retained-unproven"
                        if active and proof_rc not in {0, 4}
                        else "retained-inactive"
                    ),
                })
            user_status = "passed"
            if ambiguous:
                problems.append(
                    f"{hooks_file} has {len(ambiguous)} project-skill goal gate(s) in a user hook source; setup preserved them because ownership is ambiguous"
                )
                user_status = "failed"
            if wrappers:
                problems.append(
                    f"{hooks_file} has {len(wrappers)} wrapper command(s) that reference a managed goal gate"
                )
                user_status = "failed"
            if count > 1:
                problems.append(
                    f"{hooks_file} has {count} owned user goal gates; at most one fallback is safe"
                )
                user_status = "failed"
            if active and proof_rc in {0, 4} and count:
                problems.append(
                    f"{hooks_file} still has an owned user goal gate after the project gate was proven"
                )
                user_status = "failed"
            elif active and pending and count and user_status == "passed":
                user_status = "pending-trust"
            for group, hook in owned:
                fallback = direct_command_path(hook.get("command"))
                if (
                    group.get("matcher") != "*"
                    or hook.get("type") != "command"
                    or hook.get("timeout") != GATE_TIMEOUT
                    or fallback is None
                    or not fallback.is_absolute()
                    or not fallback.is_file()
                    or not os.access(fallback, os.X_OK)
                ):
                    problems.append(
                        f"{hooks_file} has a non-canonical or non-executable owned user fallback"
                    )
                    user_status = "failed"
            source_results.append({
                "source": str(hooks_file),
                "kind": label,
                "active": active,
                "status": user_status,
                "managed_gates": count,
            })

    if migration and migration.get("errors"):
        problems.extend(migration["errors"])

    if problems:
        status = "failed"
        actions.insert(0, "Fix the named hook source, then rerun setup before a goal starts.")
    elif pending:
        status = "pending-trust"
        if not any(item["active"] for item in legacy_fallbacks):
            actions.append(
                "No trusted user fallback is active. pursue-goal remains unavailable until this project hook fires once."
            )
    else:
        status = "passed"
        actions.append("No hook repair is required for this runtime.")

    return {
        "status": status,
        "runtime": runtime,
        "checked_sources": checked_sources,
        "source_results": source_results,
        "project_hook": expected_command,
        "goal_gate_entries": gate_count,
        "command_executable": command_executable,
        "timeout": timeout,
        "proof": proof_name,
        "legacy_fallbacks": legacy_fallbacks,
        "problems": problems,
        "actions": actions,
    }


def failed_hook_audit(runtime: str, source: Path, problem: str) -> dict:
    """Build the same audit envelope when merge cannot safely read a source."""
    resolved = str(source.resolve())
    return {
        "status": "failed",
        "runtime": runtime,
        "checked_sources": [resolved],
        "source_results": [{
            "source": resolved,
            "kind": "project",
            "status": "failed",
        }],
        "project_hook": None,
        "goal_gate_entries": 0,
        "command_executable": False,
        "timeout": None,
        "proof": "not-checked",
        "legacy_fallbacks": [],
        "problems": [problem],
        "actions": [
            "Fix the named hook source, then rerun setup before a goal starts."
        ],
    }


def merge(settings_path: Path, runtime: str = "claude-code") -> dict:
    if runtime not in {"claude-code", "codex"}:
        raise ValueError(f"unsupported runtime: {runtime}")

    path_existed = settings_path.exists()
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        cfg = load_json(settings_path.read_text(), settings_path)
    except FileNotFoundError:
        cfg = {}
    except OSError as error:
        raise ValueError(f"cannot read {settings_path}: {error}") from error
    if not isinstance(cfg, dict):
        raise ValueError(f"refusing to overwrite non-object JSON in {settings_path}")

    hooks = cfg.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("the hooks value must be an object")
    validate_hooks_shape(hooks)

    # The gate is located, never assumed. The hook file is two levels below
    # its project root in both supported layouts.
    project_root = settings_path.parent.parent
    gate_command = resolve_gate_command(project_root, runtime)
    # Codex has no verifier subagent mechanism. Its project file gets only the
    # Stop gate. Claude keeps the existing verifier and mint-guard hooks.
    specs = [] if runtime == "codex" else list(HOOK_SPECS)
    added, updated = 0, 0
    if gate_command:
        gate_added, gate_updated, gate_pruned = ensure_gate_registration(
            hooks, gate_command
        )
        added += gate_added
        updated += gate_updated
        gate_status = "registered"
    else:
        # Cannot find the gate: clear any stale registration rather than leave a
        # command that errors on every turn end while gating nothing.
        gate_pruned = prune_gate_registrations(hooks)
        gate_status = "pruned-not-found" if gate_pruned else "skipped-not-found"

    for spec in specs:
        event_list = hooks.setdefault(spec["event"], [])
        if not isinstance(event_list, list):
            raise ValueError(f"the hooks.{spec['event']} value must be an array")
        entry = {"type": "command", "command": spec["command"]}
        if "timeout" in spec:
            entry["timeout"] = spec["timeout"]
        # Find an existing matcher-group we own (same matcher, our script
        # inside). Malformed (non-dict) entries are skipped, never crashed on.
        target_group = None
        for group in event_list:
            if not isinstance(group, dict):
                continue
            group_hooks_raw = group.get("hooks", [])
            if group.get("matcher") == spec["matcher"] and isinstance(group_hooks_raw, list) and any(
                isinstance(h, dict) and spec["ident"] in (h.get("command") or "") for h in group_hooks_raw
            ):
                target_group = group
                break
        if target_group is None:
            event_list.append({"matcher": spec["matcher"], "hooks": [entry]})
            added += 1
        else:
            group_hooks = target_group.setdefault("hooks", [])
            for i, h in enumerate(group_hooks):
                if isinstance(h, dict) and spec["ident"] in (h.get("command") or ""):
                    if h != entry:
                        group_hooks[i] = entry
                        updated += 1
                    break

    if path_existed or gate_command or specs:
        atomic_write_json(settings_path, cfg)
    return {
        "path": str(settings_path),
        "hooks_added": added,
        "hooks_updated": updated,
        "goal_gate": gate_status,
        "goal_gate_command": gate_command,
        "goal_gate_pruned": gate_pruned,
    }


def main() -> int:
    runtime = "claude-code"
    args = sys.argv[1:]
    remove_only = False
    project_setup = False
    if args[:1] == ["--remove-gate"]:
        remove_only = True
        args = args[1:]
    if len(args) >= 2 and args[:2] == ["--runtime", "codex"]:
        runtime = "codex"
        args = args[2:]
    try:
        if runtime == "codex" and len(args) == 2 and args[0] == "--project-root":
            requested_root = Path(args[1]).resolve()
            project_root = primary_worktree_root(requested_root)
            sync_gate_to_primary(requested_root, project_root, runtime)
            args = [str(project_root / ".codex" / "hooks.json")]
            project_setup = True
    except ValueError as error:
        print(f"merge-hooks: {error}", file=sys.stderr)
        return 2
    if len(args) != 1:
        print(
            "usage: merge-hooks.py [--remove-gate PATH | --runtime codex "
            "[--project-root DIR | path-to-hooks-config] | path-to-hooks-config]",
            file=sys.stderr,
        )
        return 2
    try:
        if remove_only:
            result = remove_gate_file(Path(args[0]))
        else:
            result = merge(Path(args[0]), runtime=runtime)
            migration = None
            if project_setup and result["goal_gate_command"]:
                migration = migrate_proven_user_hooks(result)
                result["legacy_user_hooks"] = migration
            result["hook_audit"] = audit_hook_install(
                result, runtime=runtime, migration=migration
            )
    except (ValueError, OSError) as error:
        if not remove_only:
            failed = {
                "path": str(Path(args[0])),
                "hook_audit": failed_hook_audit(runtime, Path(args[0]), str(error)),
            }
            print(json.dumps(failed))
        print(f"merge-hooks: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result))
    if remove_only:
        return 0
    # A gate that could not be located is REPORTED on stderr, not buried in the
    # JSON envelope: the install still succeeds (the other three hooks are fine)
    # but the goal loop is unavailable, and the operator has to know that rather
    # than discover it when pursue-goal refuses to start.
    if not result["goal_gate_command"]:
        print(
            "merge-hooks: goal-gate-stop.sh not found under this project — the Stop "
            "hook was NOT registered"
            + (f" and {result['goal_gate_pruned']} stale registration(s) were removed"
               if result["goal_gate_pruned"] else "")
            + ". pursue-goal will refuse to bind a loop until the goal-gate skill is "
              "installed; a registration pointing at a missing command fails OPEN, so "
              "not registering is the safe outcome.",
            file=sys.stderr,
        )
        if runtime == "codex":
            return 2
    if result["hook_audit"]["status"] == "failed":
        print(
            "merge-hooks: hook audit failed: "
            + "; ".join(result["hook_audit"]["problems"]),
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
