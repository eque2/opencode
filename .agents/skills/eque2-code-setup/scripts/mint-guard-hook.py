#!/usr/bin/env python3
"""PreToolUse guard for the tests-CLI mint verbs (verifier-only-minting, CAP-1).

Two modes:
  --mode=session  Session-wide marker-aware friction layer (project settings):
                  denies a mint-verb Bash invocation whenever NO live verifier
                  role marker exists. This is the ORCHESTRATOR's gate — the
                  orchestrator is not a subagent and can never carry a
                  per-subagent hook.
  --mode=builder  Unconditional deny (build-subagent frontmatter hook): the
                  builder never mints, marker or no marker. Terminal verb is
                  BUILD_COMPLETE.

Exceptions (both modes):
  - `--help` invocations pass (discovery is --help only — Clause A).
  - Commands carrying EQUE2_TESTS_ADMIN=1 pass the HOOK (sanctioned canary /
    operator mode); the CLI still enforces its own admin gate. Builder mode
    does NOT get this exception — a builder has no sanctioned admin path.

Deny = exit 2 with the policy clauses + incident name on stderr (shown to the
model at the point of action), and a line appended to the denial log.

Hooks are friction, not the control: the CLI's own marker/nonce gates hold
alone (SPEC constraint "the CLI is the load-bearing control").

Stdin: Claude Code PreToolUse JSON ({"tool_name": "Bash",
"tool_input": {"command": ...}, ...}). Non-Bash or unparsable input passes
(exit 0) — this guard fails open for anything it cannot classify EXCEPT a
recognisable mint-verb command, which fails closed.
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import sys

MARKER_NAME = ".verifier-marker.json"
DENIAL_LOG_NAME = "policy-denials.log"

CLAUSE_A = (
    "Clause A (never-probe): Privileged verbs (`verdict`, `force-reset`, "
    "`verification-reset`) are never invoked to see what happens, to discover "
    "flags, or to test validation. Discovery is `--help` only. Sole exception: "
    "inside a disposable fixture repo under `EQUE2_TESTS_ADMIN=1` canary mode "
    "(the sanctioned test path this project's own suite uses)."
)
CLAUSE_B = (
    "Clause B (anti-reclassification): Running a mint verb IS minting, "
    "whatever you call it — probe, test, dry run, experiment. There is no "
    "intent exception outside the sanctioned canary mode above; the CLI "
    "records the invocation as an attempt regardless of outcome."
)

# A mint verb as the tests-CLI's own subcommand — the verb immediately follows
# the CLI token, so a mint word in a --reason string or a grep never matches.
MINT_INVOCATION_RE = re.compile(
    r"tests-cli(?:\.mjs|\.ts)?['\"]?\s+(verdict|force-reset|verification-reset|retract)\b"
)
# True `--help` discovery: the flag as its own token, not a substring in an argument.
HELP_FLAG_RE = re.compile(r"(?:^|\s)--help(?:\s|$)")
# Sanctioned admin mode: the env assignment as a command prefix (start or after
# a separator), not merely the string appearing inside an argument.
ADMIN_PREFIX_RE = re.compile(r"(?:^|[;&|(]\s*|\benv\s[^|;&]*?\s)EQUE2_TESTS_ADMIN=1\s")


def project_root(hook_cwd: str) -> str:
    env_root = os.environ.get("EQUE2_PROJECT_ROOT", "").strip()
    if env_root and os.path.isdir(env_root):
        return os.path.abspath(env_root)
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=10, cwd=hook_cwd or None,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    return hook_cwd or os.getcwd()


def store_root(root: str) -> str:
    override = os.environ.get("TESTS_DB_PATH", "").strip()
    if os.environ.get("STATE_DIR", "").strip():
        return os.path.abspath(os.environ["STATE_DIR"].strip())
    if override and override != ":memory:":
        return re.sub(r"\.(db|sqlite3?)$", "", override, flags=re.IGNORECASE) or override
    return os.path.join(root, ".eque2-tests", "state")


def marker_is_live(store: str) -> bool:
    path = os.path.join(store, MARKER_NAME)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            marker = json.load(fh)
        expires = marker.get("expiresAt")
        nonce = marker.get("nonce")
        if not isinstance(expires, str) or not isinstance(nonce, str) or not nonce:
            return False
        exp = datetime.datetime.fromisoformat(expires.replace("Z", "+00:00"))
        # >= matches the CLI's boundary (expired only when strictly past).
        return exp >= datetime.datetime.now(datetime.timezone.utc)
    except Exception:
        return False


def log_denial(store: str, verb: str, mode: str, command: str) -> None:
    try:
        os.makedirs(store, exist_ok=True)
        ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(os.path.join(store, DENIAL_LOG_NAME), "a", encoding="utf-8") as fh:
            fh.write(f"{ts}\thook-deny:{mode}\t{verb}\t{command[:400]}\n")
    except Exception:
        pass  # best-effort: logging never masks the deny


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["session", "builder"], required=True)
    args = parser.parse_args()

    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(payload, dict):
        return 0  # never crash the hook chain on odd stdin shapes
    if payload.get("tool_name") != "Bash":
        return 0
    tool_input = payload.get("tool_input")
    command = (tool_input or {}).get("command") if isinstance(tool_input, dict) else ""
    if not isinstance(command, str) or not command:
        return 0

    invocation = MINT_INVOCATION_RE.search(command)
    if not invocation:
        return 0  # not a mint-verb invocation
    if HELP_FLAG_RE.search(command):
        return 0  # discovery is --help only — and it is allowed

    hook_cwd = str(payload.get("cwd") or "")
    root = project_root(hook_cwd)
    store = store_root(root)

    if args.mode == "session":
        # Sanctioned canary/operator mode; the CLI's admin gate still applies.
        if ADMIN_PREFIX_RE.search(command) or os.environ.get("EQUE2_TESTS_ADMIN") == "1":
            return 0
        if marker_is_live(store):
            return 0  # a verifier is running; the CLI's nonce gate still applies

    verb = invocation.group(1)
    log_denial(store, verb, args.mode, command)

    who = (
        "You are the BUILDER subagent — your terminal verb is BUILD_COMPLETE; mint verbs are never yours."
        if args.mode == "builder"
        else "No verifier is running (no live role marker) — only the named verifier subagent mints verdicts."
    )
    sys.stderr.write(
        f"MINT VERB DENIED ({verb}). {who}\n"
        f"{CLAUSE_A}\n{CLAUSE_B}\n"
        "This exact act — a 'probe' of a mint verb — caused incident CMC-32874. "
        "Use `tests-cli <verb> --help` for discovery. To verify a test, dispatch "
        "the eque2-verifier subagent. Recovery verbs (retract, verification-reset, "
        "force-reset on a stranded test) are OPERATOR actions: escalate to a human, "
        "who runs them under EQUE2_TESTS_ADMIN=1 — do not attempt them yourself.\n"
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
