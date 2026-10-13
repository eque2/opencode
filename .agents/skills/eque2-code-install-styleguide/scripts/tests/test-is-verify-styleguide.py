#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Smoke tests for is-verify-styleguide.py.

Covers:
- Happy path: well-formed dev-standards passes all checks.
- Line count out of range → line_count fails for dev-standards.
- Happy path: well-formed review-rules passes all checks.
- review-rules missing (AVOID) → anti_patterns_present fails.
- dev-standards containing (AVOID) → no_anti_patterns fails.
- dev-standards with PR Review Comment Format section → no_pr_comment_section fails.
- dev-standards missing severity tags → severity_tags fails.
- dev-standards missing frontmatter fields → frontmatter_present fails.
- Optional coding-standards: passing file.
- Optional coding-standards: file with (AVOID) → no_anti_patterns fails.
- Optional coding-standards: file without CS-XX-XX IDs → rule_id_format fails.
- -o / --output flag writes to file.
- --pretty flag produces indented JSON.
- --help works.

Run:
    uv run scripts/tests/test-is-verify-styleguide.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent.resolve()
SCRIPT = SCRIPT_DIR.parent / "is-verify-styleguide.py"

# ---------------------------------------------------------------------------
# Fixture content
# ---------------------------------------------------------------------------

# A dev-standards file that satisfies all checks (line count 200-400,
# has frontmatter, severity tags, no AVOID, no PR comment section, linter ref).
_DS_FRONTMATTER = """\
---
Tech: TypeScript
Version: 1.0
Source: https://example.com/ts-standards
Last Updated: 2025-01-01
---
"""

_DS_BODY_LINE = "- Use `const` over `let` where possible. [IMPORTANT]\n"
_DS_LINTER_LINE = "Enforce with eslint rule `prefer-const`.\n"


def _make_dev_standards(
    tmp: Path,
    *,
    filename: str = "dev-standards.md",
    frontmatter: str = _DS_FRONTMATTER,
    body_line: str = _DS_BODY_LINE,
    linter_line: str = _DS_LINTER_LINE,
    extra_lines: int = 0,
    line_count_target: int = 250,
) -> Path:
    """Write a dev-standards file with the given attributes to tmp/."""
    path = tmp / filename
    content = frontmatter + body_line + linter_line
    # Pad or trim to hit the requested line count.
    current = len(content.splitlines())
    pad = max(0, line_count_target - current + extra_lines)
    content += "# rule\n" * pad
    path.write_text(content, encoding="utf-8")
    return path


# A review-rules file that satisfies all checks (line count 400-800).
_RR_FRONTMATTER = """\
---
Name: TypeScript Review Rules
Source: https://example.com/ts-review
Last Updated: 2025-01-01
---
"""

_RR_PR_COMMENT_SECTION = "\n## PR Review Comment Format\n\nFormat comments as follows.\n"
_RR_RULE_LINE = "TS-001: Do not use `any`.\n"
_RR_AVOID_LINE = "Bad: `const x: any = foo;` (AVOID)\n"
_RR_LINTER_LINE = "Enforce with eslint rule `no-explicit-any`.\n"


def _make_review_rules(
    tmp: Path,
    *,
    filename: str = "review-rules.md",
    frontmatter: str = _RR_FRONTMATTER,
    pr_section: str = _RR_PR_COMMENT_SECTION,
    rule_line: str = _RR_RULE_LINE,
    avoid_line: str = _RR_AVOID_LINE,
    linter_line: str = _RR_LINTER_LINE,
    line_count_target: int = 500,
) -> Path:
    path = tmp / filename
    content = frontmatter + pr_section + rule_line + avoid_line + linter_line
    current = len(content.splitlines())
    pad = max(0, line_count_target - current)
    content += "# rule\n" * pad
    path.write_text(content, encoding="utf-8")
    return path


def _make_coding_standards(
    tmp: Path,
    *,
    filename: str = "coding-standards.md",
    include_rule_ids: bool = True,
    include_avoid: bool = False,
    include_imports: bool = False,
) -> Path:
    path = tmp / filename
    lines = ["# Coding Standards\n\n"]
    if include_rule_ids:
        lines.append("## CS-01-01: Naming conventions\n\nUse camelCase for variables.\n\n")
    if include_avoid:
        lines.append("Bad pattern: do this instead (AVOID)\n")
    if include_imports:
        lines.append("import React from 'react'\n")
    path.write_text("".join(lines), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Runner helper
# ---------------------------------------------------------------------------


def _run(
    dev_standards: Path,
    review_rules: Path,
    *,
    coding_standards: Path | None = None,
    extra_args: list[str] | None = None,
) -> dict:
    cmd = [
        sys.executable,
        str(SCRIPT),
        "--dev-standards", str(dev_standards),
        "--review-rules", str(review_rules),
    ]
    if coding_standards:
        cmd += ["--coding-standards", str(coding_standards)]
    if extra_args:
        cmd += extra_args
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_dev_standards_happy_path():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = _make_dev_standards(tmp)
        rr = _make_review_rules(tmp)
        result = _run(ds, rr)
        assert result["status"] == "ok", result
        assert result["dev_standards"]["passed"] is True, result["dev_standards"]
        assert result["dev_standards"]["failures"] == []


def test_dev_standards_line_count_too_short():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = _make_dev_standards(tmp, line_count_target=50)
        rr = _make_review_rules(tmp)
        result = _run(ds, rr)
        assert result["status"] == "failed"
        ds_result = result["dev_standards"]
        assert ds_result["passed"] is False
        assert "line_count" in ds_result["failures"]
        assert ds_result["checks"]["line_count"]["passed"] is False


def test_dev_standards_line_count_too_long():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = _make_dev_standards(tmp, line_count_target=450)
        rr = _make_review_rules(tmp)
        result = _run(ds, rr)
        assert result["status"] == "failed"
        ds_result = result["dev_standards"]
        assert ds_result["passed"] is False
        assert "line_count" in ds_result["failures"]


def test_dev_standards_avoid_fails():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        # Inject an (AVOID) string into the dev-standards body.
        ds = _make_dev_standards(tmp, body_line="- Never do this (AVOID)\n")
        rr = _make_review_rules(tmp)
        result = _run(ds, rr)
        assert result["status"] == "failed"
        ds_result = result["dev_standards"]
        assert "no_anti_patterns" in ds_result["failures"]
        assert ds_result["checks"]["no_anti_patterns"]["passed"] is False


def test_dev_standards_pr_section_fails():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = _make_dev_standards(
            tmp,
            body_line=_DS_BODY_LINE + "\n## PR Review Comment Format\n\nSome content.\n",
        )
        rr = _make_review_rules(tmp)
        result = _run(ds, rr)
        assert result["status"] == "failed"
        assert "no_pr_comment_section" in result["dev_standards"]["failures"]


def test_dev_standards_missing_severity_tags():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        # body_line has no [CRITICAL], [IMPORTANT], [RECOMMENDED]
        ds = _make_dev_standards(tmp, body_line="- Use const where possible.\n")
        rr = _make_review_rules(tmp)
        result = _run(ds, rr)
        assert result["status"] == "failed"
        assert "severity_tags" in result["dev_standards"]["failures"]


def test_dev_standards_missing_frontmatter_fields():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        # Omit Version and Source from frontmatter.
        partial_fm = "---\nTech: TypeScript\nLast Updated: 2025-01-01\n---\n"
        ds = _make_dev_standards(tmp, frontmatter=partial_fm)
        rr = _make_review_rules(tmp)
        result = _run(ds, rr)
        assert result["status"] == "failed"
        fm_check = result["dev_standards"]["checks"]["frontmatter_present"]
        assert fm_check["passed"] is False
        assert "missing_fields" in fm_check
        assert set(fm_check["missing_fields"]) >= {"Version", "Source"}


def test_review_rules_happy_path():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = _make_dev_standards(tmp)
        rr = _make_review_rules(tmp)
        result = _run(ds, rr)
        assert result["status"] == "ok", result
        assert result["review_rules"]["passed"] is True, result["review_rules"]
        assert result["review_rules"]["failures"] == []


def test_review_rules_missing_avoid_fails():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = _make_dev_standards(tmp)
        # Omit the (AVOID) line.
        rr = _make_review_rules(tmp, avoid_line="")
        result = _run(ds, rr)
        assert result["status"] == "failed"
        assert "anti_patterns_present" in result["review_rules"]["failures"]
        assert result["review_rules"]["checks"]["anti_patterns_present"]["passed"] is False


def test_review_rules_missing_pr_section_fails():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = _make_dev_standards(tmp)
        rr = _make_review_rules(tmp, pr_section="")
        result = _run(ds, rr)
        assert result["status"] == "failed"
        assert "pr_comment_format_present" in result["review_rules"]["failures"]


def test_review_rules_missing_rule_ids_fails():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = _make_dev_standards(tmp)
        # Remove the rule ID line so no [A-Z]+-\d+ match exists.
        rr = _make_review_rules(tmp, rule_line="Do not use any.\n")
        # But (AVOID) is still present, so only rule_ids_present should fail.
        result = _run(ds, rr)
        assert result["status"] == "failed"
        assert "rule_ids_present" in result["review_rules"]["failures"]


def test_coding_standards_happy_path():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = _make_dev_standards(tmp)
        rr = _make_review_rules(tmp)
        cs = _make_coding_standards(tmp)
        result = _run(ds, rr, coding_standards=cs)
        assert result["status"] == "ok", result
        assert "coding_standards" in result
        assert result["coding_standards"]["passed"] is True
        assert result["coding_standards"]["failures"] == []


def test_coding_standards_avoid_fails():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = _make_dev_standards(tmp)
        rr = _make_review_rules(tmp)
        cs = _make_coding_standards(tmp, include_avoid=True)
        result = _run(ds, rr, coding_standards=cs)
        assert result["status"] == "failed"
        assert "no_anti_patterns" in result["coding_standards"]["failures"]


def test_coding_standards_missing_rule_ids_fails():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = _make_dev_standards(tmp)
        rr = _make_review_rules(tmp)
        cs = _make_coding_standards(tmp, include_rule_ids=False)
        result = _run(ds, rr, coding_standards=cs)
        assert result["status"] == "failed"
        assert "rule_id_format" in result["coding_standards"]["failures"]


def test_coding_standards_absent_when_not_passed():
    """When --coding-standards is not given, the key should be absent from output."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = _make_dev_standards(tmp)
        rr = _make_review_rules(tmp)
        result = _run(ds, rr)
        assert "coding_standards" not in result


def test_output_flag_writes_file():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = _make_dev_standards(tmp)
        rr = _make_review_rules(tmp)
        out_file = tmp / "result.json"
        cmd = [
            sys.executable,
            str(SCRIPT),
            "--dev-standards", str(ds),
            "--review-rules", str(rr),
            "-o", str(out_file),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
        # Nothing on stdout.
        assert proc.stdout.strip() == ""
        assert out_file.exists()
        data = json.loads(out_file.read_text())
        assert "status" in data


def test_pretty_flag_produces_indented_json():
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = _make_dev_standards(tmp)
        rr = _make_review_rules(tmp)
        cmd = [
            sys.executable,
            str(SCRIPT),
            "--dev-standards", str(ds),
            "--review-rules", str(rr),
            "--pretty",
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
        # Pretty output contains newlines beyond the terminating one.
        assert proc.stdout.count("\n") > 5


def test_help_flag():
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--help"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "--dev-standards" in result.stdout
    assert "--review-rules" in result.stdout


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    tests = [
        ("dev-standards happy path", test_dev_standards_happy_path),
        ("dev-standards line count too short", test_dev_standards_line_count_too_short),
        ("dev-standards line count too long", test_dev_standards_line_count_too_long),
        ("dev-standards (AVOID) fails no_anti_patterns", test_dev_standards_avoid_fails),
        ("dev-standards PR section fails no_pr_comment_section", test_dev_standards_pr_section_fails),
        ("dev-standards missing severity tags", test_dev_standards_missing_severity_tags),
        ("dev-standards missing frontmatter fields", test_dev_standards_missing_frontmatter_fields),
        ("review-rules happy path", test_review_rules_happy_path),
        ("review-rules missing (AVOID) fails anti_patterns_present", test_review_rules_missing_avoid_fails),
        ("review-rules missing PR section fails pr_comment_format_present", test_review_rules_missing_pr_section_fails),
        ("review-rules missing rule IDs fails rule_ids_present", test_review_rules_missing_rule_ids_fails),
        ("coding-standards happy path", test_coding_standards_happy_path),
        ("coding-standards (AVOID) fails no_anti_patterns", test_coding_standards_avoid_fails),
        ("coding-standards missing CS rule IDs fails rule_id_format", test_coding_standards_missing_rule_ids_fails),
        ("coding-standards absent when not passed", test_coding_standards_absent_when_not_passed),
        ("-o flag writes output to file", test_output_flag_writes_file),
        ("--pretty flag produces indented JSON", test_pretty_flag_produces_indented_json),
        ("--help flag", test_help_flag),
    ]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS  {name}")
        except AssertionError as e:
            print(f"  FAIL  {name}: {e}")
            failed += 1
        except Exception as e:
            print(f"  ERROR {name}: {type(e).__name__}: {e}")
            failed += 1

    print()
    print(f"{len(tests) - failed}/{len(tests)} passed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
