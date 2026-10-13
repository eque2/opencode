#!/usr/bin/env python3
"""Sanctioned verification runner (verifier-only-minting, S9) — the hookless
fallback for environments where Claude Code SubagentStart/Stop hooks cannot
mint the verifier role marker (headless pipelines, Codex, non-Claude agents).

Wraps ONE verification dispatch: mints the role marker, execs the given
command (the verifier process — e.g. `codex exec` with the verifier prompt,
or any process that runs the verification procedure and calls the tests CLI),
then revokes the marker. Revocation is scoped: only the marker THIS runner
minted is removed (same rule as the SubagentStop hook).

    python3 verification-runner.py -- <command> [args ...]

The CLI's gates behave identically to the hook path: lease binds the marker
nonce; mint verbs fail closed once the marker is gone. This runner is part of
the sanctioned verification path — it is NOT a general-purpose gate bypass,
and using it to wrap a build/orchestrator mint is a named policy violation
(Clause B applies to the wrapped command exactly as to a direct one).

Exit code: the wrapped command's exit code (marker is revoked either way).
"""

import datetime
import json
import os
import re
import subprocess
import sys
import uuid

MARKER_NAME = ".verifier-marker.json"
MARKER_TTL_MINUTES = 35  # LEASE_TTL_MIN (30) + grace — same as the hook


def project_root() -> str:
    env_root = os.environ.get("EQUE2_PROJECT_ROOT", "").strip()
    if env_root and os.path.isdir(env_root):
        return os.path.abspath(env_root)
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    return os.getcwd()


def store_root(root: str) -> str:
    if os.environ.get("STATE_DIR", "").strip():
        return os.path.abspath(os.environ["STATE_DIR"].strip())
    override = os.environ.get("TESTS_DB_PATH", "").strip()
    if override and override != ":memory:":
        return re.sub(r"\.(db|sqlite3?)$", "", override, flags=re.IGNORECASE) or override
    return os.path.join(root, ".eque2-tests", "state")


def main() -> int:
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv:
        sys.stderr.write("usage: verification-runner.py -- <command> [args ...]\n")
        return 2

    store = store_root(project_root())
    os.makedirs(store, exist_ok=True)
    marker_path = os.path.join(store, MARKER_NAME)
    runner_id = f"runner-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    now = datetime.datetime.now(datetime.timezone.utc)
    marker = {
        "nonce": str(uuid.uuid4()),
        "agentId": runner_id,
        "agent": "eque2-verifier",
        "mintedAt": now.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "expiresAt": (now + datetime.timedelta(minutes=MARKER_TTL_MINUTES)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
    }
    # Atomic replace: a concurrent CLI read must never see a half-written marker.
    tmp_path = marker_path + f".tmp.{os.getpid()}"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(marker, fh)
    os.replace(tmp_path, marker_path)

    try:
        result = subprocess.run(argv)
        return result.returncode
    except FileNotFoundError:
        sys.stderr.write(f"verification-runner: command not found: {argv[0]}\n")
        return 127
    finally:
        # Scoped revoke: only the marker THIS runner minted.
        try:
            with open(marker_path, "r", encoding="utf-8") as fh:
                current = json.load(fh)
            if current.get("agentId") == runner_id:
                os.remove(marker_path)
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
