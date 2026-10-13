#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Tests for merge-help-csv.py — the bmad-help catalog registration.

Covers (spec bmad-help-catalog-gap, CAP-2/CAP-3/CAP-4):
- Merge into a pre-existing CANONICAL catalog preserves base rows + positions.
- Merge that CREATES the catalog fresh emits the canonical header.
- A legacy after/before target is forward-repaired to canonical.
- An unknown column order target fails loud (no misaligned append).
- A foreign-row source aborts (source-purity guard).
- Anti-zombie re-merge is idempotent (stable eque2-code count, base rows intact).
- Empty source errors cleanly (non-zero, no partial write).
- The written catalog is LF (no CRLF) and round-trips through a CSV parser.

Run:  uv run pytest scripts/tests/test-merge-help-csv.py
"""

import csv
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
MERGE_SCRIPT = SCRIPT_DIR.parent / "merge-help-csv.py"

CANONICAL = [
    "module", "skill", "display-name", "menu-code", "description", "action",
    "args", "phase", "preceded-by", "followed-by", "required",
    "output-location", "outputs",
]
LEGACY = CANONICAL[:8] + ["after", "before"] + CANONICAL[10:]


def _row(module, skill, **over):
    """A 13-col data row; preceded-by/followed-by default empty."""
    base = [module, skill, skill, "X", "desc", skill, "", "anytime", "", "", "false", "out", "outs"]
    if "preceded" in over:
        base[8] = over["preceded"]
    if "followed" in over:
        base[9] = over["followed"]
    return base


def _write(path: Path, header, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)


def _read(path: Path):
    with open(path, "r", encoding="utf-8", newline="") as f:
        rows = list(csv.reader(f))
    return rows[0], rows[1:]


def _source(tmp: Path, header=CANONICAL, rows=None):
    rows = rows or [_row("eque2-code", "eque2-code-agent-linus", preceded="a", followed="b"),
                    _row("eque2-code", "eque2-code-create-spec")]
    p = tmp / "source.csv"
    _write(p, header, rows)
    return p


def _run(*args, expect_exit=None):
    r = subprocess.run([sys.executable, str(MERGE_SCRIPT), *map(str, args)],
                       capture_output=True, text=True)
    if expect_exit is not None:
        assert r.returncode == expect_exit, \
            f"expected exit {expect_exit}, got {r.returncode}\nstdout:{r.stdout}\nstderr:{r.stderr}"
    return r


def _codes(rows):
    from collections import Counter
    return Counter(r[0] for r in rows if r and r[0].strip())


def test_merge_into_existing_canonical_preserves_positions_and_base_rows(tmp_path):
    target = tmp_path / "bmad-help.csv"
    base = [_row("bmm", "bmm-plan", preceded="p", followed="q"), _row("tea", "tea-test")]
    _write(target, CANONICAL, base)
    _run("--target", target, "--source", _source(tmp_path), "--module-code", "eque2-code", expect_exit=0)

    header, rows = _read(target)
    assert header == CANONICAL
    counts = _codes(rows)
    assert counts["eque2-code"] == 2
    assert counts["bmm"] == 1 and counts["tea"] == 1
    # base rows content-identical
    assert [r for r in rows if r[0] == "bmm"][0] == _row("bmm", "bmm-plan", preceded="p", followed="q")
    # eque2-code sequencing landed under the NAMED columns
    linus = [r for r in rows if r[1] == "eque2-code-agent-linus"][0]
    assert linus[header.index("preceded-by")] == "a"
    assert linus[header.index("followed-by")] == "b"


def test_merge_creates_fresh_catalog_with_canonical_header(tmp_path):
    target = tmp_path / "_config" / "bmad-help.csv"  # absent + nested
    _run("--target", target, "--source", _source(tmp_path), "--module-code", "eque2-code", expect_exit=0)
    header, rows = _read(target)
    assert header == CANONICAL, "fresh-create must emit the canonical header"
    assert _codes(rows)["eque2-code"] == 2


def test_legacy_header_target_rewritten_to_canonical(tmp_path):
    target = tmp_path / "bmad-help.csv"
    _write(target, LEGACY, [_row("eque2-code", "stale-row")])
    _run("--target", target, "--source", _source(tmp_path), "--module-code", "eque2-code", expect_exit=0)
    header, _ = _read(target)
    assert header == CANONICAL, "legacy after/before header must be forward-repaired"


def test_unknown_column_order_fails_loud(tmp_path):
    target = tmp_path / "bmad-help.csv"
    scrambled = ["skill", "module"] + CANONICAL[2:]  # cols 1/2 swapped → unknown order
    _write(target, scrambled, [_row("bmm", "bmm-plan")])
    before = target.read_bytes()
    r = _run("--target", target, "--source", _source(tmp_path), "--module-code", "eque2-code", expect_exit=1)
    assert "unrecognized column order" in r.stderr
    assert target.read_bytes() == before, "must not write on unknown-order abort"


def test_foreign_row_source_aborts(tmp_path):
    target = tmp_path / "bmad-help.csv"
    _write(target, CANONICAL, [_row("bmm", "bmm-plan")])
    before = target.read_bytes()
    bad = _source(tmp_path, rows=[_row("eque2-code", "ok"), _row("bmm", "sneaky")])
    r = _run("--target", target, "--source", bad, "--module-code", "eque2-code", expect_exit=1)
    assert "foreign module code" in r.stderr
    assert target.read_bytes() == before, "foreign-row abort must not touch base rows"


def test_anti_zombie_remerge_is_idempotent(tmp_path):
    target = tmp_path / "bmad-help.csv"
    _write(target, CANONICAL, [_row("bmm", "bmm-plan", preceded="p", followed="q")])
    src = _source(tmp_path)
    _run("--target", target, "--source", src, "--module-code", "eque2-code", expect_exit=0)
    h1, r1 = _read(target)
    _run("--target", target, "--source", src, "--module-code", "eque2-code", expect_exit=0)
    h2, r2 = _read(target)
    assert _codes(r1)["eque2-code"] == _codes(r2)["eque2-code"] == 2, "no duplicate eque2-code rows"
    assert [r for r in r2 if r[0] == "bmm"] == [_row("bmm", "bmm-plan", preceded="p", followed="q")]


def test_empty_source_errors_cleanly(tmp_path):
    target = tmp_path / "bmad-help.csv"
    empty = tmp_path / "empty.csv"
    _write(empty, CANONICAL, [])  # header only, no data rows
    r = _run("--target", target, "--source", empty, "--module-code", "eque2-code", expect_exit=1)
    assert "No data rows" in r.stderr
    assert not target.exists(), "no partial write on empty source"


def test_lf_roundtrip(tmp_path):
    target = tmp_path / "bmad-help.csv"
    _run("--target", target, "--source", _source(tmp_path), "--module-code", "eque2-code", expect_exit=0)
    raw = target.read_bytes()
    assert b"\r\n" not in raw, "catalog must be LF, not CRLF"
    header, rows = _read(target)  # parses back cleanly
    assert header == CANONICAL and rows


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-q"]))
