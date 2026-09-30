#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Tests for cs-generate-definitions.py.

Covers the [CS] spec-generation fixes (Issue #2):
- CAP-5 parse_tests_field:
    * "(full suite)**Test Cases:**" markdown pollution → clean "(full suite)"
      sentinel (NEVER "**Test Cases:**").
    * plain "(full suite)" → "(full suite)".
    * real pattern preserved.
    * file-only → no pattern.
    * pure-markdown pattern → no pattern (rejected).
    * empty / None → [].
- CAP-4 dependsOn propagation:
    * parse_tasks reads "Depends On:" from task Details → depends_on.
    * a leaf "Depends On: —" → [].
    * end-to-end generate() emits non-empty dependsOn in definitions.json,
      and a clean (full suite) test pattern survives to the JSON.

Run:
    uv run scripts/tests/test-cs-generate-definitions.py
"""

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent.resolve()
SCRIPT = SCRIPT_DIR.parent / "cs-generate-definitions.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("cs_generate_definitions", SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CS = _load_module()


# --- CAP-5: parse_tests_field -------------------------------------------------

def test_full_suite_markdown_pollution_is_cleaned():
    out = CS.parse_tests_field("file.spec.ts (full suite)**Test Cases:**")
    assert out == [{"file": "file.spec.ts", "pattern": "(full suite)"}], out
    # The exact regression from Issue #2 #0: the markdown header must be gone.
    assert "**Test Cases:**" not in out[0].get("pattern", "")
    assert "**" not in out[0].get("pattern", "")


def test_full_suite_plain():
    out = CS.parse_tests_field("file.spec.ts (full suite)")
    assert out == [{"file": "file.spec.ts", "pattern": "(full suite)"}], out


def test_real_pattern_preserved():
    out = CS.parse_tests_field("test/foo.spec.ts should parse CSV")
    assert out == [{"file": "test/foo.spec.ts", "pattern": "should parse CSV"}], out


def test_file_only_no_pattern():
    out = CS.parse_tests_field("test/foo.spec.ts")
    assert out == [{"file": "test/foo.spec.ts"}], out


def test_pure_markdown_pattern_rejected():
    # A pattern that is only markdown collapses to no pattern at all.
    out = CS.parse_tests_field("test/foo.spec.ts **Test Cases:**")
    assert out == [{"file": "test/foo.spec.ts"}], out


def test_empty_and_none():
    assert CS.parse_tests_field(None) == []
    assert CS.parse_tests_field("") == []
    assert CS.parse_tests_field("   ") == []


# --- CAP-4: dependsOn propagation (unit) -------------------------------------

TASKS_MD = """# Tasks: PROJ-1

## Task Details

### T1.1: Add types

**Goal:** Add the shared types.

**Depends On:** —

**Tests:** test/types.spec.ts (full suite)

**Files to Create/Modify:** src/types.ts

### T1.2: Add service

**Goal:** Add the service that uses the types.

**Depends On:** T1.1

**Tests:** test/service.spec.ts should call the API

**Files to Create/Modify:** src/service.ts
"""


def test_parse_tasks_reads_depends_on():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "tasks.md"
        p.write_text(TASKS_MD, encoding="utf-8")
        tasks = CS.parse_tasks(p)
        by_id = {t["id"]: t for t in tasks}
        assert by_id["T1.1"]["depends_on"] == [], by_id["T1.1"]
        assert by_id["T1.2"]["depends_on"] == ["T1.1"], by_id["T1.2"]


# --- CAP-4 + CAP-5: end-to-end generate() ------------------------------------

def test_generate_emits_dependson_and_clean_patterns():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d) / "PROJ-1"
        root.mkdir()
        (root / "tasks.md").write_text(TASKS_MD, encoding="utf-8")
        (root / "scenarios.gherkin").write_text("", encoding="utf-8")
        (root / "spec.md").write_text("---\nspecSlug: PROJ-1\n---\n# Feature\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(root)],
            capture_output=True,
            text=True,
            check=True,
        )
        defs = json.loads((root / "definitions.json").read_text(encoding="utf-8"))
        tasks = {t["id"]: t for t in defs["tasks"]}
        # CAP-4: the dependency edge survives into definitions.json.
        assert tasks["T1.2"]["dependsOn"] == ["T1.1"], tasks["T1.2"]
        assert tasks["T1.1"]["dependsOn"] == [], tasks["T1.1"]
        # CAP-5: the full-suite sentinel is clean in the emitted JSON.
        assert tasks["T1.1"]["tests"] == [{"file": "test/types.spec.ts", "pattern": "(full suite)"}], tasks["T1.1"]
        raw = (root / "definitions.json").read_text(encoding="utf-8")
        assert "**Test Cases:**" not in raw


# --- {TEST_DIR} placeholder defect (2026-07-03) -------------------------------

SCENARIOS_GHERKIN = """Feature: PROJ-1

Scenario: S1 - Thing renders
  Given a page
  When it loads
  Then the thing is visible
"""


def _make_feature_with_scenario(d: Path, project_test_dir: str | None) -> Path:
    """Feature tree {project}/_bmad-output/features/PROJ-1 with one scenario."""
    project = d / "proj"
    root = project / "_bmad-output" / "features" / "PROJ-1"
    root.mkdir(parents=True)
    (root / "tasks.md").write_text(TASKS_MD, encoding="utf-8")
    (root / "scenarios.gherkin").write_text(SCENARIOS_GHERKIN, encoding="utf-8")
    (root / "spec.md").write_text("---\nspecSlug: PROJ-1\n---\n# Feature\n", encoding="utf-8")
    if project_test_dir:
        (project / project_test_dir).mkdir(parents=True)
    return root


def test_scenario_testfile_never_contains_placeholder():
    # No context.md, no --test-dir-from-context: the historical worst case
    # that emitted a literal {TEST_DIR}. Now the resolver fallback must fire.
    with tempfile.TemporaryDirectory() as d:
        root = _make_feature_with_scenario(Path(d), "e2e/tests")
        subprocess.run([sys.executable, str(SCRIPT), str(root)], capture_output=True, text=True, check=True)
        raw = (root / "definitions.json").read_text(encoding="utf-8")
        assert "{TEST_DIR}" not in raw, raw
        defs = json.loads(raw)
        s1 = next(s for s in defs["scenarios"] if s["id"] == "S1")
        # The resolver picks a real existing dir ("e2e" matches its common
        # patterns) — the exact choice doesn't matter, a concrete path does.
        assert s1["testFile"].startswith("e2e"), s1
        assert s1["testFile"].endswith("/verify-PROJ-1-S1.spec.ts"), s1


def test_scenario_testfile_fallback_when_nothing_resolvable():
    # Bare project with no test dirs at all: resolver strategy 4 → "test/".
    # Still NEVER a placeholder.
    with tempfile.TemporaryDirectory() as d:
        root = _make_feature_with_scenario(Path(d), None)
        subprocess.run([sys.executable, str(SCRIPT), str(root)], capture_output=True, text=True, check=True)
        raw = (root / "definitions.json").read_text(encoding="utf-8")
        assert "{TEST_DIR}" not in raw, raw
        defs = json.loads(raw)
        s1 = next(s for s in defs["scenarios"] if s["id"] == "S1")
        assert s1["testFile"].endswith("/verify-PROJ-1-S1.spec.ts"), s1
        assert not s1["testFile"].startswith("{"), s1


def test_context_md_test_dir_still_wins():
    # --test-dir-from-context with an explicit TEST_DIR keeps priority over
    # the resolver fallback.
    with tempfile.TemporaryDirectory() as d:
        root = _make_feature_with_scenario(Path(d), "e2e/tests")
        (root / "context.md").write_text("## Test Patterns\n\nTEST_DIR: apps/ui-e2e/tests\n", encoding="utf-8")
        subprocess.run(
            [sys.executable, str(SCRIPT), str(root), "--test-dir-from-context"],
            capture_output=True, text=True, check=True,
        )
        defs = json.loads((root / "definitions.json").read_text(encoding="utf-8"))
        s1 = next(s for s in defs["scenarios"] if s["id"] == "S1")
        assert s1["testFile"] == "apps/ui-e2e/tests/verify-PROJ-1-S1.spec.ts", s1


# --- TEST_DIR extraction regex crossing newlines (2026-07-03 evening) ---------

# The exact real-world shape [CS] writes into every consumer context.md:
# a heading that itself ends in "TEST_DIR", blank line, then the value line.
CONTEXT_WITH_TEST_DIR_HEADING = """# Context

## Test patterns / TEST_DIR

TEST_DIR: scripts
"""


def test_extract_test_dir_heading_does_not_swallow_next_line():
    # Regression: the bare TEST_DIR in the heading anchored the match, \\s
    # crossed the newline, and the capture became "TEST_DIR: scripts".
    out = CS.extract_test_dir(CONTEXT_WITH_TEST_DIR_HEADING)
    assert out == "scripts", out


def test_extract_test_dir_plain_value_line_still_works():
    assert CS.extract_test_dir("TEST_DIR: apps/ui-e2e/tests\n") == "apps/ui-e2e/tests"
    assert CS.extract_test_dir("**TEST_DIR:** `e2e/specs`\n") == "e2e/specs"
    assert CS.extract_test_dir("Test directory: my/tests\n") == "my/tests"


def test_extract_test_dir_rejects_colon_captures():
    # A capture containing ":" is never a directory — extraction must fail
    # (returning None → fallback resolver) rather than succeed wrongly.
    assert CS.extract_test_dir("TEST_DIR: TEST_DIR: scripts\n") is None
    assert CS.extract_test_dir("## Test patterns / TEST_DIR\n\n(no value at all)\n") is None


def test_generate_with_heading_context_emits_clean_testfile():
    # End-to-end: the poisoned-prefix path "TEST_DIR: scripts/verify-…" must
    # never reach definitions.json.
    with tempfile.TemporaryDirectory() as d:
        root = _make_feature_with_scenario(Path(d), "scripts")
        (root / "context.md").write_text(CONTEXT_WITH_TEST_DIR_HEADING, encoding="utf-8")
        subprocess.run(
            [sys.executable, str(SCRIPT), str(root), "--test-dir-from-context"],
            capture_output=True, text=True, check=True,
        )
        raw = (root / "definitions.json").read_text(encoding="utf-8")
        assert "TEST_DIR:" not in raw, raw
        defs = json.loads(raw)
        s1 = next(s for s in defs["scenarios"] if s["id"] == "S1")
        assert s1["testFile"] == "scripts/verify-PROJ-1-S1.spec.ts", s1



# --- 2026-07-04 field report: prose lines must never match field patterns ----

WRAPPED_PROSE_TASKS_MD = """# Tasks

### T1.1: Validate the fixture (extend only if a gap)

**Goal:** T0 ALREADY shipped the fixture. REUSE as-is. This task VERIFIES the fixture works for Epic 1's
tests and extends it ONLY if a concrete gap is found — it does not rebuild the helper.
All Epic-1 tests must call the 2-arg form.

**Depends On:** —

**Supports:** S1, S2

**Tests:** apps/ui-e2e/tests/auth.spec.ts (full suite)

**Files to Create/Modify:** apps/ui-e2e/fixtures/auth.ts
"""


def test_wrapped_prose_starting_with_keyword_does_not_capture_field():
    """A hard-wrapped Goal paragraph continuing on a line that STARTS with
    "tests …" (no colon) must not be captured as the Tests field. The optional
    colon in the field patterns let it win over the real `**Tests:**` line,
    emitting tests=[{file:"and", pattern:"extends it ONLY …"}]."""
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "tasks.md"
        p.write_text(WRAPPED_PROSE_TASKS_MD, encoding="utf-8")
        tasks = CS.parse_tasks(p)
        t = {t["id"]: t for t in tasks}["T1.1"]
        assert t["tests"] == "apps/ui-e2e/tests/auth.spec.ts (full suite)", t["tests"]
        parsed = CS.parse_tests_field(t["tests"])
        assert parsed == [{"file": "apps/ui-e2e/tests/auth.spec.ts", "pattern": "(full suite)"}], parsed


def test_field_colon_placement_variants_still_match():
    """Both `**Tests:** x` and `**Tests**: x` (and bare `Tests: x`) must parse."""
    for line in ("**Tests:** t.spec.ts", "**Tests**: t.spec.ts", "Tests: t.spec.ts"):
        md = f"# Tasks\n\n### T1.1: A task\n\n**Goal:** g.\n\n{line}\n"
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "tasks.md"
            p.write_text(md, encoding="utf-8")
            t = CS.parse_tasks(p)[0]
            assert t["tests"] == "t.spec.ts", (line, t["tests"])


def test_prose_test_directory_line_not_captured_as_tests():
    """A preamble-style prose line "Test directory: `x`" inside a task block is
    a workdir-ish note, not a Tests field; "Test" + non-colon must not match."""
    md = (
        "# Tasks\n\n### T1.1: A task\n\n**Goal:** g.\n\n"
        "Test directory note follows here with no colon after the keyword\n\n"
        "**Tests:** real.spec.ts\n"
    )
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "tasks.md"
        p.write_text(md, encoding="utf-8")
        t = CS.parse_tasks(p)[0]
        assert t["tests"] == "real.spec.ts", t["tests"]


# --- Shared scenario id grammar (spec-fix-scenario-id-grammar, 2026-09-29) ----

# The same I/O-matrix cases the TypeScript reporter suite checks
# (src/eque2-code/test/scenario-file-pattern.test.ts). Python must route and
# reject exactly the same file names, because it reads the same grammar.
FILE_CASES = [
    ("verify-mcp-logging-DELIVERY-2.spec.ts", "DELIVERY-2"),
    ("verify-CLOUD-DEPLOY-DELIVERY-1.spec.ts", "DELIVERY-1"),
    ("verify-CLOUD-DEPLOY-S1.spec.ts", "S1"),
    ("verify-demo-C4-RESET.1.spec.ts", "C4-RESET.1"),
    ("verify-CLOUD-DEPLOY-BUILD-1.spec.ts", "BUILD-1"),
    ("verify-cfte-3-pages-1.1-1.5-S10.spec.ts", "S10"),
    ("verify-demo-AU3.spec.ts", "AU3"),
    ("verify-demo-MG12b.spec.ts", "MG12b"),
    ("verify-FEATURE-123.spec.ts", None),
    ("verify-CLOUD-DEPLOY.spec.ts", None),
    ("verify-slug-only.spec.ts", None),
]


def test_grammar_is_read_from_the_shipped_schema():
    schema = json.loads(CS.ACTOR_DEFINITIONS_SCHEMA.read_text(encoding="utf-8"))
    pattern = schema["properties"]["scenarios"]["items"]["properties"]["id"]["pattern"]
    assert pattern == f"^{CS.SCENARIO_ID_SOURCE}$", pattern
    build = schema["properties"]["buildChecks"]["items"]["properties"]["id"]["pattern"]
    assert build == pattern, build


def test_grammar_matches_the_typescript_source_in_the_dev_repo():
    # In the eque2-code dev repo the grammar's TypeScript source is present;
    # the generated schema must carry exactly that literal. (A target repo
    # has no src/, so this check only runs where it can.)
    repo = CS.ACTOR_DEFINITIONS_SCHEMA.parents[3]
    constants = repo / "src" / "packages" / "schemas" / "src" / "schemas" / "constants.ts"
    if not constants.exists():
        return
    import re as _re
    m = _re.search(r"export const SCENARIO_ID_SOURCE = '([^']+)'", constants.read_text(encoding="utf-8"))
    assert m, "SCENARIO_ID_SOURCE not found in constants.ts"
    ts_source = m.group(1).replace("\\\\", "\\")
    assert ts_source == CS.SCENARIO_ID_SOURCE, (ts_source, CS.SCENARIO_ID_SOURCE)


def test_file_pattern_parity_with_the_reporter_cases():
    for name, expected in FILE_CASES:
        m = CS.SCENARIO_FILE_RE.match(name)
        got = m.group(1) if m else None
        assert got == expected, (name, got, expected)


def test_trailing_newline_is_not_an_id_or_a_routable_name():
    # Python's `$` matches before a trailing newline; JS's does not. The
    # grammar is anchored with \\A…\\Z so both languages agree.
    assert CS.GRAMMAR.is_id("S1")
    assert not CS.GRAMMAR.is_id("S1\n")
    assert CS.SCENARIO_ID_RE.match("S1\n") is None
    assert CS.GRAMMAR.routed_id("verify-demo-S1.spec.ts") == "S1"
    assert CS.GRAMMAR.routed_id("verify-demo-S1.spec.ts\n") is None


def _copy_without_schema(d: Path, script_name: str) -> Path:
    """Copy a script and the shared grammar module into a tree with no eque2-code-setup/schemas/."""
    import shutil
    scripts = d / "skills" / "eque2-code-create-spec" / "scripts"
    scripts.mkdir(parents=True)
    for name in (script_name, "scenario_id_grammar.py", "cs-resolve-test-dir.py"):
        src = SCRIPT_DIR.parent / name
        if src.exists():
            shutil.copy(src, scripts / name)
    return scripts / script_name


def test_missing_schema_reports_json_failure_instead_of_crashing():
    with tempfile.TemporaryDirectory() as d:
        script = _copy_without_schema(Path(d), "cs-generate-definitions.py")
        root = _make_feature_with_scenario(Path(d) / "p", "e2e")
        result = subprocess.run([sys.executable, str(script), str(root)], capture_output=True, text=True)
        assert result.returncode == 1, result.stderr
        out = json.loads(result.stdout)
        assert out["status"] == "failed", out
        assert "actor-definitions.v1.schema.json" in out["errors"][0]["file"], out
        assert "Traceback" not in result.stderr, result.stderr
        assert not (root / "definitions.json").exists()


def test_generate_accepts_an_open_prefix_id():
    with tempfile.TemporaryDirectory() as d:
        root = _make_feature_with_scenario(Path(d), "e2e")
        (root / "scenarios.gherkin").write_text(
            "Feature: PROJ-1\n\nScenario: DELIVERY-2 - A log entry arrives\n  Given a page\n  When it loads\n  Then it works\n",
            encoding="utf-8",
        )
        (root / "tasks.md").write_text("# Tasks\n", encoding="utf-8")
        result = subprocess.run([sys.executable, str(SCRIPT), str(root)], capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr
        defs = json.loads((root / "definitions.json").read_text(encoding="utf-8"))
        sc = defs["scenarios"][0]
        assert sc["id"] == "DELIVERY-2", sc
        assert CS.SCENARIO_FILE_RE.match(Path(sc["testFile"]).name).group(1) == "DELIVERY-2", sc


def test_generate_rejects_an_id_outside_the_grammar():
    with tempfile.TemporaryDirectory() as d:
        root = _make_feature_with_scenario(Path(d), "e2e")
        (root / "scenarios.gherkin").write_text(
            "Feature: PROJ-1\n\nScenario: delivery_2 - Lowercase id\n  Given a page\n  When it loads\n  Then it works\n",
            encoding="utf-8",
        )
        (root / "tasks.md").write_text("# Tasks\n", encoding="utf-8")
        result = subprocess.run([sys.executable, str(SCRIPT), str(root)], capture_output=True, text=True)
        out = json.loads(result.stdout)
        assert out["status"] == "failed", out
        assert any("delivery_2" in e["issue"] for e in out["errors"]), out["errors"]
        assert not (root / "definitions.json").exists()


def _run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"ERROR {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_run_all())
