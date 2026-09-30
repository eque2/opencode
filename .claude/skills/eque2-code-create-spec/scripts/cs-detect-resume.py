#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
cs-detect-resume.py — Stage 1 target / resume detector for the create-spec workflow.

Scans `{feature_artifacts}/` for existing feature folders, parses YAML frontmatter
from any `spec.md` present, and recommends one of:

  - `new`        — no spec.md present (fresh feature)
  - `resume`     — spec.md present, status=in-progress, stepsCompleted non-empty
  - `restart`    — spec.md present, status=ready-for-build (work is done; user
                   must explicitly choose to start over)
  - `unresolved` — ambiguous: multiple candidates or zero candidates and no
                   target was specified

The script is deterministic — no LLM cycles. It reports structured JSON on
stdout and exits 0 unless an unexpected internal error occurs.

Usage:
    uv run cs-detect-resume.py <feature_artifacts_root> [<TICKET-KEY-or-slug>]
    uv run cs-detect-resume.py <feature_artifacts_root> --pretty --verbose
"""

import argparse
import json
import re
import sys
from pathlib import Path


# Hardcoded mapping from stage number to the corresponding stage prompt file.
# Used to derive `next_stage_file` from a spec.md's `stepsCompleted` list.
STAGE_FILES = {
    1: "01-target.md",
    2: "02-load-artifacts.md",
    3: "03-investigate.md",
    4: "04-web-research.md",
    5: "05-coverage-model.md",
    6: "06-gherkin.md",
    7: "07-tasks.md",
    8: "08-review.md",
    9: "09-fix-reemit.md",
    10: "10-state-gen.md",
}

# Status values we treat as "work is finished — don't silently resume".
TERMINAL_STATUSES = {"ready-for-build", "complete", "completed", "done"}


def parse_frontmatter(spec_path: Path) -> dict:
    """Extract the YAML frontmatter from a spec.md.

    Returns a dict with the keys we care about: stepsCompleted (list[int]),
    status (str|None), specSlug (str|None), title (str|None).

    Tolerant of missing / malformed files — returns an empty-ish dict and
    lets the caller decide what that means.
    """
    result: dict = {
        "stepsCompleted": [],
        "status": None,
        "specSlug": None,
        "title": None,
    }

    if not spec_path.exists() or not spec_path.is_file():
        return result

    try:
        text = spec_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return result

    # Frontmatter is delimited by --- on its own line at the start of the file.
    # We accept a leading BOM or whitespace before the first delimiter.
    stripped = text.lstrip("﻿").lstrip()
    if not stripped.startswith("---"):
        return result

    # Slice off the leading '---' line, then find the closing '---'.
    body = stripped[3:]
    # Skip the rest of that first line (could be '---\n' or '---\r\n').
    nl_idx = body.find("\n")
    if nl_idx < 0:
        return result
    body = body[nl_idx + 1:]

    closing_match = re.search(r"^---\s*$", body, re.MULTILINE)
    if not closing_match:
        return result
    frontmatter_text = body[: closing_match.start()]

    for raw_line in frontmatter_text.splitlines():
        line = raw_line.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        # Strip surrounding quotes.
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]

        if key == "stepsCompleted":
            result["stepsCompleted"] = _parse_int_list(value)
        elif key == "status":
            result["status"] = value or None
        elif key == "specSlug":
            result["specSlug"] = value or None
        elif key == "title":
            result["title"] = value or None

    return result


def _parse_int_list(value: str) -> list[int]:
    """Parse a simple YAML inline list of integers like '[1, 2, 3]' or '[]'."""
    value = value.strip()
    if not value or value in ("[]", "~", "null"):
        return []
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        parts = [p.strip() for p in inner.split(",")]
        out: list[int] = []
        for p in parts:
            if not p:
                continue
            try:
                out.append(int(p))
            except ValueError:
                # Skip non-integer items rather than abort — frontmatter may
                # have been edited by hand.
                continue
        return out
    # Unsupported shape (e.g. block list). Treat as empty.
    return []


def derive_next_stage_file(steps_completed: list[int]) -> str | None:
    """Pick the stage prompt file to jump to based on completed steps.

    Returns None when the spec has run through all 10 stages — the caller is
    expected to surface this as 'restart' (the spec is done; further work
    needs [RS] or [CS] --amend, not a stage re-run).
    """
    if not steps_completed:
        return STAGE_FILES[1]
    next_step = max(steps_completed) + 1
    if next_step > 10:
        return None
    return STAGE_FILES[next_step]


def scan_feature_folders(root: Path) -> list[dict]:
    """Enumerate child directories of `root`, summarising each.

    Returns one entry per directory:
        {
          "feature_id": str,          # directory name
          "path": str,
          "has_spec": bool,
          "has_jira": bool,
          "frontmatter": dict,        # from parse_frontmatter
        }
    """
    candidates: list[dict] = []
    if not root.exists() or not root.is_dir():
        return candidates

    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        if not entry.is_dir():
            continue
        # Ignore archived / hidden folders.
        if entry.name.startswith(".") or ".archived-" in entry.name:
            continue
        spec_path = entry / "spec.md"
        jira_path = entry / "jira"
        candidates.append({
            "feature_id": entry.name,
            "path": str(entry),
            "has_spec": spec_path.is_file(),
            "has_jira": jira_path.is_dir(),
            "frontmatter": parse_frontmatter(spec_path),
        })
    return candidates


def recommend_for_folder(folder: dict) -> str:
    """Return 'new' / 'resume' / 'restart' for a single feature folder summary."""
    if not folder["has_spec"]:
        return "new"
    fm = folder["frontmatter"]
    status = (fm.get("status") or "").lower()
    if status in TERMINAL_STATUSES:
        return "restart"
    if fm.get("stepsCompleted"):
        return "resume"
    # spec.md exists but stepsCompleted is empty — treat as resume-from-zero
    # so the user keeps any title / scope work already captured.
    return "resume"


def build_result_for_folder(folder: dict, ticket_key_hint: str | None) -> dict:
    """Compose the JSON result for a single resolved feature folder."""
    fm = folder["frontmatter"]
    steps = list(fm.get("stepsCompleted") or [])
    recommendation = recommend_for_folder(folder)
    # 'restart' means user must explicitly opt in — we still report the
    # next-stage as Stage 1 so a fresh run begins from the top.
    if recommendation in ("new", "restart"):
        next_stage = STAGE_FILES[1]
    else:
        next_stage = derive_next_stage_file(steps)

    feature_id = folder["feature_id"]
    return {
        "status": "ok",
        "recommendation": recommendation,
        "feature_id": feature_id,
        "ticket_key": ticket_key_hint or fm.get("specSlug") or feature_id,
        "spec_path": str(Path(folder["path"]) / "spec.md") if folder["has_spec"] else None,
        "stepsCompleted": steps,
        "next_stage_file": next_stage,
        "candidates": [],
    }


def resolve_target(root: Path, target: str | None) -> dict:
    """Top-level resolution.

    If `target` is supplied, look for that folder specifically (regardless of
    whether it exists yet — if not, recommend 'new').

    If `target` is None: scan everything. If exactly one folder has a `jira/`
    sub-folder but no `spec.md`, auto-pick it. Otherwise return 'unresolved'
    with the candidate list so the caller can prompt the user.
    """
    folders = scan_feature_folders(root)

    if target:
        # Look for the named folder among the candidates first.
        for folder in folders:
            if folder["feature_id"] == target:
                return build_result_for_folder(folder, target)
        # Not found — proposed as a brand new feature.
        return {
            "status": "ok",
            "recommendation": "new",
            "feature_id": target,
            "ticket_key": target,
            "spec_path": None,
            "stepsCompleted": [],
            "next_stage_file": STAGE_FILES[1],
            "candidates": [],
        }

    # No target supplied — auto-detect if possible.
    jira_without_spec = [f for f in folders if f["has_jira"] and not f["has_spec"]]
    if len(jira_without_spec) == 1:
        return build_result_for_folder(jira_without_spec[0], None)

    # Ambiguous (zero or >1) — surface the candidate list for the caller.
    return {
        "status": "unresolved",
        "recommendation": "unresolved",
        "feature_id": None,
        "ticket_key": None,
        "spec_path": None,
        "stepsCompleted": [],
        "next_stage_file": STAGE_FILES[1],
        "candidates": [
            {
                "feature_id": f["feature_id"],
                "has_spec": f["has_spec"],
                "has_jira": f["has_jira"],
                "status": (f["frontmatter"].get("status") or None),
                "stepsCompleted": list(f["frontmatter"].get("stepsCompleted") or []),
                "recommendation": recommend_for_folder(f),
            }
            for f in folders
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Scan a feature_artifacts root and recommend new/resume/restart "
            "for the create-spec workflow. Outputs structured JSON on stdout."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  uv run cs-detect-resume.py docs/features\n"
            "  uv run cs-detect-resume.py docs/features PROJ-123 --pretty\n"
        ),
    )
    parser.add_argument(
        "feature_artifacts_root",
        help="Directory containing one sub-folder per feature (e.g. docs/features/).",
    )
    parser.add_argument(
        "target",
        nargs="?",
        default=None,
        help="Optional ticket key or slug — the specific feature folder name to resolve.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output (human-readable). Default is single-line JSON.",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Write progress diagnostics to stderr.",
    )
    args = parser.parse_args()

    root = Path(args.feature_artifacts_root).resolve()

    if args.verbose:
        print(f"feature_artifacts_root: {root}", file=sys.stderr)
        print(f"target:                 {args.target!r}", file=sys.stderr)

    result = resolve_target(root, args.target)

    if args.pretty:
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(result))

    if args.verbose:
        print(
            f"recommendation: {result['recommendation']} "
            f"(feature_id={result['feature_id']!r})",
            file=sys.stderr,
        )
        if result["status"] == "unresolved":
            print(
                f"candidates: {len(result['candidates'])}",
                file=sys.stderr,
            )

    return 0


if __name__ == "__main__":
    sys.exit(main())
