#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Smoke tests for knowledge-cache.py.

Covers:
- add: registers an existing note in the manifest with size + timestamp
- add: errors (exit 1) when the note file is missing
- inject: empty stdout on a cold start (no manifest)
- inject: emits header + bodies, newest first
- inject: respects --max-entries
- inject: respects the --max-kb byte cap (but always injects at least one)
- inject: dedupes by test_id keeping the newest manifest line
- inject: skips manifest entries whose note file is missing (drift)
- inject: tolerates malformed manifest lines

Run:
    uv run ./scripts/tests/test-knowledge-cache.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
SCRIPT = SCRIPT_DIR.parent / "knowledge-cache.py"

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


def write_note(cache: Path, test_id: str, body: str, ts: str) -> None:
    (cache / f"{test_id}.md").write_text(body, encoding="utf-8")
    rc = run("add", "--dir", str(cache), "--test-id", test_id, "--timestamp", ts)
    assert rc.returncode == 0, rc.stderr


def test_add_and_manifest() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        cache = Path(tmp) / "test-knowledge"
        cache.mkdir()
        (cache / "CMC-1.md").write_text("# CMC-1 note\n", encoding="utf-8")
        rc = run("add", "--dir", str(cache), "--test-id", "CMC-1")
        check("add exits 0", rc.returncode == 0, rc.stderr)
        out = json.loads(rc.stdout)
        check("add reports status added", out.get("status") == "added")
        manifest = (cache / ".manifest.jsonl").read_text().strip().splitlines()
        check("manifest has one line", len(manifest) == 1)
        entry = json.loads(manifest[0])
        check(
            "manifest entry fields correct",
            entry["test_id"] == "CMC-1" and entry["file_size"] == len("# CMC-1 note\n"),
            json.dumps(entry),
        )

        rc = run("add", "--dir", str(cache), "--test-id", "CMC-MISSING")
        check("add missing note exits 1", rc.returncode == 1, rc.stdout + rc.stderr)


def test_inject_cold_start() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        rc = run("inject", "--dir", str(Path(tmp) / "nowhere"))
        check("cold-start inject exits 0", rc.returncode == 0, rc.stderr)
        check("cold-start inject emits nothing", rc.stdout == "", repr(rc.stdout))


def test_inject_order_and_caps() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        cache = Path(tmp)
        write_note(cache, "CMC-1", "OLDEST note body\n", "2026-01-01T00:00:00Z")
        write_note(cache, "CMC-2", "MIDDLE note body\n", "2026-02-01T00:00:00Z")
        write_note(cache, "CMC-3", "NEWEST note body\n", "2026-03-01T00:00:00Z")

        rc = run("inject", "--dir", str(cache))
        check("inject exits 0", rc.returncode == 0, rc.stderr)
        check(
            "inject header counts 3 of 3",
            "Showing 3 most recent of 3 total entries" in rc.stdout,
            rc.stdout.splitlines()[0] if rc.stdout else "",
        )
        check(
            "newest first",
            rc.stdout.index("NEWEST") < rc.stdout.index("MIDDLE") < rc.stdout.index("OLDEST"),
        )

        rc = run("inject", "--dir", str(cache), "--max-entries", "2")
        check("max-entries cap binds", "OLDEST" not in rc.stdout and "NEWEST" in rc.stdout)
        check("capped header says 2 of 3", "Showing 2 most recent of 3" in rc.stdout)


def test_inject_kb_cap() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        cache = Path(tmp)
        # Two ~0.8 KB notes: a 1 KB cap fits the first but not both.
        write_note(cache, "CMC-BIG1", "A" * 800 + "\n", "2026-01-01T00:00:00Z")
        write_note(cache, "CMC-BIG2", "B" * 800 + "\n", "2026-02-01T00:00:00Z")
        rc = run("inject", "--dir", str(cache), "--max-kb", "1")
        check("kb cap keeps newest only", "BBB" in rc.stdout and "AAA" not in rc.stdout, rc.stdout[:120])
        # A single note larger than the cap is still injected (never zero).
        rc = run("inject", "--dir", str(cache), "--max-entries", "1", "--max-kb", "0")
        # max-kb 0 with one entry: first entry always allowed
        check("at least one entry always injected", "BBB" in rc.stdout)


def test_inject_dedupe_drift_and_garbage() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        cache = Path(tmp)
        write_note(cache, "CMC-9", "FIRST version\n", "2026-01-01T00:00:00Z")
        (cache / "CMC-9.md").write_text("SECOND version\n", encoding="utf-8")
        rc = run("add", "--dir", str(cache), "--test-id", "CMC-9", "--timestamp", "2026-02-01T00:00:00Z")
        assert rc.returncode == 0

        # drift: manifest entry whose file has been removed
        write_note(cache, "CMC-GONE", "ghost\n", "2026-03-01T00:00:00Z")
        (cache / "CMC-GONE.md").unlink()

        # garbage line in the manifest
        with open(cache / ".manifest.jsonl", "a", encoding="utf-8") as fh:
            fh.write("{not json\n")

        rc = run("inject", "--dir", str(cache))
        check("dedupe keeps one body per test_id", rc.stdout.count("version") == 1, rc.stdout)
        check("dedupe keeps newest body", "SECOND version" in rc.stdout)
        check("drifted entry skipped silently", "ghost" not in rc.stdout and rc.returncode == 0)


def main() -> int:
    for fn in (
        test_add_and_manifest,
        test_inject_cold_start,
        test_inject_order_and_caps,
        test_inject_kb_cap,
        test_inject_dedupe_drift_and_garbage,
    ):
        print(f"{fn.__name__}:")
        fn()
    if FAILURES:
        print(f"\n{len(FAILURES)} failure(s): {', '.join(FAILURES)}")
        return 1
    print("\nAll knowledge-cache tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
