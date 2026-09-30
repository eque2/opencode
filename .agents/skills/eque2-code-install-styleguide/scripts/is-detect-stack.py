#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
is-detect-stack.py — Mechanical tech-stack detector for the install-styleguide workflow.

Used by Stage 1 of the install-styleguide workflow. Inspects the project root for
lockfiles, framework config files, linter configs, and already-installed guide files,
then emits a structured JSON report. Replaces the LLM-driven file-checking loop in
01-detect.md, saving 500-800 tokens per invocation for deterministic work.

Output schema:

  {
    "status": "ok",
    "package_manager": "pnpm" | "bun" | "yarn" | "npm" | "gem" | "pip" | "uv"
                      | "go" | "cargo" | "maven" | "gradle" | null,
    "lockfile": "<filename>" | null,
    "tech": "angular" | "nextjs" | "nuxt" | "vite" | "svelte" | "rails"
           | "django" | "go" | null,
    "version": "<semver>" | null,
    "framework_config": "<filename>" | null,
    "linters": ["eslint", "prettier", "rubocop", "ruff", "black", ...],
    "guides_installed": {
      "code_standards": ["docs/CLAUDE/code-standards/<file>", ...],
      "review_rules": [".github/review-rules/<file>", ...]
    }
  }

Usage:
    uv run is-detect-stack.py <project_root>
    uv run is-detect-stack.py <project_root> -o .is-stack-detection.json --pretty

Exit code is always 0. The caller inspects `status` from the JSON output to decide
whether to proceed. We deliberately avoid non-zero exits: the workflow reads our
output in all cases.
"""

import argparse
import json
import re
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Package manager detection — ordered by specificity (lockfile first)
# ---------------------------------------------------------------------------

# Each entry: (filename, package_manager_name)
# Evaluated in order; the first match wins.
LOCKFILE_CANDIDATES: list[tuple[str, str]] = [
    ("bun.lockb", "bun"),
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("package-lock.json", "npm"),
    ("package.json", "npm"),       # npm fallback — no lockfile present
    ("Gemfile", "gem"),
    ("requirements.txt", "pip"),
    ("pyproject.toml", "pip"),     # uv/pip fallback — refined below
    ("go.mod", "go"),
    ("Cargo.toml", "cargo"),
    ("pom.xml", "maven"),
    ("build.gradle", "gradle"),
    ("build.gradle.kts", "gradle"),
]

# pyproject.toml with [build-system] using uv → prefer "uv" over "pip"
_UV_MARKER = re.compile(r'^\[build-system\].*?requires.*?uv', re.DOTALL | re.MULTILINE)
_UV_TOOL_SECTION = re.compile(r'^\[tool\.uv\]', re.MULTILINE)


def _refine_python_package_manager(project_root: Path) -> str:
    """Return 'uv' if pyproject.toml references uv, otherwise 'pip'."""
    pyproject = project_root / "pyproject.toml"
    if pyproject.exists():
        text = pyproject.read_text(encoding="utf-8", errors="replace")
        if _UV_MARKER.search(text) or _UV_TOOL_SECTION.search(text):
            return "uv"
    return "pip"


def detect_package_manager(project_root: Path) -> tuple[str | None, str | None]:
    """Return (package_manager_name, lockfile_name) for the first matching indicator."""
    for filename, pm_name in LOCKFILE_CANDIDATES:
        candidate = project_root / filename
        if candidate.exists():
            # Refine generic Python fallback.
            if filename == "pyproject.toml" and pm_name == "pip":
                pm_name = _refine_python_package_manager(project_root)
            return pm_name, filename
    return None, None


# ---------------------------------------------------------------------------
# Framework / tech detection
# ---------------------------------------------------------------------------

# Each entry: (config_filename_or_glob_stem, tech_name)
# For glob stems, we check whether any file matching "<stem>.*" exists.
FRAMEWORK_CANDIDATES: list[tuple[str, str]] = [
    ("angular.json", "angular"),
    ("next.config.js", "nextjs"),
    ("next.config.ts", "nextjs"),
    ("next.config.mjs", "nextjs"),
    ("nuxt.config.js", "nuxt"),
    ("nuxt.config.ts", "nuxt"),
    # vite.config.* — detected by stem scan below
    # svelte.config.* — detected by stem scan below
    ("config/routes.rb", "rails"),
    ("manage.py", "django"),
    ("go.mod", "go"),
]

# Glob-stem based detections: any file matching "<stem>.*" triggers the tech.
FRAMEWORK_GLOB_STEMS: list[tuple[str, str]] = [
    ("vite.config", "vite"),
    ("svelte.config", "svelte"),
]


def _glob_stem_exists(project_root: Path, stem: str) -> str | None:
    """Return the first filename matching <stem>.* in project_root, or None."""
    matches = sorted(project_root.glob(f"{stem}.*"))
    if matches:
        return matches[0].name
    return None


def _extract_version_from_package_json(project_root: Path, package_name: str) -> str | None:
    """Read package.json and return the version for package_name from deps or devDeps."""
    pkg_path = project_root / "package.json"
    if not pkg_path.exists():
        return None
    try:
        data = json.loads(pkg_path.read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError):
        return None
    for section in ("dependencies", "devDependencies"):
        version_raw = data.get(section, {}).get(package_name)
        if version_raw:
            # Strip leading ^ ~ >= etc. and return bare semver where possible.
            cleaned = re.sub(r'^[^0-9]*', '', str(version_raw))
            return cleaned if cleaned else version_raw
    return None


# Map tech name → primary npm package name used for version look-up.
TECH_NPM_PACKAGE: dict[str, str] = {
    "angular": "@angular/core",
    "nextjs": "next",
    "nuxt": "nuxt",
    "vite": "vite",
    "svelte": "svelte",
}


def detect_tech(project_root: Path) -> tuple[str | None, str | None, str | None]:
    """Return (tech_name, framework_config_filename, version).

    Checks exact filenames first, then glob stems. For JS/TS frameworks,
    attempts version extraction from package.json.
    """
    # Exact filename checks.
    for filename, tech in FRAMEWORK_CANDIDATES:
        if (project_root / filename).exists():
            version = None
            npm_pkg = TECH_NPM_PACKAGE.get(tech)
            if npm_pkg:
                version = _extract_version_from_package_json(project_root, npm_pkg)
            return tech, filename, version

    # Glob-stem checks.
    for stem, tech in FRAMEWORK_GLOB_STEMS:
        config_file = _glob_stem_exists(project_root, stem)
        if config_file:
            version = None
            npm_pkg = TECH_NPM_PACKAGE.get(tech)
            if npm_pkg:
                version = _extract_version_from_package_json(project_root, npm_pkg)
            return tech, config_file, version

    return None, None, None


# ---------------------------------------------------------------------------
# Linter detection
# ---------------------------------------------------------------------------

# Each entry: (indicator_path_or_glob_stem, linter_name, is_glob_stem)
LINTER_CANDIDATES: list[tuple[str, str, bool]] = [
    # ESLint — exact filenames come first, then glob stems
    (".eslintrc.json", "eslint", False),
    (".eslintrc.js", "eslint", False),
    (".eslintrc.cjs", "eslint", False),
    (".eslintrc.yaml", "eslint", False),
    (".eslintrc.yml", "eslint", False),
    (".eslintrc", "eslint", False),
    ("eslint.config", "eslint", True),   # eslint.config.js / .mjs / .ts etc.
    # Prettier
    (".prettierrc", "prettier", False),
    (".prettierrc.json", "prettier", False),
    (".prettierrc.js", "prettier", False),
    (".prettierrc.cjs", "prettier", False),
    (".prettierrc.yaml", "prettier", False),
    (".prettierrc.yml", "prettier", False),
    (".prettierrc.toml", "prettier", False),
    # RuboCop
    (".rubocop.yml", "rubocop", False),
]

_RUFF_SECTION = re.compile(r'^\[tool\.ruff\]', re.MULTILINE)
_BLACK_SECTION = re.compile(r'^\[tool\.black\]', re.MULTILINE)


def detect_linters(project_root: Path) -> list[str]:
    """Return a sorted, de-duplicated list of detected linter names."""
    found: set[str] = set()

    for indicator, linter_name, is_glob_stem in LINTER_CANDIDATES:
        if linter_name in found:
            continue
        if is_glob_stem:
            if _glob_stem_exists(project_root, indicator):
                found.add(linter_name)
        else:
            if (project_root / indicator).exists():
                found.add(linter_name)

    # pyproject.toml — ruff and/or black sections.
    pyproject = project_root / "pyproject.toml"
    if pyproject.exists():
        text = pyproject.read_text(encoding="utf-8", errors="replace")
        if _RUFF_SECTION.search(text):
            found.add("ruff")
        if _BLACK_SECTION.search(text):
            found.add("black")

    return sorted(found)


# ---------------------------------------------------------------------------
# Installed guide detection
# ---------------------------------------------------------------------------

def detect_installed_guides(project_root: Path) -> dict:
    """Return lists of relative paths for already-installed style guide files."""
    code_standards_dir = project_root / "docs" / "CLAUDE" / "code-standards"
    review_rules_dir = project_root / ".github" / "review-rules"

    def _list_files(directory: Path) -> list[str]:
        if not directory.exists() or not directory.is_dir():
            return []
        return sorted(
            str(p.relative_to(project_root))
            for p in directory.iterdir()
            if p.is_file()
        )

    return {
        "code_standards": _list_files(code_standards_dir),
        "review_rules": _list_files(review_rules_dir),
    }


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def detect_stack(project_root: Path) -> dict:
    """Run all detection passes and return the combined result dict."""
    package_manager, lockfile = detect_package_manager(project_root)
    tech, framework_config, version = detect_tech(project_root)
    linters = detect_linters(project_root)
    guides_installed = detect_installed_guides(project_root)

    return {
        "status": "ok",
        "package_manager": package_manager,
        "lockfile": lockfile,
        "tech": tech,
        "version": version,
        "framework_config": framework_config,
        "linters": linters,
        "guides_installed": guides_installed,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Detect the tech stack of a project and emit a structured JSON report. "
            "Used by Stage 1 of the install-styleguide workflow to avoid spending "
            "500-800 tokens on deterministic file-checking inside the LLM prompt."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  uv run is-detect-stack.py /path/to/project\n"
            "  uv run is-detect-stack.py /path/to/project --pretty\n"
            "  uv run is-detect-stack.py /path/to/project -o .is-stack-detection.json\n"
        ),
    )
    parser.add_argument(
        "project_root",
        help="Absolute or relative path to the project root to inspect.",
    )
    parser.add_argument(
        "-o", "--output",
        metavar="FILE",
        help="Write JSON output to FILE instead of stdout.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output (indent=2).",
    )
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()

    if not project_root.exists() or not project_root.is_dir():
        result = {
            "status": "error",
            "error": f"project_root does not exist or is not a directory: {project_root}",
            "package_manager": None,
            "lockfile": None,
            "tech": None,
            "version": None,
            "framework_config": None,
            "linters": [],
            "guides_installed": {"code_standards": [], "review_rules": []},
        }
    else:
        result = detect_stack(project_root)

    output_text = json.dumps(result, indent=2) if args.pretty else json.dumps(result)

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output_text + "\n", encoding="utf-8")
    else:
        print(output_text)

    return 0


if __name__ == "__main__":
    sys.exit(main())
