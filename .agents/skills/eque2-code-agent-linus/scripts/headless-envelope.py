#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Stamp and emit a headless result envelope — one JSON object, deterministic, zero LLM tax.

Every headless task in references/pulse.md must emit a JSON envelope carrying
three mandatory stamps (`timestamp`, `agent_version`, `session_log`) on top of
its task-specific fields, and exit with the convention 0=ok / 1=failed /
2=halted. Hand-assembling that in-prompt on every invocation re-reads the
manifest for the version, formats a timestamp, splices the session-log path, and
picks the exit code by hand — ~150-350 tokens of deterministic boilerplate per
run, enforced only by prose, free to drift.

This script owns that contract: pass the task name, the status, and the
task-specific payload as `--extra '<json>'`; it stamps the three mandatory
fields, merges the payload, prints the final JSON to stdout, and `sys.exit()`s
with the correct code.

Field order in the emitted object: `status`, `task`, then the payload keys,
then `timestamp`, `agent_version`, `session_log`.

Usage:
    uv run ./scripts/headless-envelope.py --task create-spec --status ok \
        --extra '{"ticket_key": "PROJ-123", "stages_completed": 10}' \
        --manifest ./bmad-manifest.json --session-dir /path/to/sanctum/sessions

    uv run ./scripts/headless-envelope.py --task ship --status halted \
        --extra '{"reason": "feature_exists"}'

Exit codes: 0 = status ok, 1 = status failed, 2 = status halted.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

STATUS_EXIT = {"ok": 0, "failed": 1, "halted": 2}

# Keys we'll accept as "the agent/module version" in the manifest, in priority order.
VERSION_KEYS = ("agent_version", "agent-version", "version", "module_version", "module-version")


def read_agent_version(manifest_path: Path | None) -> str:
    """Read a version string from the manifest JSON, or 'unknown' if unavailable."""
    if manifest_path is None or not manifest_path.is_file():
        return "unknown"
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return "unknown"
    if not isinstance(data, dict):
        return "unknown"
    for key in VERSION_KEYS:
        val = data.get(key)
        if isinstance(val, (str, int, float)) and str(val).strip():
            return str(val)
    return "unknown"


def resolve_session_log(session_log: str | None, session_dir: str | None, now: datetime) -> str | None:
    """Explicit --session-log wins; else derive today's log under --session-dir; else null."""
    if session_log:
        return session_log
    if session_dir:
        return str(Path(session_dir) / f"{now.date().isoformat()}.md")
    return None


def build_envelope(task, status, extra, manifest_path, session_log, session_dir, now):
    if status not in STATUS_EXIT:
        raise ValueError(f"--status must be one of {', '.join(STATUS_EXIT)}, got {status!r}")

    payload = {}
    if extra:
        payload = json.loads(extra)
        if not isinstance(payload, dict):
            raise ValueError("--extra must be a JSON object")

    # status + task lead; payload keys never clobber the leading/trailing stamps.
    envelope = {"status": status, "task": task}
    for k, v in payload.items():
        if k not in ("status", "task", "timestamp", "agent_version", "session_log"):
            envelope[k] = v
    envelope["timestamp"] = now.isoformat()
    envelope["agent_version"] = read_agent_version(manifest_path)
    envelope["session_log"] = resolve_session_log(session_log, session_dir, now)
    return envelope


def main(argv=None):
    parser = argparse.ArgumentParser(description="Stamp and emit a headless result envelope.")
    parser.add_argument("--task", required=True, help="Task name (e.g. create-spec, ship).")
    parser.add_argument("--status", required=True, choices=sorted(STATUS_EXIT),
                        help="Outcome: ok | failed | halted.")
    parser.add_argument("--extra", default=None,
                        help="Task-specific fields as a JSON object string. Merged into the envelope.")
    parser.add_argument("--manifest", default=None,
                        help="Path to bmad-manifest.json for the agent_version stamp.")
    parser.add_argument("--session-log", default=None,
                        help="Explicit session-log path for the session_log stamp.")
    parser.add_argument("--session-dir", default=None,
                        help="Sessions dir; session_log is derived as <dir>/YYYY-MM-DD.md when --session-log is absent.")
    args = parser.parse_args(argv)

    now = datetime.now(timezone.utc)
    manifest_path = Path(args.manifest) if args.manifest else None
    try:
        envelope = build_envelope(
            args.task, args.status, args.extra, manifest_path,
            args.session_log, args.session_dir, now,
        )
    except (ValueError, json.JSONDecodeError) as exc:
        print(f"headless-envelope: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(envelope))
    return STATUS_EXIT[args.status]


if __name__ == "__main__":
    sys.exit(main())
