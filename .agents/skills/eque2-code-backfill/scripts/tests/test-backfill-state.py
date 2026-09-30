#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Smoke tests for backfill-state.py.

Covers:
- init: creates the state dir + default files, reports prior parked entries
- heartbeat / heartbeat-clear: lifecycle and idempotency
- get-seen / set-seen: epoch default, atomic advance, corrupt-file recovery
- park / unpark / list-parked / clear-parked: entries, budget (exit 3), removal
- status: aggregate summary

Run:
    uv run ./scripts/tests/test-backfill-state.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
SCRIPT = SCRIPT_DIR.parent / "backfill-state.py"

FAILURES = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILURES.append(name)


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_init() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "backfill"
        rc = run("init", "--dir", str(state))
        check("init exits 0", rc.returncode == 0, rc.stderr)
        out = json.loads(rc.stdout)
        check("init reports epoch mark", out["last_seen_iso"] == "1970-01-01T00:00:00Z")
        check("init reports no prior parked", out["parked_from_prior_run"] == [])
        check("default files created", (state / "seen-history.json").is_file() and (state / "parked-tasks.json").is_file())

        # Simulate a prior session's parked entry, then re-init.
        run("park", "--dir", str(state), "--test-id", "CMC-7", "--task-id", "t-7")
        rc = run("init", "--dir", str(state))
        out = json.loads(rc.stdout)
        check(
            "re-init surfaces prior parked entries",
            len(out["parked_from_prior_run"]) == 1 and out["parked_from_prior_run"][0]["test_id"] == "CMC-7",
            rc.stdout,
        )


def test_heartbeat() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp)
        rc = run("heartbeat", "--dir", str(state))
        check("heartbeat exits 0", rc.returncode == 0, rc.stderr)
        check("heartbeat file present", (state / "heartbeat").is_file())
        rc = run("status", "--dir", str(state))
        out = json.loads(rc.stdout)
        check("status sees heartbeat", out["heartbeat_present"] is True and out["heartbeat_age_seconds"] is not None)
        rc = run("heartbeat-clear", "--dir", str(state))
        check("heartbeat-clear removes it", json.loads(rc.stdout)["was_present"] is True and not (state / "heartbeat").is_file())
        rc = run("heartbeat-clear", "--dir", str(state))
        check("heartbeat-clear idempotent", rc.returncode == 0 and json.loads(rc.stdout)["was_present"] is False)


def test_seen() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp)
        rc = run("get-seen", "--dir", str(state))
        check("get-seen defaults to epoch", json.loads(rc.stdout)["last_seen_iso"] == "1970-01-01T00:00:00Z")
        rc = run("set-seen", "--dir", str(state), "--timestamp", "2026-06-12T10:00:00Z")
        check("set-seen exits 0", rc.returncode == 0, rc.stderr)
        rc = run("get-seen", "--dir", str(state))
        check("get-seen returns the new mark", json.loads(rc.stdout)["last_seen_iso"] == "2026-06-12T10:00:00Z")
        check("no tmp file left behind", not list(state.glob("*.tmp")))

        (state / "seen-history.json").write_text("{corrupt", encoding="utf-8")
        rc = run("get-seen", "--dir", str(state))
        check("corrupt seen file recovers to epoch", rc.returncode == 0 and json.loads(rc.stdout)["last_seen_iso"] == "1970-01-01T00:00:00Z")


def test_parking() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp)
        rc = run("park", "--dir", str(state), "--test-id", "CMC-1", "--task-id", "t-1", "--excerpt", "last output…")
        check("park exits 0", rc.returncode == 0, rc.stderr)
        rc = run("park", "--dir", str(state), "--test-id", "CMC-2", "--task-id", "t-2", "--max", "2")
        check("park under budget exits 0", rc.returncode == 0)
        rc = run("park", "--dir", str(state), "--test-id", "CMC-3", "--task-id", "t-3", "--max", "2")
        check("park over budget exits 3", rc.returncode == 3, str(rc.returncode))
        check("over-budget reports status", json.loads(rc.stdout)["status"] == "park_budget_exhausted")

        rc = run("list-parked", "--dir", str(state))
        parked = json.loads(rc.stdout)
        check("list-parked has 2 entries", len(parked) == 2, rc.stdout)
        check("park entry carries excerpt", parked[0]["excerpt"] == "last output…")

        rc = run("unpark", "--dir", str(state), "--test-id", "CMC-1")
        check("unpark removes entry", json.loads(rc.stdout)["removed"] == 1)
        rc = run("unpark", "--dir", str(state), "--test-id", "CMC-NOPE")
        check("unpark unknown id is not_found", json.loads(rc.stdout)["status"] == "not_found")

        rc = run("clear-parked", "--dir", str(state))
        check("clear-parked empties list", json.loads(rc.stdout)["removed"] == 1)
        rc = run("status", "--dir", str(state))
        check("status reports zero parked", json.loads(rc.stdout)["parked_count"] == 0)


def main() -> int:
    for fn in (test_init, test_heartbeat, test_seen, test_parking):
        print(f"{fn.__name__}:")
        fn()
    if FAILURES:
        print(f"\n{len(FAILURES)} failure(s): {', '.join(FAILURES)}")
        return 1
    print("\nAll backfill-state tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
