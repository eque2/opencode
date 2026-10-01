#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""Scan a project for its real quality-gate commands and emit candidates as JSON.

The model reasons over the small candidate list this prints instead of
re-reading raw config files every prepare-goal run (Phase 6). The extraction
is deterministic; the "which candidate is THE gate" pick stays the model's job.

Usage:  detect-quality-gate.py <project-root>
        detect-quality-gate.py --selftest
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

# category -> substrings that, seen in a command/script, class it into that gate
KIND = {
    "lint": ("ruff check", "eslint", "flake8", "pylint", "biome", "nx lint", "lint"),
    "typecheck": ("mypy", "pyright", "tsc", "tsc --noemit", "typecheck", "type-check"),
    "test": ("pytest", "jest", "vitest", "nx test", "go test", "cargo test", "npm test", "test"),
    "format": ("ruff format", "black", "prettier", "gofmt", "format --check", "fmt"),
}


def classify(cmd: str) -> str | None:
    low = cmd.lower()
    # most-specific kinds first so "ruff format" isn't caught as lint, "type-check" not as test
    for kind in ("format", "typecheck", "lint", "test"):
        if any(tok in low for tok in KIND[kind]):
            return kind
    return None


def add(out: dict, kind: str | None, cmd: str, source: str) -> None:
    cmd = cmd.strip()
    if kind and cmd and not any(e["command"] == cmd for e in out[kind]):
        out[kind].append({"command": cmd, "source": source})


def scan(root: Path) -> dict:
    out = {k: [] for k in KIND}

    # pyproject.toml — tool.* config presence + [project.scripts]/[tool.*] hints
    pp = root / "pyproject.toml"
    if pp.is_file():
        try:
            data = tomllib.loads(pp.read_text())
        except Exception:
            data = {}
        tools = (data.get("tool") or {})
        if "ruff" in tools:
            add(out, "lint", "ruff check .", "pyproject.toml [tool.ruff]")
            add(out, "format", "ruff format --check .", "pyproject.toml [tool.ruff]")
        if "mypy" in tools:
            add(out, "typecheck", "mypy .", "pyproject.toml [tool.mypy]")
        if "pytest" in tools or (root / "tests").is_dir():
            add(out, "test", "pytest", "pyproject.toml / tests dir")
        if "black" in tools:
            add(out, "format", "black --check .", "pyproject.toml [tool.black]")

    # package.json scripts
    pj = root / "package.json"
    if pj.is_file():
        try:
            scripts = (json.loads(pj.read_text()).get("scripts") or {})
        except Exception:
            scripts = {}
        for name, body in scripts.items():
            add(out, classify(name) or classify(body), f"npm run {name}", "package.json scripts")

    # Makefile / justfile targets
    for fn, runner in (("Makefile", "make"), ("justfile", "just"), ("Justfile", "just")):
        f = root / fn
        if f.is_file():
            for m in re.finditer(r"^([A-Za-z0-9_.-]+):", f.read_text(), re.M):
                target = m.group(1)
                add(out, classify(target), f"{runner} {target}", fn)

    # pre-commit hook ids
    pc = root / ".pre-commit-config.yaml"
    if pc.is_file():
        for m in re.finditer(r"id:\s*([A-Za-z0-9_.-]+)", pc.read_text()):
            add(out, classify(m.group(1)), f"pre-commit run {m.group(1)} --all-files", ".pre-commit-config.yaml")

    # CI workflow run: lines
    ci = root / ".github" / "workflows"
    if ci.is_dir():
        for wf in ci.glob("*.y*ml"):
            for line in wf.read_text().splitlines():
                s = line.strip().lstrip("-").strip()
                if classify(s) and len(s) < 120:
                    add(out, classify(s), s, f".github/workflows/{wf.name}")
    return out


def selftest() -> None:
    assert classify("ruff format --check .") == "format"
    assert classify("ruff check .") == "lint"
    assert classify("mypy src") == "typecheck"
    assert classify("npm run test:unit") == "test"
    assert classify("build docs") is None
    print("selftest ok")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Scan a project for its real quality-gate commands (lint / "
        "type-check / test / format) and print candidates as JSON, so Phase 6 "
        "reasons over a short list instead of re-reading raw config files.",
    )
    ap.add_argument("project_root", nargs="?", help="project directory to scan")
    ap.add_argument("--selftest", action="store_true", help="run the built-in classifier checks and exit")
    args = ap.parse_args(argv)

    if args.selftest:
        selftest()
        return 0
    if not args.project_root:
        ap.error("project_root is required (or pass --selftest)")
    root = Path(args.project_root).expanduser().resolve()
    if not root.is_dir():
        ap.error(f"not a directory: {root}")
    print(json.dumps({"project_root": str(root), "candidates": scan(root)}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
