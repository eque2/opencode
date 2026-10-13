#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
cs-resolve-test-dir.py — Deterministic test-directory resolver for the create-spec workflow.

Used by Stage 3 (03-investigate.md) to locate the project's test directory without
relying on the LLM to run shell commands inside a prompt. Applies four strategies in
priority order and emits a structured JSON result:

  1. context_file  — reads a pre-existing context.md for a "Test Patterns" section
                     containing a `TEST_DIR:` or `test_dir:` hint.
  2. common_pattern — probes a ranked list of conventional test-directory patterns
                      relative to the project root using Path.glob().
  3. find_match    — runs `find <project_root> -name '<hint>' -type f` (via subprocess)
                     and takes the parent directory of the first match.
  4. fallback      — returns `test/`; caller should log a warning.

Output JSON:

  {
    "status": "ok",
    "test_dir": "src/tests/scenarios",
    "method": "find_match",
    "hint_used": "verify-*.spec.ts"
  }

Usage:
    uv run cs-resolve-test-dir.py <project_root>
    uv run cs-resolve-test-dir.py <project_root> --hint 'verify-*.spec.ts' --pretty
    uv run cs-resolve-test-dir.py <project_root> --context-file docs/features/PROJ-42/context.md -o .test-dir.json

Exit code is always 0 — the caller inspects `status` and `method` to decide how to
proceed. The script never raises for ordinary lookup failures.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

# Ranked list of common test-directory patterns to probe with Path.glob().
# Earlier entries take priority over later ones.
COMMON_PATTERNS: list[str] = [
    "src/*/test/scenarios/",
    "src/*/test/",
    "src/test/scenarios/",
    "src/test/",
    "tests/scenarios/",
    "tests/",
    "test/scenarios/",
    "test/",
    "e2e/",
]

DEFAULT_HINT = "verify-*.spec.ts"

# Regex for TEST_DIR hint lines inside a context.md "Test Patterns" section.
# Matches bare `TEST_DIR: <value>` / `test_dir: <value>` as well as the
# markdown decoration an LLM-authored context.md commonly adds: a leading
# bullet, bold markers around the key, and/or backticks around the value
# (e.g. `- **TEST_DIR:** \`apps/ui/src/components/media-player\``). Also
# accepts the "Test directory:" prose form. A bare "TEST_DIR" with no value
# (e.g. a section heading fragment) does not match — group(1) requires content.
_TEST_DIR_RE = re.compile(
    r"^\s*(?:[-*]\s+)?(?:\*\*)?(?:TEST[_ ]?DIR(?:ECTORY)?|Test\s+directory)\b(?:\*\*)?\s*:?\s*"
    r"(?:\*\*)?\s*`?([^`\n*]+?)`?\s*\**\s*$",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Resolution strategies
# ---------------------------------------------------------------------------


def _try_context_file(context_file: Path) -> str | None:
    """Strategy 1: look for TEST_DIR: inside a "Test Patterns" section."""
    if not context_file or not context_file.exists():
        return None

    try:
        text = context_file.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    in_test_patterns = False
    for line in text.splitlines():
        stripped = line.strip()
        # Detect the section heading (any markdown level).
        if re.match(r"^#+\s+[Tt]est\s+[Pp]atterns\b", stripped):
            in_test_patterns = True
            continue
        # Stop when we hit the next section heading.
        if in_test_patterns and re.match(r"^#+\s+", stripped):
            in_test_patterns = False
            continue
        if in_test_patterns:
            m = _TEST_DIR_RE.match(line)
            if m:
                value = m.group(1).strip().strip("`'\"")
                if value:
                    return value

    return None


def _try_common_patterns(project_root: Path) -> str | None:
    """Strategy 2: probe COMMON_PATTERNS in order; return the first that exists."""
    for pattern in COMMON_PATTERNS:
        # Path.glob() on a pattern ending in '/' returns only directories.
        # We strip the trailing slash so exists() / is_dir() can be used directly.
        clean = pattern.rstrip("/")
        # Patterns that contain a '*' (e.g. "src/*/test/") use glob.
        if "*" in clean:
            matches = sorted(project_root.glob(clean))
            for match in matches:
                if match.is_dir():
                    return str(match.relative_to(project_root))
        else:
            candidate = project_root / clean
            if candidate.is_dir():
                return clean

    return None


def _try_find_match(project_root: Path, hint: str) -> str | None:
    """Strategy 3: shell `find` for files matching the hint glob; use parent of first hit."""
    try:
        completed = subprocess.run(
            ["find", str(project_root), "-name", hint, "-type", "f"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        lines = [ln.strip() for ln in completed.stdout.splitlines() if ln.strip()]
        if not lines:
            return None
        first_match = Path(lines[0])
        parent = first_match.parent
        # Return path relative to project_root when possible.
        try:
            return str(parent.relative_to(project_root))
        except ValueError:
            return str(parent)
    except (OSError, subprocess.TimeoutExpired):
        return None


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def resolve_test_dir(
    project_root: Path,
    hint: str,
    context_file: Path | None,
) -> dict:
    """Run the four strategies in order and return the structured result dict."""

    # Strategy 1 — context_file hint.
    value = _try_context_file(context_file)
    if value is not None:
        return {
            "status": "ok",
            "test_dir": value,
            "method": "context_file",
            "hint_used": hint,
        }

    # Strategy 2 — common patterns.
    value = _try_common_patterns(project_root)
    if value is not None:
        return {
            "status": "ok",
            "test_dir": value,
            "method": "common_pattern",
            "hint_used": hint,
        }

    # Strategy 3 — find match.
    value = _try_find_match(project_root, hint)
    if value is not None:
        return {
            "status": "ok",
            "test_dir": value,
            "method": "find_match",
            "hint_used": hint,
        }

    # Strategy 4 — fallback.
    return {
        "status": "ok",
        "test_dir": "test/",
        "method": "fallback",
        "hint_used": hint,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Resolve the test directory for a project root. "
            "Emits structured JSON on stdout (or to --output); never exits non-zero."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  uv run cs-resolve-test-dir.py /path/to/project\n"
            "  uv run cs-resolve-test-dir.py /path/to/project --hint 'verify-*.spec.ts' --pretty\n"
            "  uv run cs-resolve-test-dir.py /path/to/project "
            "--context-file docs/features/PROJ-42/context.md -o .test-dir.json\n"
        ),
    )
    parser.add_argument(
        "project_root",
        help="Absolute or relative path to the project root.",
    )
    parser.add_argument(
        "--hint",
        default=DEFAULT_HINT,
        help=(
            f"File glob pattern to pass to `find` when common patterns don't match. "
            f"Default: {DEFAULT_HINT!r}."
        ),
    )
    parser.add_argument(
        "--context-file",
        dest="context_file",
        default=None,
        help=(
            "Path to an existing context.md. If the file contains a 'Test Patterns' "
            "section with a TEST_DIR line, that value is used immediately (strategy 1)."
        ),
    )
    parser.add_argument(
        "-o",
        "--output",
        default=None,
        help="Write JSON result to this file path instead of stdout.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output (human-readable).",
    )
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    context_file = Path(args.context_file).resolve() if args.context_file else None

    result = resolve_test_dir(project_root, args.hint, context_file)

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
