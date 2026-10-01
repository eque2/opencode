#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
bundle-parity-check.py — compare the two installed copies of eque2-code-setup.

A dual install (`--tools claude-code,codex`) puts one copy of the
eque2-code-setup skill in `.claude/skills/` and another in `.agents/skills/`.
Both come from the same installer payload, so every file in them must be
byte-identical: the CLI bundles (`scripts/*.mjs`), the Python scripts, and the
schemas — `schemas/actor-definitions.v1.schema.json` is where the create-spec
scripts read the scenario id grammar. On 2026-09-28 they were not: the
`.agents` reporter bundle came from a different build and accepted different
scenario ids than the `.claude` one.

This script hashes every file under both skill folders and reports drift. It
reads files only to hash them; it never prints their content. Paths that the
install itself writes into ONE copy are ignored: `node_modules/` (setup runs
`pnpm install` in the copy it uses), `__pycache__/`, `.DS_Store`.

Usage:
    python3 bundle-parity-check.py <project_root>

Output (stdout, JSON):
    {"status": "skipped" | "ok" | "drift", "compared": N, "drift": [...],
     "onlyIn": {"claude": [...], "agents": [...]}, "reason"?: "..."}

Exit code: always 0 — the JSON `status` is the result, so a drift report can
never abort a `set -e` setup flow. Re-install the module
(`npx bmad-method install ... --tools claude-code,codex`) to fix drift.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

COPIES = {
    "claude": Path(".claude") / "skills" / "eque2-code-setup",
    "agents": Path(".agents") / "skills" / "eque2-code-setup",
}
IGNORED_DIRS = {"node_modules", "__pycache__"}
IGNORED_FILES = {".DS_Store"}


def _hashes(root: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if any(part in IGNORED_DIRS for part in rel.parts) or p.name in IGNORED_FILES:
            continue
        if p.is_file():
            out[rel.as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def check(project_root: Path) -> dict:
    roots = {name: project_root / rel for name, rel in COPIES.items()}
    present = {name: root.is_dir() for name, root in roots.items()}
    if not all(present.values()):
        return {
            "status": "skipped",
            "reason": "only one skills root holds eque2-code-setup — nothing to compare",
            "present": present,
            "compared": 0,
            "drift": [],
            "onlyIn": {"claude": [], "agents": []},
        }
    claude = _hashes(roots["claude"])
    agents = _hashes(roots["agents"])
    common = sorted(set(claude) & set(agents))
    drift = [
        {"file": name, "claude": claude[name][:16], "agents": agents[name][:16]}
        for name in common
        if claude[name] != agents[name]
    ]
    only_in = {
        "claude": sorted(set(claude) - set(agents)),
        "agents": sorted(set(agents) - set(claude)),
    }
    result: dict = {"compared": len(common), "drift": drift, "onlyIn": only_in}
    if not claude and not agents:
        result.update(status="drift", reason="both eque2-code-setup folders exist but hold no files — the payload is missing")
    elif drift or only_in["claude"] or only_in["agents"]:
        result.update(status="drift", reason="the two copies differ")
    else:
        result.update(status="ok")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Report drift between the .claude and .agents copies of the eque2-code-setup skill. Always exits 0.",
    )
    parser.add_argument("project_root", help="Absolute path to the project root.")
    args = parser.parse_args()
    result = check(Path(args.project_root).resolve())
    print(json.dumps(result))
    if result["status"] == "drift":
        print(
            f"eque2-code: the .claude and .agents copies of eque2-code-setup drifted ({result['reason']}; "
            "see 'drift' / 'onlyIn'). Re-run the marketplace install with --tools claude-code,codex "
            "so both copies come from one payload.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
