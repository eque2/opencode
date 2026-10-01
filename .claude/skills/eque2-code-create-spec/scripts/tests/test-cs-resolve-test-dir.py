#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Smoke tests for cs-resolve-test-dir.py.

Covers:
- context_file strategy: TEST_DIR hint found in a "Test Patterns" section.
- common_pattern strategy: a conventional directory (e.g. tests/) exists.
- find_match strategy: subprocess find returns a result (mocked via a real file).
- fallback strategy: nothing found, returns test/ with method=fallback.
- custom --hint glob respected by find strategy.
- --output flag writes JSON to file.
- --pretty flag produces indented output.
- --help works.

Run:
    uv run scripts/tests/test-cs-resolve-test-dir.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch


SCRIPT_DIR = Path(__file__).parent.resolve()
SCRIPT = SCRIPT_DIR.parent / "cs-resolve-test-dir.py"

# ---------------------------------------------------------------------------
# Import helpers — we import the module under test for unit tests, and also
# drive it via subprocess for CLI smoke-tests.
# ---------------------------------------------------------------------------

sys.path.insert(0, str(SCRIPT_DIR.parent))
import importlib.util as _ilu

_spec = _ilu.spec_from_file_location("cs_resolve_test_dir", SCRIPT)
_mod = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

resolve_test_dir = _mod.resolve_test_dir
_try_context_file = _mod._try_context_file
_try_common_patterns = _mod._try_common_patterns
_try_find_match = _mod._try_find_match


def _run_cli(*extra_args: str) -> tuple[int, dict | None]:
    """Run the script via subprocess and return (returncode, parsed_json_or_None).

    When --output is used the script writes nothing to stdout, so parsed_json
    will be None for those calls.
    """
    result = subprocess.run(
        [sys.executable, str(SCRIPT), *extra_args],
        capture_output=True,
        text=True,
    )
    stdout = result.stdout.strip()
    parsed = json.loads(stdout) if stdout else None
    return result.returncode, parsed


# ---------------------------------------------------------------------------
# Unit tests — strategy 1: context_file
# ---------------------------------------------------------------------------


def test_context_file_detects_test_dir():
    """A 'Test Patterns' section with TEST_DIR: wins over all other strategies."""
    with tempfile.TemporaryDirectory() as tmp:
        project_root = Path(tmp) / "proj"
        project_root.mkdir()
        # Create tests/ so common_pattern would also match — context_file should win.
        (project_root / "tests").mkdir()

        context = project_root / "context.md"
        context.write_text(
            "# Context\n\n"
            "## Test Patterns\n\n"
            "TEST_DIR: src/integration/tests\n\n"
            "## Other Section\n\n"
            "Some other content.\n"
        )

        result = resolve_test_dir(project_root, "verify-*.spec.ts", context)
        assert result["method"] == "context_file", result
        assert result["test_dir"] == "src/integration/tests", result
        assert result["status"] == "ok"


def test_context_file_case_insensitive_key():
    """test_dir: (lowercase) is also recognised."""
    with tempfile.TemporaryDirectory() as tmp:
        project_root = Path(tmp) / "proj"
        project_root.mkdir()

        context = project_root / "context.md"
        context.write_text(
            "## Test Patterns\n\ntest_dir: e2e/scenarios\n"
        )

        result = resolve_test_dir(project_root, "verify-*.spec.ts", context)
        assert result["method"] == "context_file", result
        assert result["test_dir"] == "e2e/scenarios", result


def test_context_file_detects_markdown_decorated_test_dir():
    """A bold/backtick/bulleted TEST_DIR line (LLM-authored context.md) is recognised.

    Regression for the eque2-issues.md #3 report: .test-dir.json recorded
    the wrong TEST_DIR because context.md's "Test Patterns" section used
    a bold key + backtick-wrapped value — markdown decoration the old
    bare-line regex didn't match, silently falling through to the generic
    common_pattern/find_match heuristics.
    """
    with tempfile.TemporaryDirectory() as tmp:
        project_root = Path(tmp) / "proj"
        project_root.mkdir()
        (project_root / "tests").mkdir()  # would be picked by common_pattern if strategy 1 fails

        context = project_root / "context.md"
        context.write_text(
            "## Test Patterns\n\n"
            "- **TEST_DIR:** `apps/ui/src/components/media-player`\n"
        )

        result = resolve_test_dir(project_root, "verify-*.spec.ts", context)
        assert result["method"] == "context_file", result
        assert result["test_dir"] == "apps/ui/src/components/media-player", result


def test_context_file_missing_returns_none():
    """Non-existent context file is silently skipped."""
    result = _try_context_file(Path("/nonexistent/path/context.md"))
    assert result is None


def test_context_file_no_test_patterns_section():
    """A context.md with no 'Test Patterns' section yields None for strategy 1."""
    with tempfile.TemporaryDirectory() as tmp:
        context = Path(tmp) / "context.md"
        context.write_text("# Context\n\nNo test info here.\n")
        result = _try_context_file(context)
        assert result is None


def test_context_file_test_dir_not_in_section_boundary():
    """TEST_DIR outside the Test Patterns section is not picked up."""
    with tempfile.TemporaryDirectory() as tmp:
        context = Path(tmp) / "context.md"
        context.write_text(
            "## Test Patterns\n\n"
            "Some notes.\n\n"
            "## Another Section\n\n"
            "TEST_DIR: should/not/match\n"
        )
        result = _try_context_file(context)
        assert result is None


# ---------------------------------------------------------------------------
# Unit tests — strategy 2: common_pattern
# ---------------------------------------------------------------------------


def test_common_pattern_tests_dir():
    """tests/ at project root is detected as common_pattern."""
    with tempfile.TemporaryDirectory() as tmp:
        project_root = Path(tmp) / "proj"
        project_root.mkdir()
        (project_root / "tests").mkdir()

        result = resolve_test_dir(project_root, "verify-*.spec.ts", None)
        assert result["method"] == "common_pattern", result
        assert result["test_dir"] == "tests", result


def test_common_pattern_nested_src_test():
    """src/myapp/test/ is detected via the 'src/*/test/' glob pattern."""
    with tempfile.TemporaryDirectory() as tmp:
        project_root = Path(tmp) / "proj"
        project_root.mkdir()
        (project_root / "src" / "myapp" / "test").mkdir(parents=True)

        result = resolve_test_dir(project_root, "verify-*.spec.ts", None)
        assert result["method"] == "common_pattern", result
        assert "test" in result["test_dir"], result


def test_common_pattern_priority_scenarios_over_plain():
    """tests/scenarios/ is preferred over tests/ because it appears earlier in COMMON_PATTERNS."""
    with tempfile.TemporaryDirectory() as tmp:
        project_root = Path(tmp) / "proj"
        project_root.mkdir()
        (project_root / "tests" / "scenarios").mkdir(parents=True)
        (project_root / "tests").mkdir(parents=True, exist_ok=True)

        result = _try_common_patterns(project_root)
        # tests/scenarios appears before tests/ in COMMON_PATTERNS.
        assert result is not None
        assert "scenarios" in result, result


# ---------------------------------------------------------------------------
# Unit tests — strategy 3: find_match
# ---------------------------------------------------------------------------


def test_find_match_returns_parent_of_first_hit():
    """A real spec file on disk is discovered via `find` and the parent dir is returned."""
    with tempfile.TemporaryDirectory() as tmp:
        project_root = Path(tmp) / "proj"
        spec_dir = project_root / "src" / "app" / "specs"
        spec_dir.mkdir(parents=True)
        (spec_dir / "verify-login.spec.ts").write_text("// spec")

        result = resolve_test_dir(project_root, "verify-*.spec.ts", None)
        assert result["method"] == "find_match", result
        assert "specs" in result["test_dir"], result


def test_find_match_custom_hint():
    """--hint overrides the default glob pattern for `find`.

    The spec file is placed in a path that does NOT match any of the COMMON_PATTERNS
    entries (neither 'e2e/', 'tests/', 'test/', etc.) so that strategy 2 is skipped
    and strategy 3 (find) is exercised.
    """
    with tempfile.TemporaryDirectory() as tmp:
        project_root = Path(tmp) / "proj"
        spec_dir = project_root / "verification" / "suites"
        spec_dir.mkdir(parents=True)
        (spec_dir / "smoke.test.ts").write_text("// smoke")

        result = resolve_test_dir(project_root, "smoke.test.ts", None)
        assert result["method"] == "find_match", result
        assert result["hint_used"] == "smoke.test.ts", result
        assert "suites" in result["test_dir"], result


def test_find_match_subprocess_timeout_falls_through():
    """If subprocess times out, strategy 3 is skipped and fallback is reached."""
    import subprocess as _sp

    with tempfile.TemporaryDirectory() as tmp:
        project_root = Path(tmp) / "proj"
        project_root.mkdir()

        with patch.object(_mod.subprocess, "run", side_effect=_sp.TimeoutExpired("find", 30)):
            result = resolve_test_dir(project_root, "verify-*.spec.ts", None)
        assert result["method"] == "fallback", result


# ---------------------------------------------------------------------------
# Unit tests — strategy 4: fallback
# ---------------------------------------------------------------------------


def test_fallback_when_nothing_found():
    """An empty project root hits the fallback and returns test/."""
    with tempfile.TemporaryDirectory() as tmp:
        project_root = Path(tmp) / "empty_proj"
        project_root.mkdir()

        result = resolve_test_dir(project_root, "verify-*.spec.ts", None)
        assert result["method"] == "fallback", result
        assert result["test_dir"] == "test/", result
        assert result["status"] == "ok"


# ---------------------------------------------------------------------------
# CLI integration tests
# ---------------------------------------------------------------------------


def test_cli_output_to_file():
    """--output writes JSON to the specified file (nothing printed to stdout)."""
    with tempfile.TemporaryDirectory() as tmp:
        project_root = Path(tmp) / "proj"
        project_root.mkdir()
        output_file = Path(tmp) / "out" / ".test-dir.json"

        rc, parsed = _run_cli(
            str(project_root),
            "-o", str(output_file),
        )
        assert rc == 0
        # Nothing on stdout when --output is used.
        assert parsed is None
        assert output_file.exists()
        data = json.loads(output_file.read_text())
        assert "test_dir" in data
        assert data["status"] == "ok"


def test_cli_pretty_flag():
    """--pretty produces indented JSON."""
    with tempfile.TemporaryDirectory() as tmp:
        project_root = Path(tmp) / "proj"
        project_root.mkdir()

        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(project_root), "--pretty"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        # Pretty output has newlines and indentation.
        assert "\n" in result.stdout
        assert "  " in result.stdout
        data = json.loads(result.stdout)
        assert data["status"] == "ok"


def test_cli_custom_hint():
    """--hint is reflected in the output's hint_used field."""
    with tempfile.TemporaryDirectory() as tmp:
        project_root = Path(tmp) / "proj"
        project_root.mkdir()

        rc, data = _run_cli(str(project_root), "--hint", "*.e2e.ts")
        assert rc == 0
        assert data["hint_used"] == "*.e2e.ts", data


def test_cli_context_file_used():
    """--context-file is used when it contains a TEST_DIR hint."""
    with tempfile.TemporaryDirectory() as tmp:
        project_root = Path(tmp) / "proj"
        project_root.mkdir()

        context = Path(tmp) / "context.md"
        context.write_text("## Test Patterns\n\nTEST_DIR: my/custom/tests\n")

        rc, data = _run_cli(
            str(project_root),
            "--context-file", str(context),
        )
        assert rc == 0
        assert data["method"] == "context_file", data
        assert data["test_dir"] == "my/custom/tests", data


def test_help_flag():
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--help"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "project_root" in result.stdout
    assert "--hint" in result.stdout


# ---------------------------------------------------------------------------
# Test runner
# ---------------------------------------------------------------------------


def main() -> int:
    tests = [
        # context_file strategy
        ("context_file detects TEST_DIR", test_context_file_detects_test_dir),
        ("context_file detects markdown-decorated TEST_DIR", test_context_file_detects_markdown_decorated_test_dir),
        ("context_file case-insensitive key", test_context_file_case_insensitive_key),
        ("context_file missing path returns None", test_context_file_missing_returns_none),
        ("context_file no Test Patterns section", test_context_file_no_test_patterns_section),
        ("context_file TEST_DIR outside section boundary", test_context_file_test_dir_not_in_section_boundary),
        # common_pattern strategy
        ("common_pattern detects tests/", test_common_pattern_tests_dir),
        ("common_pattern detects src/*/test/", test_common_pattern_nested_src_test),
        ("common_pattern prefers scenarios/ over plain", test_common_pattern_priority_scenarios_over_plain),
        # find_match strategy
        ("find_match returns parent of first hit", test_find_match_returns_parent_of_first_hit),
        ("find_match honours custom hint", test_find_match_custom_hint),
        ("find_match subprocess timeout falls through to fallback", test_find_match_subprocess_timeout_falls_through),
        # fallback strategy
        ("fallback when nothing found", test_fallback_when_nothing_found),
        # CLI
        ("CLI --output writes to file", test_cli_output_to_file),
        ("CLI --pretty produces indented JSON", test_cli_pretty_flag),
        ("CLI --hint reflected in hint_used", test_cli_custom_hint),
        ("CLI --context-file used", test_cli_context_file_used),
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
