#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Line and branch coverage per directory, from lcov or Cobertura reports. Stdlib only.

lcov comes from vitest, jest and c8 (`lcov` reporter); Cobertura XML comes
from coverlet (.NET) and pytest-cov (`--cov-report=xml`). Several reports
merge into one result, so a monorepo reports once. Files are grouped by
their first --depth path components relative to --root.

    python3 coverage_by_dir.py REPORT [REPORT ...] [--root DIR] [--depth N] [-o FILE]

Exit codes: 0 = parsed, 2 = a report is missing or unreadable.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

CONDITION = re.compile(r"\((\d+)/(\d+)\)")


def parse_lcov(text: str) -> dict[str, list[int]]:
    """{file: [lines_hit, lines_found, branches_hit, branches_found]}"""
    files: dict[str, list[int]] = {}
    current, counts = None, [0, 0, 0, 0]
    for line in text.splitlines():
        tag, _, value = line.partition(":")
        if tag == "SF":
            current, counts = value.strip(), [0, 0, 0, 0]
        elif tag in ("LH", "LF", "BRH", "BRF") and current:
            counts[("LH", "LF", "BRH", "BRF").index(tag)] = int(value)
        elif line.strip() == "end_of_record" and current:
            files[current] = counts
            current = None
    return files


def parse_cobertura(text: str) -> dict[str, list[int]]:
    tree = ET.fromstring(text)
    sources = [s.text.strip() for s in tree.iter("source") if s.text]
    files: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    for cls in tree.iter("class"):
        name = cls.get("filename", "")
        if sources and not Path(name).is_absolute():
            name = str(Path(sources[0]) / name)
        c = files[name]
        seen: set[str] = set()  # a line can repeat across a class's methods and lines blocks
        for line in cls.iter("line"):
            number = line.get("number", "")
            if number in seen:
                continue
            seen.add(number)
            c[1] += 1
            c[0] += int(line.get("hits", "0")) > 0
            m = CONDITION.search(line.get("condition-coverage", ""))
            if line.get("branch", "").lower() == "true" and m:
                c[2] += int(m.group(1))
                c[3] += int(m.group(2))
    return dict(files)


def pct(hit: int, found: int) -> float | None:
    return round(100 * hit / found, 2) if found else None


def summarise(c: list[int]) -> dict:
    return {"lines": {"covered": c[0], "total": c[1], "pct": pct(c[0], c[1])},
            "branches": {"covered": c[2], "total": c[3], "pct": pct(c[2], c[3])}}


def relative(name: str, root: Path) -> str:
    p = Path(name)
    if p.is_absolute():
        try:
            p = p.resolve().relative_to(root)
        except ValueError:
            return p.as_posix()
    return p.as_posix().removeprefix("./") or "."


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("reports", nargs="+", help="lcov.info or Cobertura XML files")
    ap.add_argument("--root", default=".", help="repository root that paths are made relative to")
    ap.add_argument("--depth", type=int, default=2, help="path components that name a directory (default 2)")
    ap.add_argument("-o", "--output", help="write JSON here instead of stdout")
    a = ap.parse_args()
    root = Path(a.root).resolve()

    files: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    for report in a.reports:
        try:
            text = Path(report).read_text(encoding="utf-8", errors="ignore")
            parsed = parse_cobertura(text) if text.lstrip().startswith("<") else parse_lcov(text)
        except (OSError, ET.ParseError) as e:
            print(f"cannot read {report}: {e}", file=sys.stderr)
            return 2
        for name, c in parsed.items():
            merged = files[relative(name, root)]
            for i in range(4):
                merged[i] += c[i]

    dirs: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    for name, c in files.items():
        key = "/".join(Path(name).parts[:-1][:a.depth]) or "."
        for i in range(4):
            dirs[key][i] += c[i]
    totals = [sum(c[i] for c in files.values()) for i in range(4)]
    result = {
        "reports": a.reports,
        "totals": summarise(totals),
        "directories": {k: summarise(v) for k, v in sorted(dirs.items(), key=lambda kv: pct(kv[1][0], kv[1][1]) or 0)},
        "files_at_zero": sorted(n for n, c in files.items() if c[1] and not c[0]),
    }
    text = json.dumps(result, indent=2)
    if a.output:
        Path(a.output).write_text(text + "\n", encoding="utf-8")
        print(f"wrote {a.output}", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
