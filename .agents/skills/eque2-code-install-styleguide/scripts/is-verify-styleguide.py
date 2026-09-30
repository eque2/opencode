#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
is-verify-styleguide.py — Mechanical verifier for installed styleguide files.

Used by Stage 3 of the install-styleguide workflow. Runs mechanical checks
against a dev-standards file, a review-rules file, and an optional
coding-standards file, then emits a structured JSON report.

Checks for dev-standards file:
  1. frontmatter_present   — file starts with frontmatter containing Tech:,
                             Version:, Source:, Last Updated:
  2. severity_tags         — file contains at least one of [CRITICAL],
                             [IMPORTANT], [RECOMMENDED]
  3. no_anti_patterns      — file does NOT contain (AVOID)
  4. no_pr_comment_section — file does NOT contain a "PR Review Comment Format"
                             section heading
  5. line_count            — line count in range 200–400
  6. linter_reference      — file contains at least one linter reference

Checks for review-rules file:
  1. frontmatter_present       — file starts with frontmatter containing Name:,
                                 Source:, Last Updated:
  2. pr_comment_format_present — file contains a "PR Review Comment Format"
                                 section heading
  3. rule_ids_present          — file contains at least one rule ID matching
                                 [A-Z]+-\\d+
  4. anti_patterns_present     — file DOES contain (AVOID) examples
  5. line_count                — line count in range 400–800
  6. linter_reference          — file contains at least one linter reference

Checks for coding-standards file (optional):
  1. rule_id_format       — contains rule IDs matching CS-\\d{2}-\\d{2}
  2. no_anti_patterns     — does NOT contain (AVOID)
  3. no_project_specifics — does NOT reference specific project libraries or
                            src/ paths (best-effort heuristic)

Usage:
    uv run is-verify-styleguide.py \\
        --dev-standards docs/CLAUDE/code-standards/typescript.md \\
        --review-rules .github/review-rules/typescript.md

    uv run is-verify-styleguide.py \\
        --dev-standards docs/CLAUDE/code-standards/typescript.md \\
        --review-rules .github/review-rules/typescript.md \\
        --coding-standards docs/CLAUDE/code-standards/typescript-company.md \\
        --pretty

Exit code is 0 (always) — caller inspects `status` from the JSON output to
decide whether to proceed.
"""

import argparse
import json
import re
import sys
from pathlib import Path


# Linter names considered valid references.
LINTER_PATTERNS = [
    re.compile(r"\beslint\b", re.IGNORECASE),
    re.compile(r"\bprettier\b", re.IGNORECASE),
    re.compile(r"\brubocop\b", re.IGNORECASE),
    re.compile(r"\bruff\b", re.IGNORECASE),
    re.compile(r"\bflake8\b", re.IGNORECASE),
    re.compile(r"\bpylint\b", re.IGNORECASE),
    re.compile(r"\bmypy\b", re.IGNORECASE),
    re.compile(r"\bstyleint\b", re.IGNORECASE),
    re.compile(r"\bcheckstyle\b", re.IGNORECASE),
    re.compile(r"\bswiftlint\b", re.IGNORECASE),
    re.compile(r"\bdetekt\b", re.IGNORECASE),
    re.compile(r"\bphpcs\b", re.IGNORECASE),
    re.compile(r"\bgolangci\b", re.IGNORECASE),
    re.compile(r"\bclang-tidy\b", re.IGNORECASE),
    re.compile(r"\bbiome\b", re.IGNORECASE),
    re.compile(r"\boxc\b", re.IGNORECASE),
]

FRONTMATTER_RE = re.compile(r"^---\s*$", re.MULTILINE)
PR_COMMENT_SECTION_RE = re.compile(
    r"^#{1,6}\s+.*PR\s+Review\s+Comment\s+Format", re.MULTILINE | re.IGNORECASE
)
RULE_ID_RE = re.compile(r"\b[A-Z]+-\d+\b")
CS_RULE_ID_RE = re.compile(r"\bCS-\d{2}-\d{2}\b")
IMPORT_RE = re.compile(r"^\s*(import|from)\s+\S", re.MULTILINE)
SRC_PATH_RE = re.compile(r"\.\s*/src/")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _has_linter_reference(text: str) -> bool:
    return any(pat.search(text) for pat in LINTER_PATTERNS)


def _frontmatter_fields(text: str) -> set[str]:
    """Return the set of field names present in the YAML frontmatter block."""
    stripped = text.lstrip("﻿").lstrip()
    if not stripped.startswith("---"):
        return set()
    body = stripped[3:]
    nl_idx = body.find("\n")
    if nl_idx < 0:
        return set()
    body = body[nl_idx + 1:]
    closing = re.search(r"^---\s*$", body, re.MULTILINE)
    if not closing:
        return set()
    fm_text = body[: closing.start()]
    fields: set[str] = set()
    for raw in fm_text.splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#") or ":" not in line:
            continue
        key, _, _ = line.partition(":")
        fields.add(key.strip())
    return fields


def _check_result(passed: bool, **extra) -> dict:
    result: dict = {"passed": passed}
    result.update(extra)
    return result


# ---------------------------------------------------------------------------
# dev-standards checks
# ---------------------------------------------------------------------------

_DS_REQUIRED_FRONTMATTER = {"Tech", "Version", "Source", "Last Updated"}
_DS_LINE_RANGE = (200, 400)


def check_dev_standards(path: Path) -> dict:
    text = _read(path)
    lines = text.splitlines()
    line_count = len(lines)
    checks: dict[str, dict] = {}
    failures: list[str] = []

    # frontmatter_present
    fields = _frontmatter_fields(text)
    missing_fields = _DS_REQUIRED_FRONTMATTER - fields
    passed = len(missing_fields) == 0
    checks["frontmatter_present"] = _check_result(
        passed,
        **({} if passed else {"missing_fields": sorted(missing_fields)}),
    )
    if not passed:
        failures.append("frontmatter_present")

    # severity_tags
    severity_re = re.compile(r"\[(CRITICAL|IMPORTANT|RECOMMENDED)\]")
    passed = bool(severity_re.search(text))
    checks["severity_tags"] = _check_result(passed)
    if not passed:
        failures.append("severity_tags")

    # no_anti_patterns
    passed = "(AVOID)" not in text
    checks["no_anti_patterns"] = _check_result(passed)
    if not passed:
        failures.append("no_anti_patterns")

    # no_pr_comment_section
    passed = not bool(PR_COMMENT_SECTION_RE.search(text))
    checks["no_pr_comment_section"] = _check_result(passed)
    if not passed:
        failures.append("no_pr_comment_section")

    # line_count
    lo, hi = _DS_LINE_RANGE
    passed = lo <= line_count <= hi
    checks["line_count"] = _check_result(passed, count=line_count, range=list(_DS_LINE_RANGE))
    if not passed:
        failures.append("line_count")

    # linter_reference
    passed = _has_linter_reference(text)
    checks["linter_reference"] = _check_result(passed)
    if not passed:
        failures.append("linter_reference")

    return {
        "file": str(path),
        "checks": checks,
        "passed": len(failures) == 0,
        "failures": failures,
    }


# ---------------------------------------------------------------------------
# review-rules checks
# ---------------------------------------------------------------------------

_RR_REQUIRED_FRONTMATTER = {"Name", "Source", "Last Updated"}
_RR_LINE_RANGE = (400, 800)


def check_review_rules(path: Path) -> dict:
    text = _read(path)
    lines = text.splitlines()
    line_count = len(lines)
    checks: dict[str, dict] = {}
    failures: list[str] = []

    # frontmatter_present
    fields = _frontmatter_fields(text)
    missing_fields = _RR_REQUIRED_FRONTMATTER - fields
    passed = len(missing_fields) == 0
    checks["frontmatter_present"] = _check_result(
        passed,
        **({} if passed else {"missing_fields": sorted(missing_fields)}),
    )
    if not passed:
        failures.append("frontmatter_present")

    # pr_comment_format_present
    passed = bool(PR_COMMENT_SECTION_RE.search(text))
    checks["pr_comment_format_present"] = _check_result(passed)
    if not passed:
        failures.append("pr_comment_format_present")

    # rule_ids_present
    passed = bool(RULE_ID_RE.search(text))
    checks["rule_ids_present"] = _check_result(passed)
    if not passed:
        failures.append("rule_ids_present")

    # anti_patterns_present — required in review rules
    passed = "(AVOID)" in text
    checks["anti_patterns_present"] = _check_result(passed)
    if not passed:
        failures.append("anti_patterns_present")

    # line_count
    lo, hi = _RR_LINE_RANGE
    passed = lo <= line_count <= hi
    checks["line_count"] = _check_result(passed, count=line_count, range=list(_RR_LINE_RANGE))
    if not passed:
        failures.append("line_count")

    # linter_reference
    passed = _has_linter_reference(text)
    checks["linter_reference"] = _check_result(passed)
    if not passed:
        failures.append("linter_reference")

    return {
        "file": str(path),
        "checks": checks,
        "passed": len(failures) == 0,
        "failures": failures,
    }


# ---------------------------------------------------------------------------
# coding-standards checks (optional)
# ---------------------------------------------------------------------------


def check_coding_standards(path: Path) -> dict:
    text = _read(path)
    checks: dict[str, dict] = {}
    failures: list[str] = []

    # rule_id_format
    passed = bool(CS_RULE_ID_RE.search(text))
    checks["rule_id_format"] = _check_result(passed)
    if not passed:
        failures.append("rule_id_format")

    # no_anti_patterns
    passed = "(AVOID)" not in text
    checks["no_anti_patterns"] = _check_result(passed)
    if not passed:
        failures.append("no_anti_patterns")

    # no_project_specifics — heuristic: import statements or ./src/ paths
    has_import = bool(IMPORT_RE.search(text))
    has_src_path = bool(SRC_PATH_RE.search(text))
    passed = not (has_import or has_src_path)
    checks["no_project_specifics"] = _check_result(
        passed,
        **({} if passed else {
            "has_import_statements": has_import,
            "has_src_paths": has_src_path,
        }),
    )
    if not passed:
        failures.append("no_project_specifics")

    return {
        "file": str(path),
        "checks": checks,
        "passed": len(failures) == 0,
        "failures": failures,
    }


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def run(args: argparse.Namespace) -> dict:
    result: dict = {}
    overall_ok = True

    dev_standards_path = Path(args.dev_standards).resolve()
    review_rules_path = Path(args.review_rules).resolve()

    if not dev_standards_path.exists():
        result["status"] = "failed"
        result["error"] = f"--dev-standards path does not exist: {dev_standards_path}"
        return result

    if not review_rules_path.exists():
        result["status"] = "failed"
        result["error"] = f"--review-rules path does not exist: {review_rules_path}"
        return result

    ds = check_dev_standards(dev_standards_path)
    result["dev_standards"] = ds
    if not ds["passed"]:
        overall_ok = False

    rr = check_review_rules(review_rules_path)
    result["review_rules"] = rr
    if not rr["passed"]:
        overall_ok = False

    if args.coding_standards:
        cs_path = Path(args.coding_standards).resolve()
        if not cs_path.exists():
            result["status"] = "failed"
            result["error"] = f"--coding-standards path does not exist: {cs_path}"
            return result
        cs = check_coding_standards(cs_path)
        result["coding_standards"] = cs
        if not cs["passed"]:
            overall_ok = False

    result["status"] = "ok" if overall_ok else "failed"
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Run mechanical verification checks against installed styleguide files. "
            "Emits structured JSON; never exits non-zero."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  uv run is-verify-styleguide.py \\\n"
            "      --dev-standards docs/CLAUDE/code-standards/typescript.md \\\n"
            "      --review-rules .github/review-rules/typescript.md\n\n"
            "  uv run is-verify-styleguide.py \\\n"
            "      --dev-standards docs/CLAUDE/code-standards/typescript.md \\\n"
            "      --review-rules .github/review-rules/typescript.md \\\n"
            "      --coding-standards docs/CLAUDE/code-standards/typescript-company.md \\\n"
            "      --pretty\n"
        ),
    )
    parser.add_argument(
        "--dev-standards",
        required=True,
        metavar="PATH",
        help="Path to the installed dev-standards file.",
    )
    parser.add_argument(
        "--review-rules",
        required=True,
        metavar="PATH",
        help="Path to the installed review-rules file.",
    )
    parser.add_argument(
        "--coding-standards",
        metavar="PATH",
        default=None,
        help="Optional path to the installed coding-standards file.",
    )
    parser.add_argument(
        "-o", "--output",
        metavar="FILE",
        default=None,
        help="Write JSON to FILE instead of stdout.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output.",
    )
    args = parser.parse_args()

    result = run(args)
    output = json.dumps(result, indent=2) if args.pretty else json.dumps(result)

    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
    else:
        print(output)

    return 0


if __name__ == "__main__":
    sys.exit(main())
