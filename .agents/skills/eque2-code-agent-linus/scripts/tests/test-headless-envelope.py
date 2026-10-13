#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Tests for headless-envelope.py.

Covers:
- Exit codes: ok=0, failed=1, halted=2
- Mandatory stamps present: timestamp, agent_version, session_log
- agent_version read from a manifest, and 'unknown' when absent/unreadable
- --extra payload merged; cannot clobber status/task/stamps
- session_log: explicit wins; derived from --session-dir; null otherwise
- Bad --status and malformed --extra fail cleanly (exit 2, stderr message)
- --help exits 0

Run:
    uv run ./scripts/tests/test-headless-envelope.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
ENVELOPE = SCRIPT_DIR.parent / "headless-envelope.py"


def run(args):
    proc = subprocess.run(
        [sys.executable, str(ENVELOPE), *args],
        capture_output=True, text=True,
    )
    return proc.returncode, proc.stdout, proc.stderr


def parse_ok(args):
    code, out, err = run(args)
    payload = json.loads(out) if out.strip() else None
    return code, payload, err


def test_exit_codes_and_stamps():
    for status, expected_code in (("ok", 0), ("failed", 1), ("halted", 2)):
        code, payload, _ = parse_ok(["--task", "t", "--status", status])
        assert code == expected_code, f"{status}: exit {code} != {expected_code}"
        assert payload["status"] == status
        assert payload["task"] == "t"
        for stamp in ("timestamp", "agent_version", "session_log"):
            assert stamp in payload, f"missing stamp {stamp}"
        # timestamp is ISO-8601-ish
        assert "T" in payload["timestamp"]
    print("ok: exit codes + mandatory stamps")


def test_agent_version_from_manifest():
    with tempfile.TemporaryDirectory() as d:
        manifest = Path(d) / "bmad-manifest.json"
        manifest.write_text(json.dumps({"agent_version": "9.9.9", "agent-code": "linus"}))
        _, payload, _ = parse_ok(["--task", "t", "--status", "ok", "--manifest", str(manifest)])
        assert payload["agent_version"] == "9.9.9", payload["agent_version"]

        # absent manifest -> unknown
        _, payload2, _ = parse_ok(["--task", "t", "--status", "ok",
                                   "--manifest", str(Path(d) / "nope.json")])
        assert payload2["agent_version"] == "unknown"

        # manifest with no version key -> unknown
        manifest.write_text(json.dumps({"agent-code": "linus"}))
        _, payload3, _ = parse_ok(["--task", "t", "--status", "ok", "--manifest", str(manifest)])
        assert payload3["agent_version"] == "unknown"
    print("ok: agent_version from manifest + unknown fallback")


def test_extra_merge_and_protection():
    extra = json.dumps({
        "ticket_key": "PROJ-123",
        "stages_completed": 10,
        # these must NOT override the leading/trailing canonical fields
        "status": "HACKED",
        "task": "HACKED",
        "timestamp": "HACKED",
    })
    _, payload, _ = parse_ok(["--task", "create-spec", "--status", "ok", "--extra", extra])
    assert payload["ticket_key"] == "PROJ-123"
    assert payload["stages_completed"] == 10
    assert payload["status"] == "ok"
    assert payload["task"] == "create-spec"
    assert payload["timestamp"] != "HACKED"
    print("ok: --extra merged; canonical fields protected")


def test_session_log_resolution():
    # explicit wins
    _, payload, _ = parse_ok(["--task", "t", "--status", "ok",
                              "--session-log", "/x/y/today.md"])
    assert payload["session_log"] == "/x/y/today.md"

    # derived from --session-dir as <dir>/<date>.md
    _, payload2, _ = parse_ok(["--task", "t", "--status", "ok",
                               "--session-dir", "/s/sessions"])
    sl = payload2["session_log"]
    assert sl is not None and sl.startswith("/s/sessions/") and sl.endswith(".md"), sl

    # neither -> null
    _, payload3, _ = parse_ok(["--task", "t", "--status", "ok"])
    assert payload3["session_log"] is None
    print("ok: session_log resolution")


def test_bad_inputs():
    # invalid --status is rejected by argparse (exit 2, no stdout JSON)
    code, out, _ = run(["--task", "t", "--status", "weird"])
    assert code == 2, code

    # malformed --extra -> exit 2 with stderr message
    code2, out2, err2 = run(["--task", "t", "--status", "ok", "--extra", "{not json"])
    assert code2 == 2, code2
    assert "headless-envelope" in err2
    assert out2.strip() == ""

    # --extra that is a JSON array (not object) -> exit 2
    code3, _, err3 = run(["--task", "t", "--status", "ok", "--extra", "[1,2,3]"])
    assert code3 == 2, code3
    print("ok: bad inputs rejected cleanly")


def test_help():
    code, out, _ = run(["--help"])
    assert code == 0
    assert "headless result envelope" in out.lower()
    print("ok: --help")


if __name__ == "__main__":
    test_exit_codes_and_stamps()
    test_agent_version_from_manifest()
    test_extra_merge_and_protection()
    test_session_log_resolution()
    test_bad_inputs()
    test_help()
    print("\nAll headless-envelope tests passed.")
