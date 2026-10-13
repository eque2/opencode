#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""
prune-stale-mcp.py — Remove stale eque2-code-state entries from ~/.claude.json.

Walks every project key under `projects.*.mcpServers.eque2-code-state` and
removes entries whose wrapper path (the last element of `args[]`) does not
exist on disk. Live entries — wrapper present, env set or not — are
preserved untouched.

Stale entries accumulate when /eque2-code-setup is run from different
absolute paths on the same machine (rename, move, second checkout), because
`claude mcp remove` only operates on the current-project key.

Usage:
  prune-stale-mcp.py             # remove stale entries, rewrite ~/.claude.json
  prune-stale-mcp.py --dry-run   # report only; never write

Output (stdout JSON):
  { "removed": [...], "kept": [...], "errors": [...] }

Exit codes: 0 always when the config is readable; 1 if ~/.claude.json
cannot be parsed.
"""
from __future__ import annotations
import json
import os
import sys
from pathlib import Path

# fcntl is POSIX-only; on Windows the script runs without an advisory lock.
# Claude Code on Windows uses a different config-update cadence; the simple
# read-modify-write window is acceptable there.
try:
    import fcntl  # type: ignore
except ImportError:  # pragma: no cover — Windows
    fcntl = None  # type: ignore

CONFIG = Path.home() / ".claude.json"
SERVER_NAME = "eque2-code-state"


def _wrapper_path(entry: dict) -> str | None:
    """Best-effort recovery of the wrapper path from an MCP entry.

    `claude mcp add ... -- bash <wrapper>` stores `bash` in `command` and the
    wrapper in `args[-1]`. Some registrations omit `args` and put the wrapper
    directly in `command`. Probe both.
    """
    args = entry.get("args") or []
    if args:
        return args[-1]
    cmd = entry.get("command")
    if isinstance(cmd, str) and cmd:
        return cmd
    return None


def main(argv: list[str]) -> int:
    dry_run = "--dry-run" in argv

    if not CONFIG.exists():
        print(json.dumps({"removed": [], "kept": [], "errors": [f"{CONFIG} not found"]}))
        return 0

    # Open with r+ so we hold a single fd across read and write, take an
    # exclusive lock, then re-read inside the critical section. This closes
    # the TOCTOU window where Claude Code rewrites ~/.claude.json between
    # our read and our os.replace.
    try:
        fh = open(CONFIG, "r+", encoding="utf-8")
    except OSError as e:
        print(json.dumps({"removed": [], "kept": [], "errors": [f"open failed: {e}"]}))
        return 1

    with fh:
        if fcntl is not None:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            except OSError:
                pass  # best-effort

        fh.seek(0)
        raw = fh.read()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            print(json.dumps({"removed": [], "kept": [], "errors": [f"parse error: {e}"]}))
            return 1

        removed: list[dict] = []
        kept: list[dict] = []

        projects = data.get("projects") or {}
        for proj_key, proj in projects.items():
            servers = (proj or {}).get("mcpServers") or {}
            entry = servers.get(SERVER_NAME)
            if not entry:
                continue
            wrapper = _wrapper_path(entry)
            if wrapper and not Path(wrapper).exists():
                del servers[SERVER_NAME]
                removed.append({"project": proj_key, "wrapper": wrapper})
            else:
                kept.append({"project": proj_key, "wrapper": wrapper})

        if removed and not dry_run:
            tmp = CONFIG.parent / (CONFIG.name + ".tmp")
            tmp.write_text(json.dumps(data, indent=2))
            os.replace(tmp, CONFIG)

    print(json.dumps({"removed": removed, "kept": kept, "errors": []}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
