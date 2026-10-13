#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Smoke tests for is-detect-stack.py.

Covers:
- Angular detection: angular.json present, @angular/core version in package.json.
- Next.js detection: next.config.ts present, next version in package.json.
- Unknown tech (null): no framework config files, no package.json.
- Multi-linter detection: .eslintrc.json + .prettierrc + pyproject.toml with [tool.ruff].
- Installed guides detection: files present under docs/CLAUDE/code-standards/ and
  .github/review-rules/.
- Package manager preference order: pnpm-lock.yaml wins over package.json (npm).
- Vite glob-stem detection: vite.config.ts detected as "vite".
- -o / --output writes to file instead of stdout.
- --help works.

Run:
    uv run scripts/tests/test-is-detect-stack.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent.resolve()
SCRIPT = SCRIPT_DIR.parent / "is-detect-stack.py"


def _run(project_root: Path, extra_args: list[str] | None = None) -> dict:
    cmd = [sys.executable, str(SCRIPT), str(project_root)]
    if extra_args:
        cmd.extend(extra_args)
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def _make_project(tmp: Path) -> Path:
    """Return an empty project root directory."""
    project = tmp / "project"
    project.mkdir(parents=True, exist_ok=True)
    return project


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_angular_detection():
    """angular.json → tech=angular, version extracted from @angular/core in package.json."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))
        (project / "angular.json").write_text('{"version": 1}')
        (project / "pnpm-lock.yaml").write_text("")
        (project / "package.json").write_text(json.dumps({
            "name": "my-app",
            "dependencies": {
                "@angular/core": "^17.3.0",
            },
        }))

        result = _run(project)

        assert result["status"] == "ok", result
        assert result["tech"] == "angular", result
        assert result["framework_config"] == "angular.json", result
        assert result["version"] == "17.3.0", result
        assert result["package_manager"] == "pnpm", result
        assert result["lockfile"] == "pnpm-lock.yaml", result


def test_nextjs_detection():
    """next.config.ts → tech=nextjs, version extracted from next in package.json."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))
        (project / "next.config.ts").write_text("export default {};")
        (project / "package.json").write_text(json.dumps({
            "dependencies": {"next": "14.2.0"},
        }))

        result = _run(project)

        assert result["status"] == "ok", result
        assert result["tech"] == "nextjs", result
        assert result["framework_config"] == "next.config.ts", result
        assert result["version"] == "14.2.0", result
        assert result["package_manager"] == "npm", result


def test_nextjs_mjs_variant():
    """next.config.mjs is also recognised as nextjs."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))
        (project / "next.config.mjs").write_text("export default {};")
        (project / "package.json").write_text(json.dumps({
            "devDependencies": {"next": "~13.5.0"},
        }))

        result = _run(project)

        assert result["tech"] == "nextjs", result
        assert result["framework_config"] == "next.config.mjs", result
        assert result["version"] == "13.5.0", result


def test_unknown_tech_returns_null():
    """No framework config files → tech, version, framework_config all null."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))
        # Only a go.mod — a known package manager but no JS/TS framework.
        (project / "go.mod").write_text("module example.com/app\n\ngo 1.22\n")

        result = _run(project)

        assert result["status"] == "ok", result
        assert result["tech"] == "go", result
        assert result["package_manager"] == "go", result
        # go.mod serves as both lockfile indicator and framework config for "go" tech.
        assert result["framework_config"] == "go.mod", result


def test_no_known_tech():
    """Completely empty project → tech null, package_manager null."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))

        result = _run(project)

        assert result["status"] == "ok", result
        assert result["tech"] is None, result
        assert result["version"] is None, result
        assert result["framework_config"] is None, result
        assert result["package_manager"] is None, result
        assert result["lockfile"] is None, result


def test_multi_linter_detection():
    """ESLint + Prettier + ruff (via pyproject.toml) all detected."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))
        (project / ".eslintrc.json").write_text('{"root": true}')
        (project / ".prettierrc").write_text('{"semi": false}')
        (project / "pyproject.toml").write_text(
            "[tool.ruff]\nline-length = 100\n"
        )

        result = _run(project)

        assert result["status"] == "ok", result
        assert "eslint" in result["linters"], result
        assert "prettier" in result["linters"], result
        assert "ruff" in result["linters"], result


def test_black_linter_detected_via_pyproject():
    """[tool.black] section in pyproject.toml → black in linters."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))
        (project / "pyproject.toml").write_text(
            "[tool.black]\nline-length = 88\n"
        )

        result = _run(project)

        assert "black" in result["linters"], result


def test_eslint_flat_config_detected():
    """eslint.config.js (flat config) detected as eslint."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))
        (project / "eslint.config.js").write_text("export default [];")

        result = _run(project)

        assert "eslint" in result["linters"], result


def test_installed_guides_detection():
    """Files under docs/CLAUDE/code-standards/ and .github/review-rules/ listed."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))

        code_standards_dir = project / "docs" / "CLAUDE" / "code-standards"
        code_standards_dir.mkdir(parents=True)
        (code_standards_dir / "angular.md").write_text("# Angular standards")
        (code_standards_dir / "typescript.md").write_text("# TS standards")

        review_rules_dir = project / ".github" / "review-rules"
        review_rules_dir.mkdir(parents=True)
        (review_rules_dir / "angular.md").write_text("# Angular rules")

        result = _run(project)

        assert result["status"] == "ok", result
        guides = result["guides_installed"]
        assert "docs/CLAUDE/code-standards/angular.md" in guides["code_standards"], guides
        assert "docs/CLAUDE/code-standards/typescript.md" in guides["code_standards"], guides
        assert ".github/review-rules/angular.md" in guides["review_rules"], guides


def test_no_guides_installed():
    """Neither guides directory exists → both lists are empty."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))

        result = _run(project)

        guides = result["guides_installed"]
        assert guides["code_standards"] == [], guides
        assert guides["review_rules"] == [], guides


def test_pnpm_wins_over_npm():
    """pnpm-lock.yaml present alongside package.json → pnpm takes precedence."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))
        (project / "pnpm-lock.yaml").write_text("")
        (project / "package.json").write_text('{"name": "app"}')

        result = _run(project)

        assert result["package_manager"] == "pnpm", result
        assert result["lockfile"] == "pnpm-lock.yaml", result


def test_bun_wins_over_pnpm():
    """bun.lockb present alongside pnpm-lock.yaml → bun takes precedence."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))
        (project / "bun.lockb").write_bytes(b"")
        (project / "pnpm-lock.yaml").write_text("")
        (project / "package.json").write_text('{"name": "app"}')

        result = _run(project)

        assert result["package_manager"] == "bun", result
        assert result["lockfile"] == "bun.lockb", result


def test_vite_glob_stem_detection():
    """vite.config.ts detected as tech=vite via glob-stem logic."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))
        (project / "vite.config.ts").write_text("export default {};")
        (project / "package.json").write_text(json.dumps({
            "devDependencies": {"vite": "5.2.0"},
        }))

        result = _run(project)

        assert result["tech"] == "vite", result
        assert result["framework_config"] == "vite.config.ts", result
        assert result["version"] == "5.2.0", result


def test_output_flag_writes_file():
    """-o writes JSON to the specified file path, nothing emitted to stdout."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))
        output_path = Path(tmp) / "output.json"

        proc = subprocess.run(
            [sys.executable, str(SCRIPT), str(project), "-o", str(output_path)],
            capture_output=True,
            text=True,
            check=True,
        )

        # stdout should be empty (or only whitespace).
        assert proc.stdout.strip() == "", f"Expected no stdout, got: {proc.stdout!r}"
        # Output file must exist and contain valid JSON.
        assert output_path.exists(), "Output file was not created"
        data = json.loads(output_path.read_text(encoding="utf-8"))
        assert data["status"] == "ok", data


def test_pretty_flag_indents_output():
    """--pretty flag produces indented JSON."""
    with tempfile.TemporaryDirectory() as tmp:
        project = _make_project(Path(tmp))

        proc = subprocess.run(
            [sys.executable, str(SCRIPT), str(project), "--pretty"],
            capture_output=True,
            text=True,
            check=True,
        )

        assert "\n" in proc.stdout, "Expected indented output"
        data = json.loads(proc.stdout)
        assert data["status"] == "ok", data


def test_nonexistent_project_root_returns_error():
    """A path that does not exist → status=error with informative message."""
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "/nonexistent/path/that/does/not/exist"],
        capture_output=True,
        text=True,
        check=True,
    )
    data = json.loads(result.stdout)
    assert data["status"] == "error", data
    assert "error" in data, data


def test_help_flag():
    """--help exits cleanly and mentions project_root."""
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--help"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "project_root" in result.stdout


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def main() -> int:
    tests = [
        ("angular detection", test_angular_detection),
        ("nextjs detection (next.config.ts)", test_nextjs_detection),
        ("nextjs mjs variant", test_nextjs_mjs_variant),
        ("go tech / unknown JS framework (null)", test_unknown_tech_returns_null),
        ("completely empty project — tech null", test_no_known_tech),
        ("multi-linter detection (eslint + prettier + ruff)", test_multi_linter_detection),
        ("black detected via pyproject.toml", test_black_linter_detected_via_pyproject),
        ("eslint flat config detected", test_eslint_flat_config_detected),
        ("installed guides detected", test_installed_guides_detection),
        ("no guides installed — empty lists", test_no_guides_installed),
        ("pnpm wins over npm", test_pnpm_wins_over_npm),
        ("bun wins over pnpm", test_bun_wins_over_pnpm),
        ("vite glob-stem detection", test_vite_glob_stem_detection),
        ("-o flag writes to file", test_output_flag_writes_file),
        ("--pretty flag indents output", test_pretty_flag_indents_output),
        ("nonexistent project root returns error", test_nonexistent_project_root_returns_error),
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
