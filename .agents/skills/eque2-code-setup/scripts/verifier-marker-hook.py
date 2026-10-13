#!/usr/bin/env python3
"""SubagentStart/SubagentStop role-marker hook (verifier-only-minting, CAP-2).

Registered in project settings with matcher = the named verifier subagent
(`eque2-verifier`). `start` mints the role marker the tests CLI reads at
lease time; `stop` revokes it — but ONLY the marker its paired start minted
(nonce is scoped to the subagent invocation's `agent_id`, so a late-firing
stop can never delete a successor verifier's fresh marker).

Marker: {projectRoot}/.eque2-tests/state/.verifier-marker.json (gitignored)
  { "nonce": ..., "agentId": ..., "agent": ..., "mintedAt": ..., "expiresAt": ... }

Expiry = lease TTL (30 min, LEASE_TTL_MIN in tests-state.ts) + 5 min grace:
the lease, not the marker, is the real duration constraint; a verification
outliving its lease is already dead.

Stdin: Claude Code SubagentStart/SubagentStop JSON (session_id, cwd,
agent_type, agent_id). Never crashes the hook chain: any failure exits 0
after writing a diagnostic to stderr (the CLI gate fails closed on a missing
marker anyway).
"""

import datetime
import json
import os
import re
import subprocess
import sys
import uuid

MARKER_NAME = ".verifier-marker.json"
MARKER_TTL_MINUTES = 35  # LEASE_TTL_MIN (30) + grace


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
    if os.environ.get("STATE_DIR", "").strip():
        return os.path.abspath(os.environ["STATE_DIR"].strip())
    override = os.environ.get("TESTS_DB_PATH", "").strip()
    if override and override != ":memory:":
        return re.sub(r"\.(db|sqlite3?)$", "", override, flags=re.IGNORECASE) or override
    return os.path.join(root, ".eque2-tests", "state")


def ensure_gitignore(store: str) -> None:
    path = os.path.join(store, ".gitignore")
    wanted = [MARKER_NAME, "policy-denials.log"]
    existing = ""
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as fh:
            existing = fh.read()
    lines = [l.strip() for l in existing.split("\n")]
    missing = [w for w in wanted if w not in lines]
    if not missing:
        return
    joined = existing if (existing.endswith("\n") or existing == "") else existing + "\n"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(joined + "\n".join(missing) + "\n")


def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action not in ("start", "stop"):
        sys.stderr.write("usage: verifier-marker-hook.py <start|stop>\n")
        return 0

    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    agent_id = str(payload.get("agent_id") or "")
    agent_type = str(payload.get("agent_type") or "eque2-verifier")
    cwd = str(payload.get("cwd") or os.getcwd())

    root = project_root(cwd)
    store = store_root(root)
    marker_path = os.path.join(store, MARKER_NAME)

    try:
        if action == "start":
            os.makedirs(store, exist_ok=True)
            ensure_gitignore(store)
            now = datetime.datetime.now(datetime.timezone.utc)
            marker = {
                "nonce": str(uuid.uuid4()),
                "agentId": agent_id,
                "agent": agent_type,
                "mintedAt": now.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
                "expiresAt": (now + datetime.timedelta(minutes=MARKER_TTL_MINUTES)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            }
            # Atomic replace: a concurrent CLI read must never see a half-written marker.
            tmp_path = marker_path + f".tmp.{os.getpid()}"
            with open(tmp_path, "w", encoding="utf-8") as fh:
                json.dump(marker, fh)
            os.replace(tmp_path, marker_path)
        else:  # stop — nonce-scoped deletion via the paired agent_id
            if os.path.exists(marker_path):
                try:
                    with open(marker_path, "r", encoding="utf-8") as fh:
                        marker = json.load(fh)
                except Exception:
                    marker = {}
                # Nonce-scoped: delete only the marker OUR paired start minted.
                # (An absent agent_id on both sides compares equal — the
                # degenerate single-verifier case on runtimes without ids.)
                if marker.get("agentId", "") == agent_id:
                    os.remove(marker_path)
                # else: a successor verifier's marker — leave it alone
    except Exception as exc:  # never crash the hook chain
        sys.stderr.write(f"verifier-marker-hook {action} failed: {exc}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
