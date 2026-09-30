#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Tests for bundle-parity-check.py — .claude vs .agents eque2-code-setup drift.

Covers:
- Only one skills root present      → "skipped".
- Both roots, identical trees        → "ok" (bundles, schemas, nested files).
- A differing bundle                 → "drift", names the file.
- A differing SCHEMA (not only .mjs) → "drift" (the schema is the grammar source).
- A file in one root only            → "drift", listed under onlyIn.
- Both roots present but empty       → "drift".
- node_modules / __pycache__ in one copy only → ignored.
- Exit code is always 0 (a drift report never aborts a set -e flow).

Run:
    uv run scripts/tests/test-bundle-parity-check.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).parent.resolve().parent / "bundle-parity-check.py"


def _copy(root: Path, which: str, files: dict[str, str]) -> Path:
    base = root / (".claude" if which == "claude" else ".agents") / "skills" / "eque2-code-setup"
    base.mkdir(parents=True, exist_ok=True)
    for rel, content in files.items():
        p = base / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    return base


def _run(root: Path) -> dict:
    r = subprocess.run([sys.executable, str(SCRIPT), str(root)], capture_output=True, text=True)
    assert r.returncode == 0, (r.returncode, r.stderr)
    return json.loads(r.stdout)


FILES = {
    "scripts/state.mjs": "a",
    "scripts/scenario-state-reporter.mjs": "b",
    "schemas/actor-definitions.v1.schema.json": '{"pattern": "x"}',
    "SKILL.md": "# setup",
}


def test_single_root_is_skipped():
    with tempfile.TemporaryDirectory() as d:
        _copy(Path(d), "claude", FILES)
        assert _run(Path(d))["status"] == "skipped"


def test_identical_trees_are_ok():
    with tempfile.TemporaryDirectory() as d:
        _copy(Path(d), "claude", FILES)
        _copy(Path(d), "agents", FILES)
        out = _run(Path(d))
        assert out["status"] == "ok" and out["compared"] == len(FILES), out


def test_differing_bundle_is_drift():
    with tempfile.TemporaryDirectory() as d:
        _copy(Path(d), "claude", FILES)
        _copy(Path(d), "agents", {**FILES, "scripts/scenario-state-reporter.mjs": "old build"})
        out = _run(Path(d))
        assert out["status"] == "drift", out
        assert [x["file"] for x in out["drift"]] == ["scripts/scenario-state-reporter.mjs"], out


def test_differing_schema_is_drift():
    with tempfile.TemporaryDirectory() as d:
        _copy(Path(d), "claude", FILES)
        _copy(Path(d), "agents", {**FILES, "schemas/actor-definitions.v1.schema.json": '{"pattern": "old"}'})
        out = _run(Path(d))
        assert [x["file"] for x in out["drift"]] == ["schemas/actor-definitions.v1.schema.json"], out


def test_file_in_one_root_only_is_drift():
    with tempfile.TemporaryDirectory() as d:
        _copy(Path(d), "claude", {**FILES, "scripts/tests-cli.mjs": "t"})
        _copy(Path(d), "agents", FILES)
        out = _run(Path(d))
        assert out["status"] == "drift" and out["onlyIn"]["claude"] == ["scripts/tests-cli.mjs"], out


def test_both_roots_empty_is_drift():
    with tempfile.TemporaryDirectory() as d:
        _copy(Path(d), "claude", {})
        _copy(Path(d), "agents", {})
        out = _run(Path(d))
        assert out["status"] == "drift" and "no files" in out["reason"], out


def test_install_artifacts_in_one_copy_are_ignored():
    with tempfile.TemporaryDirectory() as d:
        _copy(Path(d), "claude", {**FILES, "node_modules/.bin/tsx": "x", "scripts/__pycache__/a.pyc": "y"})
        _copy(Path(d), "agents", FILES)
        assert _run(Path(d))["status"] == "ok"


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"  PASS  {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  FAIL  {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
