#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Loop-state persistence for the [BK] backfill workflow.

Owns three files under the state directory (default location:
`{project-root}/_bmad-output/test-artifacts/backfill/`):

    heartbeat          ISO8601 timestamp; freshness proves the loop is alive.
    seen-history.json  {"last_seen_iso": ...} — high-water mark for the
                       parent's test_transitions_since delta poller.
    parked-tasks.json  Array of {test_id, task_id, parked_at, excerpt} for
                       tests parked at the batch timeout.

All JSON writes are atomic (write to .tmp in the same directory, fsync,
rename) so concurrent readers never observe a partial file. This keeps a
backfill run resumable across session restarts: lifecycle state lives on the
eque2-tests server; everything the *loop* needs lives here.

Commands (all take --dir <state-dir>):
    init             Create the directory + default files; report any parked
                     entries left by a prior session (for reconciliation).
    heartbeat        Touch the heartbeat (write now, UTC).
    heartbeat-clear  Remove the heartbeat (end of run; idempotent).
    get-seen         Print {"last_seen_iso": ...} (epoch default).
    set-seen         --timestamp ISO8601 → atomically advance the mark.
    park             --test-id --task-id [--excerpt] [--max N] → append a
                     parked entry; exit 3 with status park_budget_exhausted
                     when N is given and already reached.
    unpark           --test-id → remove that entry.
    list-parked      Print the parked array.
    clear-parked     Empty the parked array.
    status           One JSON object: heartbeat presence/age, mark, parked count.

Deterministic, stdlib-only. Exit codes: 0 success, 1 usage/input error,
3 park budget exhausted.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

HEARTBEAT = "heartbeat"
SEEN_HISTORY = "seen-history.json"
PARKED_TASKS = "parked-tasks.json"
EPOCH_ISO = "1970-01-01T00:00:00Z"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _atomic_write_json(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def _read_json(path: Path, default):
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def cmd_init(args: argparse.Namespace) -> int:
    state = Path(args.dir)
    state.mkdir(parents=True, exist_ok=True)
    seen_path = state / SEEN_HISTORY
    parked_path = state / PARKED_TASKS
    if not seen_path.is_file():
        _atomic_write_json(seen_path, {"last_seen_iso": EPOCH_ISO})
    if not parked_path.is_file():
        _atomic_write_json(parked_path, [])
    parked = _read_json(parked_path, [])
    print(
        json.dumps(
            {
                "status": "initialised",
                "dir": str(state),
                "last_seen_iso": _read_json(seen_path, {}).get("last_seen_iso", EPOCH_ISO),
                "parked_from_prior_run": parked,
            }
        )
    )
    return 0


def cmd_heartbeat(args: argparse.Namespace) -> int:
    state = Path(args.dir)
    state.mkdir(parents=True, exist_ok=True)
    ts = _now_iso()
    (state / HEARTBEAT).write_text(ts + "\n", encoding="utf-8")
    print(json.dumps({"status": "alive", "timestamp": ts}))
    return 0


def cmd_heartbeat_clear(args: argparse.Namespace) -> int:
    hb = Path(args.dir) / HEARTBEAT
    existed = hb.is_file()
    if existed:
        hb.unlink()
    print(json.dumps({"status": "cleared", "was_present": existed}))
    return 0


def cmd_get_seen(args: argparse.Namespace) -> int:
    data = _read_json(Path(args.dir) / SEEN_HISTORY, {"last_seen_iso": EPOCH_ISO})
    if "last_seen_iso" not in data:
        data = {"last_seen_iso": EPOCH_ISO}
    print(json.dumps(data))
    return 0


def cmd_set_seen(args: argparse.Namespace) -> int:
    state = Path(args.dir)
    state.mkdir(parents=True, exist_ok=True)
    _atomic_write_json(state / SEEN_HISTORY, {"last_seen_iso": args.timestamp})
    print(json.dumps({"status": "set", "last_seen_iso": args.timestamp}))
    return 0


def cmd_park(args: argparse.Namespace) -> int:
    state = Path(args.dir)
    state.mkdir(parents=True, exist_ok=True)
    parked_path = state / PARKED_TASKS
    parked = _read_json(parked_path, [])
    if args.max is not None and len(parked) >= args.max:
        print(
            json.dumps(
                {"status": "park_budget_exhausted", "parked_count": len(parked), "max": args.max}
            )
        )
        return 3
    parked.append(
        {
            "test_id": args.test_id,
            "task_id": args.task_id,
            "parked_at": _now_iso(),
            "excerpt": args.excerpt or "",
        }
    )
    _atomic_write_json(parked_path, parked)
    print(json.dumps({"status": "parked", "test_id": args.test_id, "parked_count": len(parked)}))
    return 0


def cmd_unpark(args: argparse.Namespace) -> int:
    parked_path = Path(args.dir) / PARKED_TASKS
    parked = _read_json(parked_path, [])
    remaining = [e for e in parked if e.get("test_id") != args.test_id]
    removed = len(parked) - len(remaining)
    _atomic_write_json(parked_path, remaining)
    print(
        json.dumps(
            {"status": "unparked" if removed else "not_found", "test_id": args.test_id, "removed": removed, "parked_count": len(remaining)}
        )
    )
    return 0


def cmd_list_parked(args: argparse.Namespace) -> int:
    print(json.dumps(_read_json(Path(args.dir) / PARKED_TASKS, [])))
    return 0


def cmd_clear_parked(args: argparse.Namespace) -> int:
    state = Path(args.dir)
    state.mkdir(parents=True, exist_ok=True)
    parked_path = state / PARKED_TASKS
    removed = len(_read_json(parked_path, []))
    _atomic_write_json(parked_path, [])
    print(json.dumps({"status": "cleared", "removed": removed}))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    state = Path(args.dir)
    hb = state / HEARTBEAT
    heartbeat_present = hb.is_file()
    heartbeat_age = None
    if heartbeat_present:
        heartbeat_age = max(0, int(datetime.now(timezone.utc).timestamp() - hb.stat().st_mtime))
    seen = _read_json(state / SEEN_HISTORY, {"last_seen_iso": EPOCH_ISO})
    parked = _read_json(state / PARKED_TASKS, [])
    print(
        json.dumps(
            {
                "dir": str(state),
                "heartbeat_present": heartbeat_present,
                "heartbeat_age_seconds": heartbeat_age,
                "last_seen_iso": seen.get("last_seen_iso", EPOCH_ISO),
                "parked_count": len(parked),
            }
        )
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 2)[1])
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name: str, func, help_text: str):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--dir", required=True, help="state directory")
        p.set_defaults(func=func)
        return p

    add("init", cmd_init, "create state dir + default files; report prior parked entries")
    add("heartbeat", cmd_heartbeat, "touch the heartbeat")
    add("heartbeat-clear", cmd_heartbeat_clear, "remove the heartbeat (idempotent)")
    add("get-seen", cmd_get_seen, "print the delta-poll high-water mark")
    p = add("set-seen", cmd_set_seen, "advance the high-water mark")
    p.add_argument("--timestamp", required=True, help="ISO8601 high-water mark")
    p = add("park", cmd_park, "append a parked-task entry")
    p.add_argument("--test-id", required=True)
    p.add_argument("--task-id", required=True)
    p.add_argument("--excerpt", help="last output excerpt for the report")
    p.add_argument("--max", type=int, help="park budget; exit 3 when already reached")
    p = add("unpark", cmd_unpark, "remove a parked-task entry")
    p.add_argument("--test-id", required=True)
    add("list-parked", cmd_list_parked, "print the parked array")
    add("clear-parked", cmd_clear_parked, "empty the parked array")
    add("status", cmd_status, "print a one-object state summary")

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
