#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Smoke tests for cs-readiness-check.py.

Covers:
- Happy path: a fully-formed feature folder passes all 8 checks.
- Missing scenarios.gherkin → Scenarios First fails.
- Task references a non-existent scenario → Tasks Support Scenarios fails.
- Scenario nobody supports → Tasks Support Scenarios fails.
- Task missing Tests line → Testable fails.
- Task missing File / non-verb description → Actionable fails.
- Placeholder tokens (TBD, {...}) in content files → Complete fails.
- Missing BUILD-1..4 → Verifiable fails.
- Malformed state JSON snapshot → Verifiable fails.
- --help works.

Run:
    uv run scripts/tests/test-cs-readiness-check.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent.resolve()
SCRIPT = SCRIPT_DIR.parent / "cs-readiness-check.py"


def _run(feature_root: Path) -> dict:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(feature_root)],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


GOOD_SPEC = """---
title: "Test feature"
specSlug: "PROJ-42"
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8, 9]
status: in-progress
---
# Feature: Test
"""

GOOD_CONTEXT = """# Context

## Files to modify

| Path | Action | Why |
|------|--------|-----|
| `src/app.ts` | UPDATE | Wire up the new handler |
"""

GOOD_COVERAGE = """# Coverage

| Category | Min | Scenarios |
|----------|-----|-----------|
| Build & Quality | 4 | BUILD-1, BUILD-2, BUILD-3, BUILD-4 |
| Core Outcome | 2 | S1, S2 |
"""

GOOD_SCENARIOS = """# Scenarios

@build
Scenario: BUILD-1 Lint passes
  Given the codebase
  When I run the linter
  Then there are no lint errors

@build
Scenario: BUILD-2 Type check passes
  Given the codebase
  When I run the type checker
  Then there are no type errors

@build
Scenario: BUILD-3 Build succeeds
  Given the codebase
  When I run the build
  Then it completes

@build
Scenario: BUILD-4 Tests pass
  Given the codebase
  When I run tests
  Then they pass

Scenario: S1 Happy path
  Given a user
  When they trigger the action
  Then it succeeds

Scenario: S2 Error path
  Given a broken input
  When they trigger the action
  Then it fails cleanly
"""

GOOD_TASKS = """# Tasks: PROJ-42

## Task List

| ID | Name | Status | Supports | Dependencies |
|----|------|--------|----------|--------------|
| T1 | Wire up | pending | S1, S2 | — |

## Task Details

### T1.1: Add handler module

**Goal:** Add the new handler module wiring.

**File:** `src/app.ts`

**Tests:** src/app.spec.ts pattern:happy-path

**Supports:** S1, S2, BUILD-4

**Notes:** Follow coding-standard COD-014.

### T1.2: Update existing service

**File:** `src/app.ts`

**Tests:** src/app.spec.ts pattern:error-path

**Supports:** S1

Update the service to dispatch through the new handler.
"""


def _make_feature(tmp: Path, *, project_root_marker: bool = True) -> Path:
    """Create a fully-passing feature folder under tmp/feature_artifacts/PROJ-42/."""
    project = tmp / "proj"
    project.mkdir(parents=True, exist_ok=True)
    if project_root_marker:
        (project / ".git").mkdir(exist_ok=True)
    # Source file referenced by context.md must exist for Self-Contained to pass.
    src_dir = project / "src"
    src_dir.mkdir(exist_ok=True)
    (src_dir / "app.ts").write_text("// stub\n")

    feature_root = project / "feature_artifacts" / "PROJ-42"
    feature_root.mkdir(parents=True, exist_ok=True)
    (feature_root / "spec.md").write_text(GOOD_SPEC)
    (feature_root / "context.md").write_text(GOOD_CONTEXT)
    (feature_root / "coverage.md").write_text(GOOD_COVERAGE)
    (feature_root / "scenarios.gherkin").write_text(GOOD_SCENARIOS)
    (feature_root / "tasks.md").write_text(GOOD_TASKS)
    return feature_root


def test_happy_path_all_pass():
    with tempfile.TemporaryDirectory() as tmp:
        feature = _make_feature(Path(tmp))
        result = _run(feature)
        # Each check should report passed=True.
        failed_checks = [c for c in result["checks"] if not c["passed"]]
        assert result["status"] == "ok", (
            f"Expected ok, got {result['status']}. Failures: {result['failures']}"
        )
        assert not failed_checks, failed_checks
        assert len(result["failures"]) == 0


def test_missing_scenarios_fails_scenarios_first():
    with tempfile.TemporaryDirectory() as tmp:
        feature = _make_feature(Path(tmp))
        (feature / "scenarios.gherkin").unlink()
        result = _run(feature)
        assert result["status"] == "failed"
        names = {c["name"]: c["passed"] for c in result["checks"]}
        assert names["Scenarios First"] is False


def test_task_references_unknown_scenario():
    with tempfile.TemporaryDirectory() as tmp:
        feature = _make_feature(Path(tmp))
        # Rewrite tasks.md so T1.1 references S99 which doesn't exist.
        tasks = (feature / "tasks.md").read_text().replace(
            "**Supports:** S1, S2, BUILD-4", "**Supports:** S99, BUILD-4"
        )
        (feature / "tasks.md").write_text(tasks)
        result = _run(feature)
        assert result["status"] == "failed"
        # At least one failure mentioning S99.
        assert any("S99" in f["issue"] for f in result["failures"]), result["failures"]


def test_unsupported_scenario_is_flagged():
    with tempfile.TemporaryDirectory() as tmp:
        feature = _make_feature(Path(tmp))
        # Add a stray scenario S99 that no task supports.
        gherkin = (feature / "scenarios.gherkin").read_text()
        gherkin += "\nScenario: S99 Orphan\n  Given x\n  When y\n  Then z\n"
        (feature / "scenarios.gherkin").write_text(gherkin)
        result = _run(feature)
        assert result["status"] == "failed"
        # Failure should call out S99 as unsupported.
        assert any("S99" in f["issue"] and "supported" in f["issue"].lower()
                   for f in result["failures"]), result["failures"]


def test_missing_tests_line_fails_testable():
    with tempfile.TemporaryDirectory() as tmp:
        feature = _make_feature(Path(tmp))
        # Drop the Tests: line from T1.1 only.
        tasks = (feature / "tasks.md").read_text().replace(
            "**Tests:** src/app.spec.ts pattern:happy-path\n\n", ""
        )
        (feature / "tasks.md").write_text(tasks)
        result = _run(feature)
        names = {c["name"]: c["passed"] for c in result["checks"]}
        assert names["Testable"] is False, result


def test_markdown_polluted_pattern_fails_testable():
    # CAP-5(b): a Tests line carrying a markdown artifact (the
    # "(full suite)**Test Cases:**" generation bug) is rejected on content,
    # not just token count.
    with tempfile.TemporaryDirectory() as tmp:
        feature = _make_feature(Path(tmp))
        tasks = (feature / "tasks.md").read_text().replace(
            "**Tests:** src/app.spec.ts pattern:happy-path",
            "**Tests:** src/app.spec.ts (full suite)**Test Cases:**",
        )
        (feature / "tasks.md").write_text(tasks)
        result = _run(feature)
        names = {c["name"]: c["passed"] for c in result["checks"]}
        assert names["Testable"] is False, result
        t_failures = [f for f in result["failures"] if f["check"] == "Testable"]
        assert any("markdown" in f["issue"].lower() for f in t_failures), t_failures


def test_missing_file_or_bad_verb_fails_actionable():
    with tempfile.TemporaryDirectory() as tmp:
        feature = _make_feature(Path(tmp))
        # Rewrite T1.2 with a heading that is NOT an action verb (a noun phrase).
        tasks = (feature / "tasks.md").read_text().replace(
            "### T1.2: Update existing service",
            "### T1.2: Service dispatch refactor",
        )
        (feature / "tasks.md").write_text(tasks)
        result = _run(feature)
        names = {c["name"]: c["passed"] for c in result["checks"]}
        assert names["Actionable"] is False, (
            f"Actionable should fail when heading isn't an action verb. "
            f"Failures: {result['failures']}"
        )
        # Failure should call out T1.2 specifically.
        a_failures = [f for f in result["failures"] if f["check"] == "Actionable"]
        assert any("T1.2" in f["issue"] for f in a_failures), a_failures


def test_placeholder_token_fails_complete():
    with tempfile.TemporaryDirectory() as tmp:
        feature = _make_feature(Path(tmp))
        # Inject a TBD into coverage.md.
        cov = (feature / "coverage.md").read_text() + "\n\nTBD: fill this in.\n"
        (feature / "coverage.md").write_text(cov)
        result = _run(feature)
        names = {c["name"]: c["passed"] for c in result["checks"]}
        assert names["Complete"] is False
        # Should report the right file.
        complete_failures = [f for f in result["failures"] if f["check"] == "Complete"]
        assert any(f["file"] == "coverage.md" for f in complete_failures)


def test_missing_build_scenarios_fails_verifiable():
    with tempfile.TemporaryDirectory() as tmp:
        feature = _make_feature(Path(tmp))
        # Strip BUILD-3 and BUILD-4.
        gherkin = (feature / "scenarios.gherkin").read_text()
        # Remove BUILD-3 + BUILD-4 blocks by cutting on the marker.
        gherkin = gherkin.split("@build\nScenario: BUILD-3")[0]
        gherkin += "\nScenario: S1 Happy path\n  Given a user\n  When they trigger the action\n  Then it succeeds\n"
        gherkin += "\nScenario: S2 Error path\n  Given a broken input\n  When they trigger the action\n  Then it fails cleanly\n"
        (feature / "scenarios.gherkin").write_text(gherkin)
        result = _run(feature)
        names = {c["name"]: c["passed"] for c in result["checks"]}
        assert names["Verifiable"] is False
        # Should flag BUILD-3 and BUILD-4 specifically.
        v_failures = [f for f in result["failures"] if f["check"] == "Verifiable"]
        flagged_ids = {x for f in v_failures for x in ("BUILD-3", "BUILD-4") if x in f["issue"]}
        assert flagged_ids == {"BUILD-3", "BUILD-4"}, v_failures


def test_malformed_state_snapshot_fails_verifiable():
    with tempfile.TemporaryDirectory() as tmp:
        feature = _make_feature(Path(tmp))
        state_dir = feature / "state" / "task"
        state_dir.mkdir(parents=True)
        # Missing $schema, _schemaVersion, _machineVersion, tags root-level fields.
        (state_dir / "T1.json").write_text(json.dumps({
            "value": "not_started",
            "context": {},
            "status": "active",
        }))
        result = _run(feature)
        names = {c["name"]: c["passed"] for c in result["checks"]}
        assert names["Verifiable"] is False
        v_failures = [f for f in result["failures"] if f["check"] == "Verifiable"]
        assert any("missing mandatory root field" in f["issue"] for f in v_failures), v_failures


def test_help_flag():
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--help"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "feature_root" in result.stdout


def test_scenario_id_outside_the_grammar_fails_verifiable():
    with tempfile.TemporaryDirectory() as tmp:
        feature = _make_feature(Path(tmp))
        gherkin = (feature / "scenarios.gherkin").read_text() + (
            "\nScenario: delivery_2 Lowercase id\n  Given a user\n  When they act\n  Then it works\n"
        )
        (feature / "scenarios.gherkin").write_text(gherkin)
        result = _run(feature)
        assert result["status"] == "failed"
        assert any(f["check"] == "Verifiable" and "delivery_2" in f["issue"] for f in result["failures"]), result["failures"]


def test_open_prefix_ids_pass_and_coverage_refs_use_the_grammar():
    with tempfile.TemporaryDirectory() as tmp:
        feature = _make_feature(Path(tmp))
        gherkin = (feature / "scenarios.gherkin").read_text() + (
            "\nScenario: DELIVERY-1 A log entry arrives\n  Given a user\n  When they act\n  Then it works\n"
        )
        (feature / "scenarios.gherkin").write_text(gherkin)
        tasks = (feature / "tasks.md").read_text().replace(
            "**Supports:** S1, S2, BUILD-4", "**Supports:** S1, S2, BUILD-4, DELIVERY-1"
        )
        (feature / "tasks.md").write_text(tasks)
        # Prose tokens that fit the grammar (UTF-8, ISO-27001, A1) are NOT refs:
        # no declared scenario uses their prefix.
        coverage = (feature / "coverage.md").read_text() + (
            "| Delivery | 1 | DELIVERY-1 |\n\nNotes: UTF-8 logs, ISO-27001, assumption A1.b.\n"
        )
        (feature / "coverage.md").write_text(coverage)
        result = _run(feature)
        assert result["status"] == "ok", result["failures"]

        # A DELIVERY- ref that no scenario declares IS flagged.
        (feature / "coverage.md").write_text(coverage + "| Delivery | 1 | DELIVERY-3 |\n")
        result = _run(feature)
        assert any("DELIVERY-3" in f["issue"] for f in result["failures"]), result["failures"]


def test_missing_schema_reports_json_failure_instead_of_crashing():
    import shutil
    with tempfile.TemporaryDirectory() as tmp:
        scripts = Path(tmp) / "skills" / "eque2-code-create-spec" / "scripts"
        scripts.mkdir(parents=True)
        for name in ("cs-readiness-check.py", "scenario_id_grammar.py"):
            shutil.copy(SCRIPT.parent / name, scripts / name)
        feature = _make_feature(Path(tmp))
        result = subprocess.run(
            [sys.executable, str(scripts / "cs-readiness-check.py"), str(feature)],
            capture_output=True, text=True,
        )
        assert result.returncode == 0, result.stderr   # the script never exits non-zero
        out = json.loads(result.stdout)
        assert out["status"] == "failed", out
        assert out["failures"][0]["check"] == "Setup", out
        assert "actor-definitions.v1.schema.json" in out["failures"][0]["file"], out
        assert "Traceback" not in result.stderr


def test_trailing_newline_scenario_id_is_rejected():
    import importlib.util
    spec = importlib.util.spec_from_file_location("cs_readiness_check", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.GRAMMAR.is_id("DELIVERY-2")
    assert not mod.GRAMMAR.is_id("DELIVERY-2\n")
    ok, _, failures = mod.check_verifiable(Path(tempfile.gettempdir()), [{"id": "S1\n", "line": 3}])
    assert any("does not match the scenario id grammar" in f["issue"] for f in failures), failures


def main() -> int:
    tests = [
        ("happy path all pass", test_happy_path_all_pass),
        ("missing scenarios fails Scenarios First", test_missing_scenarios_fails_scenarios_first),
        ("task references unknown scenario", test_task_references_unknown_scenario),
        ("unsupported scenario is flagged", test_unsupported_scenario_is_flagged),
        ("missing Tests line fails Testable", test_missing_tests_line_fails_testable),
        ("markdown-polluted pattern fails Testable", test_markdown_polluted_pattern_fails_testable),
        ("missing File or bad verb fails Actionable", test_missing_file_or_bad_verb_fails_actionable),
        ("placeholder token fails Complete", test_placeholder_token_fails_complete),
        ("missing BUILD scenarios fails Verifiable", test_missing_build_scenarios_fails_verifiable),
        ("malformed state snapshot fails Verifiable", test_malformed_state_snapshot_fails_verifiable),
        ("--help flag", test_help_flag),
        ("scenario id outside the grammar fails Verifiable", test_scenario_id_outside_the_grammar_fails_verifiable),
        ("open-prefix ids pass; coverage refs use the grammar", test_open_prefix_ids_pass_and_coverage_refs_use_the_grammar),
        ("missing schema reports JSON failure", test_missing_schema_reports_json_failure_instead_of_crashing),
        ("trailing-newline scenario id is rejected", test_trailing_newline_scenario_id_is_rejected),
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
