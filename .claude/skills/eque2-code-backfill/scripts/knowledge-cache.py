#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Test-knowledge cache for the [BK] backfill workflow.

Maintains `{output_folder}/test-knowledge/` — one short `.md` success note per
solved test plus an append-only `.manifest.jsonl` (one JSON object per line:
`{"test_id": ..., "timestamp": ISO8601, "file_size": N}`). The manifest is the
only thing the injector reads at scale: it never globs the directory and never
parses note frontmatter.

Commands:
    add     Register an already-written note `{dir}/{test_id}.md` in the
            manifest (size + timestamp). Subagents call this after writing
            their success note.
    inject  Emit the injection block to stdout: the newest <= N entries
            (deduplicated by test_id, newest wins), capped at K kilobytes of
            note bodies. Empty stdout when there is nothing to inject.

Usage:
    uv run ./scripts/knowledge-cache.py add --dir <cache-dir> --test-id CMC-123
    uv run ./scripts/knowledge-cache.py inject --dir <cache-dir> \
        [--max-entries 50] [--max-kb 20]

Deterministic, stdlib-only. Exit codes: 0 success, 1 usage/input error.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

MANIFEST_NAME = ".manifest.jsonl"

INJECT_HEADER = (
    "## Test knowledge from prior runs\n"
    "Showing {n} most recent of {m} total entries. Older entries remain on "
    "disk for forensics but are not injected.\n"
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def cmd_add(args: argparse.Namespace) -> int:
    cache_dir = Path(args.dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    note = cache_dir / f"{args.test_id}.md"
    if not note.is_file():
        print(
            json.dumps({"status": "error", "reason": f"note not found: {note}"}),
            file=sys.stderr,
        )
        return 1
    entry = {
        "test_id": args.test_id,
        "timestamp": args.timestamp or _now_iso(),
        "file_size": note.stat().st_size,
    }
    # POSIX append of a single short line is atomic (< PIPE_BUF) — safe under
    # concurrent subagents.
    with open(cache_dir / MANIFEST_NAME, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")
    print(json.dumps({"status": "added", **entry}))
    return 0


def _read_manifest(cache_dir: Path) -> list[dict]:
    manifest = cache_dir / MANIFEST_NAME
    if not manifest.is_file():
        return []
    entries = []
    for line in manifest.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue  # tolerate a torn/garbled line rather than failing the run
        if isinstance(obj, dict) and "test_id" in obj and "timestamp" in obj:
            entries.append(obj)
    return entries


def cmd_inject(args: argparse.Namespace) -> int:
    cache_dir = Path(args.dir)
    entries = _read_manifest(cache_dir)
    total = len(entries)
    if not entries:
        return 0  # nothing to inject — empty stdout by contract

    # Deduplicate by test_id, keeping the newest manifest line per test.
    newest: dict[str, dict] = {}
    for entry in entries:
        prior = newest.get(entry["test_id"])
        if prior is None or entry["timestamp"] >= prior["timestamp"]:
            newest[entry["test_id"]] = entry

    ranked = sorted(newest.values(), key=lambda e: e["timestamp"], reverse=True)

    byte_cap = args.max_kb * 1024
    selected: list[dict] = []
    cumulative = 0
    for entry in ranked:
        if len(selected) >= args.max_entries:
            break
        size = int(entry.get("file_size", 0))
        if selected and cumulative + size > byte_cap:
            break
        selected.append(entry)
        cumulative += size
        if cumulative >= byte_cap:
            break

    bodies = []
    for entry in selected:
        note = cache_dir / f"{entry['test_id']}.md"
        if not note.is_file():
            continue  # manifest drift — skip silently
        bodies.append(note.read_text(encoding="utf-8").rstrip("\n"))

    if not bodies:
        return 0

    sys.stdout.write(INJECT_HEADER.format(n=len(bodies), m=total))
    sys.stdout.write("\n")
    sys.stdout.write("\n\n".join(bodies))
    sys.stdout.write("\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 2)[1])
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add", help="register an existing note in the manifest")
    p_add.add_argument("--dir", required=True, help="knowledge cache directory")
    p_add.add_argument("--test-id", required=True, help="test ID; note must exist at <dir>/<test-id>.md")
    p_add.add_argument("--timestamp", help="ISO8601 override (defaults to now, UTC)")
    p_add.set_defaults(func=cmd_add)

    p_inject = sub.add_parser("inject", help="emit the injection block to stdout")
    p_inject.add_argument("--dir", required=True, help="knowledge cache directory")
    p_inject.add_argument("--max-entries", type=int, default=50, help="newest-entry cap (default 50)")
    p_inject.add_argument("--max-kb", type=int, default=20, help="cumulative note-body cap in KB (default 20)")
    p_inject.set_defaults(func=cmd_inject)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
