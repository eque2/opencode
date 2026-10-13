#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Collect the plumbing for a local rules-based code review, as JSON on stdout.

Reports:
  - the review base: merge-base of HEAD with the default branch (origin/HEAD,
    else main, else master), or --base when given;
  - every changed file since that base: committed, staged, unstaged, and
    untracked (deleted files are listed with status D; there is nothing to read);
  - every review-rule file from both known layouts
    (`.ai/Code Reviews/styleguides/*.md` and `.github/review-rules/*.md`),
    with its Name / Category / Applies To headers, line count, and whether it
    carries a "PR Review Comment Format" section.

It does NOT decide which rule applies to which file — Applies To is free text,
and matching it is the reviewer's judgment.

Exit codes: 0 ok; 2 not a git repository or no usable base.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

RULE_DIRS = (".ai/Code Reviews/styleguides", ".github/review-rules")
HEADER_RE = re.compile(r"^\*\*(Name|Category|Applies To):\*\*\s*(.+?)\s*$")
FORMAT_RE = re.compile(r"^#+\s*PR Review Comment Format\s*$", re.MULTILINE)


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=True
    ).stdout.strip()


def try_git(root: Path, *args: str) -> str | None:
    try:
        return git(root, *args) or None
    except subprocess.CalledProcessError:
        return None


def default_base(root: Path) -> str | None:
    head = try_git(root, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
    if head:
        return head.removeprefix("refs/remotes/")
    for ref in ("origin/main", "main", "origin/master", "master"):
        if try_git(root, "rev-parse", "--verify", "--quiet", ref):
            return ref
    return None


def changed_files(root: Path, merge_base: str) -> list[dict]:
    files: dict[str, str] = {}
    # Diff of the working tree against the merge-base covers committed, staged
    # and unstaged changes in one pass.
    for line in git(root, "diff", "--name-status", "-M", merge_base).splitlines():
        parts = line.split("\t")
        status, path = parts[0][0], parts[-1]
        files[path] = status
    for path in git(root, "ls-files", "--others", "--exclude-standard").splitlines():
        files.setdefault(path, "?")
    return [{"path": p, "status": s} for p, s in sorted(files.items())]


def rule_files(root: Path) -> list[dict]:
    rules = []
    for rel_dir in RULE_DIRS:
        for f in sorted((root / rel_dir).glob("*.md")):
            text = f.read_text(encoding="utf-8", errors="replace")
            headers = {}
            for line in text.splitlines()[:40]:
                m = HEADER_RE.match(line.strip())
                if m:
                    headers.setdefault(m.group(1).lower().replace(" ", "_"), m.group(2))
            rules.append({
                "path": f.relative_to(root).as_posix(),
                "name": headers.get("name", f.stem),
                "category": headers.get("category"),
                "applies_to": headers.get("applies_to"),
                "lines": text.count("\n") + 1,
                "has_comment_format": bool(FORMAT_RE.search(text)),
            })
    return rules


def collect(root: Path, base: str | None) -> dict:
    top = try_git(root, "rev-parse", "--show-toplevel")
    if not top:
        return {"status": "error", "reason": f"{root} is not a git repository"}
    root = Path(top)
    base = base or default_base(root)
    if not base:
        return {"status": "error", "reason": "no default branch found; pass --base <ref>"}
    merge_base = try_git(root, "merge-base", "HEAD", base)
    if not merge_base:
        return {"status": "error", "reason": f"no merge-base between HEAD and {base}"}
    return {
        "status": "ok",
        "project_root": root.as_posix(),
        "branch": try_git(root, "branch", "--show-current") or "detached",
        "base_ref": base,
        "merge_base": merge_base,
        "changed_files": changed_files(root, merge_base),
        "rules": rule_files(root),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project-root", default=".", help="repository to review (default: cwd)")
    ap.add_argument("--base", help="ref to diff against (default: the default branch)")
    args = ap.parse_args()
    result = collect(Path(args.project_root).resolve(), args.base)
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "ok" else 2


if __name__ == "__main__":
    sys.exit(main())
