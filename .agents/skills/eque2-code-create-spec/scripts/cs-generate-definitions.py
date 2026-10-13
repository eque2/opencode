#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
cs-generate-definitions.py — Stage 10 definitions emitter.

Reads `tasks.md`, `scenarios.gherkin`, `spec.md`, and `context.md` from a
feature folder and emits a single:

    {feature_root}/definitions.json

…conforming to `schemas/actor-definitions@1`. This file is the sole handoff
from the spec workflow to the state CLI; `state.ts init` reads it, constructs
the canonical XState snapshots in-memory, and persists them to the signed
plaintext event log (`state/events.jsonl`). This script does not write
`state/*.json` files itself.

The script is deterministic. Re-running it on the same inputs produces the
same output. Structural errors (a task supporting a non-existent scenario,
etc.) are reported in the JSON result and exit code 1 is returned — fix the
spec and re-run.

Usage:
    uv run cs-generate-definitions.py <feature_root> [--test-dir-from-context] [--pretty] [--verbose]
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


SCHEMA_URI = "schemas/actor-definitions@1"


sys.path.insert(0, str(Path(__file__).resolve().parent))
from scenario_id_grammar import (  # noqa: E402 — sibling module, shipped with this script
    ACTOR_DEFINITIONS_SCHEMA,
    GrammarUnavailable,
    load_grammar,
)

# Loaded at import but NEVER raised here: a missing schema is reported by
# main() in this script's normal JSON failure shape.
try:
    GRAMMAR = load_grammar()
    GRAMMAR_ERROR: str | None = None
except GrammarUnavailable as _e:
    GRAMMAR = None
    GRAMMAR_ERROR = str(_e)
SCENARIO_ID_SOURCE = GRAMMAR.source if GRAMMAR else None
SCENARIO_ID_RE = GRAMMAR.id_re if GRAMMAR else None
SCENARIO_FILE_RE = GRAMMAR.file_re if GRAMMAR else None


# ---------------------------------------------------------------------------
# Parsing helpers (carried over from the retired cs-generate-snapshots.py —
# kept independent so the generator can run without any other script present)
# ---------------------------------------------------------------------------


def parse_frontmatter(text: str) -> dict:
    """Pull a flat dict out of a markdown file's YAML frontmatter."""
    stripped = text.lstrip("﻿").lstrip()
    if not stripped.startswith("---"):
        return {}
    body = stripped[3:]
    nl_idx = body.find("\n")
    if nl_idx < 0:
        return {}
    body = body[nl_idx + 1 :]
    closing = re.search(r"^---\s*$", body, re.MULTILINE)
    if not closing:
        return {}
    fm_text = body[: closing.start()]
    out: dict = {}
    for raw in fm_text.splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        out[key] = value
    return out


def _split_ids(raw: str) -> list[str]:
    parts = re.split(r"[,/;]\s*|\s+and\s+", raw)
    out: list[str] = []
    for p in parts:
        p = p.strip().strip("`").rstrip(".")
        if not p or p in ("—", "-"):
            continue
        p = re.sub(r"\s*\(.*\)\s*$", "", p)
        out.append(p)
    return out


def parse_tasks(tasks_path: Path) -> list[dict]:
    """Parse tasks.md into a list of task dicts."""
    if not tasks_path.exists():
        return []
    lines = tasks_path.read_text(encoding="utf-8", errors="replace").splitlines()
    heading_re = re.compile(r"^#{2,4}\s+(T\d+(?:\.\d+)?)\s*:?\s*(.*)$")
    headings: list[tuple[int, str, str]] = []
    for i, raw in enumerate(lines):
        m = heading_re.match(raw.strip())
        if m:
            headings.append((i, m.group(1), m.group(2).strip()))

    bounds: list[tuple[int, int, str, str]] = []
    for idx, (start, tid, after) in enumerate(headings):
        end = headings[idx + 1][0] if idx + 1 < len(headings) else len(lines)
        bounds.append((start, end, tid, after))

    # The colon is MANDATORY in every field pattern. With an optional colon a
    # hard-wrapped prose line beginning with a keyword ("tests and extends it
    # ONLY if…" from a Goal paragraph) matched first and captured garbage as
    # the field value ("file": "and" — 2026-07-04 field report). The tasks.md
    # contract (07-tasks.md) writes every field as `**Field:** value`; both
    # `**Field:** value` and `**Field**: value` colon placements are accepted.
    def _field(keyword: str) -> re.Pattern[str]:
        return re.compile(
            rf"^\s*(?:\*\*)?{keyword}(?:\s*\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$",
            re.IGNORECASE,
        )

    field_patterns = {
        "file": _field(r"File(?:\(s\))?"),
        "tests": _field(r"Tests?"),
        "supports": _field(r"Supports(?:\s+Scenarios)?"),
        "goal": _field(r"Goal"),
        "action": _field(r"Action"),
        "dependson": _field(r"(?:Depends\s*On|Dependencies)"),
        "phase": _field(r"Phase"),
        "workdir": _field(r"Working\s*Dir(?:ectory)?"),
    }

    tasks: dict[str, dict] = {}
    order: list[str] = []
    for start, end, tid, after_heading in bounds:
        task: dict = {
            "id": tid,
            "phase": None,
            "heading_line": start + 1,
            "description": after_heading or "",
            "file": None,
            "tests": None,
            "supports": [],
            "depends_on": [],
            "working_directory": "",
        }
        phase_match = re.match(r"^T(\d+)", tid)
        if phase_match:
            task["phase"] = phase_match.group(1)

        in_files_block = False
        for j in range(start + 1, end):
            stripped = lines[j].strip()
            if not stripped:
                in_files_block = False
                continue
            m = field_patterns["file"].match(stripped)
            if m and not task["file"]:
                task["file"] = m.group(1).strip().strip("`")
                continue
            m = field_patterns["tests"].match(stripped)
            if m and not task["tests"]:
                task["tests"] = m.group(1).strip()
                continue
            m = field_patterns["supports"].match(stripped)
            if m and not task["supports"]:
                task["supports"] = _split_ids(m.group(1).strip())
                continue
            m = field_patterns["dependson"].match(stripped)
            if m and not task["depends_on"]:
                deps = _split_ids(m.group(1).strip())
                task["depends_on"] = [d for d in deps if d not in ("—", "-")]
                continue
            m = field_patterns["goal"].match(stripped)
            if m and not task["description"]:
                task["description"] = m.group(1).strip()
                continue
            m = field_patterns["action"].match(stripped)
            if m:
                task["description"] = m.group(1).strip()
                continue
            m = field_patterns["phase"].match(stripped)
            if m and not task["phase"]:
                task["phase"] = m.group(1).strip().strip("`'\"")
                continue
            m = field_patterns["workdir"].match(stripped)
            if m:
                task["working_directory"] = m.group(1).strip().strip("`")
                continue
            if re.match(r"^\s*(?:\*\*)?Files?\s+to\s+(Create|Modify|Create/Modify)\b", stripped, re.IGNORECASE):
                in_files_block = True
                continue
            if in_files_block and not task["file"]:
                cleaned = stripped.lstrip("-*").strip().strip("`")
                cleaned = re.sub(r"\s*\((UPDATE|NEW)\)\s*$", "", cleaned, flags=re.IGNORECASE)
                if cleaned:
                    task["file"] = cleaned

        if not task["description"]:
            for j in range(start + 1, end):
                stripped = lines[j].strip()
                if not stripped or stripped.startswith("#"):
                    continue
                if any(p.match(stripped) for p in field_patterns.values()):
                    continue
                cleaned = stripped.lstrip("-*").strip()
                if cleaned and not cleaned.startswith("|"):
                    task["description"] = cleaned
                    break

        if tid not in tasks:
            order.append(tid)
        tasks[tid] = task
    return [tasks[tid] for tid in order]


# CAP-5 / D7: canonical "run the whole file" sentinel. The verifier's
# verifyStructural recognises this exact string and skips the literal grep.
FULL_SUITE_SENTINEL = "(full suite)"


def _clean_test_pattern(pattern: str) -> str:
    """Strip markdown artifacts from a test pattern (CAP-5, Issue #2 Problem B).

    A generation bug concatenated the sentinel with a trailing markdown header,
    e.g. "(full suite)**Test Cases:**". Cut everything from the first markdown
    bold/header marker (``**``) onward, then normalise the full-suite sentinel
    to its canonical lowercase form. A pattern that is pure markdown collapses
    to empty (no pattern emitted).
    """
    pattern = re.split(r"\*\*", pattern, maxsplit=1)[0].strip()
    if pattern.lower() == FULL_SUITE_SENTINEL:
        return FULL_SUITE_SENTINEL
    return pattern


def parse_tests_field(raw: str | None) -> list[dict]:
    """Convert a Tests: line into [{file, pattern?}] entries."""
    if not raw:
        return []
    raw = raw.strip().rstrip(".")
    out: list[dict] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        tokens = [t for t in re.split(r"\s+", part) if t]
        if not tokens:
            continue
        entry: dict = {"file": tokens[0].strip("`")}
        if len(tokens) > 1:
            pattern = " ".join(tokens[1:]).strip()
            pattern = re.sub(r"^pattern\s*:\s*", "", pattern, flags=re.IGNORECASE)
            pattern = _clean_test_pattern(pattern)
            if pattern:
                entry["pattern"] = pattern
        out.append(entry)
    return out


def parse_scenarios(gherkin_path: Path) -> list[dict]:
    """Parse scenarios.gherkin into [{id, description, gherkin}]."""
    if not gherkin_path.exists():
        return []
    text = gherkin_path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    scenario_starts: list[tuple[int, str, str]] = []
    for idx, raw in enumerate(lines):
        m = re.match(r"^\s*Scenario(?:\s+Outline)?\s*:\s*(\S+)\s*(.*)$", raw.strip())
        if m:
            sid = m.group(1).rstrip(":")
            desc = m.group(2).strip()
            scenario_starts.append((idx, sid, desc))

    scenarios: list[dict] = []
    for i, (start, sid, desc) in enumerate(scenario_starts):
        end = scenario_starts[i + 1][0] if i + 1 < len(scenario_starts) else len(lines)
        gherkin_block = "\n".join(lines[start:end]).rstrip()
        scenarios.append({"id": sid, "description": desc, "gherkin": gherkin_block})
    return scenarios


def extract_build_check_command(gherkin_block: str) -> str:
    """Extract the shell command from a BUILD-N Gherkin block.

    Looks for patterns like:
        When I run `pnpm build`
        When running `npm test`
    Falls back to the scenario description if no match.
    """
    m = re.search(
        r"^\s*When\s+(?:I\s+run|running)\s+`([^`]+)`",
        gherkin_block,
        re.IGNORECASE | re.MULTILINE,
    )
    if m:
        return m.group(1).strip()
    # secondary: bare quoted string on a When line
    m = re.search(
        r"^\s*When\s+.*[\"']([^\"']+)[\"']",
        gherkin_block,
        re.IGNORECASE | re.MULTILINE,
    )
    if m:
        return m.group(1).strip()
    return ""


def extract_test_dir(context_text: str) -> str | None:
    """Find a TEST_DIR value in context.md.

    Whitespace inside the patterns is [^\\S\\n] (horizontal only): a match must
    never cross a newline. A bare "TEST_DIR" at end-of-line (e.g. the
    "## Test patterns / TEST_DIR" heading that [CS] itself writes) previously
    let \\s consume the newline and capture the entire next line — poisoning
    every scenario testFile with a literal "TEST_DIR: " prefix (2026-07-03
    field report). Captures are also sanity-checked: a directory value never
    contains a colon and is never the TEST_DIR marker itself; an invalid
    capture is skipped so extraction fails through to the fallback resolver
    rather than succeeding wrongly.
    """
    patterns = [
        re.compile(
            r"(?:\*\*)?TEST[_ ]?DIR[^\S\n]*:?[^\S\n]*(?:\*\*)?[^\S\n]*:?[^\S\n]*"
            r"`?([^`\n*]+?)`?[^\S\n]*\**[^\S\n]*$",
            re.IGNORECASE | re.MULTILINE,
        ),
        re.compile(
            r"(?:\*\*)?Test[^\S\n]+directory[^\S\n]*:?[^\S\n]*(?:\*\*)?[^\S\n]*:?[^\S\n]*"
            r"`?([^`\n*]+?)`?[^\S\n]*\**[^\S\n]*$",
            re.IGNORECASE | re.MULTILINE,
        ),
    ]
    for pat in patterns:
        for m in pat.finditer(context_text):
            value = m.group(1).strip().strip("`'\"")
            if not value or ":" in value or re.fullmatch(r"TEST[_ ]?DIR", value, re.IGNORECASE):
                continue
            return value
    return None


def _resolve_test_dir_fallback(feature_root: Path, context_path: Path) -> str:
    """Resolve the project's test directory via cs-resolve-test-dir.py.

    The feature root is `{project}/…/features/{slug}` (typically
    `{project}/_bmad-output/features/{slug}`), so the project root is three
    levels up; fall back to the feature root itself if the tree is shallower.
    The resolver's strategy chain never fails (its last strategy returns
    "test/"), and this fallback mirrors that if the import itself breaks.
    """
    project_root = feature_root.parents[2] if len(feature_root.parents) >= 3 else feature_root
    try:
        import importlib.util

        resolver_path = Path(__file__).resolve().parent / "cs-resolve-test-dir.py"
        spec = importlib.util.spec_from_file_location("cs_resolve_test_dir", resolver_path)
        module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        spec.loader.exec_module(module)  # type: ignore[union-attr]
        result = module.resolve_test_dir(
            project_root,
            "verify-*.spec.ts",
            context_path if context_path.exists() else None,
        )
        return str(result["test_dir"])
    except Exception:
        return "test/"


def _sort_key(task_id: str) -> tuple[int, int]:
    m = re.match(r"^T(\d+)(?:\.(\d+))?$", task_id)
    if not m:
        return (10_000, 0)
    return (int(m.group(1)), int(m.group(2) or 0))


# ---------------------------------------------------------------------------
# Core generator
# ---------------------------------------------------------------------------


def generate(
    feature_root: Path,
    *,
    use_test_dir_from_context: bool,
    pretty: bool,
) -> dict:
    errors: list[dict] = []

    spec_path = feature_root / "spec.md"
    tasks_path = feature_root / "tasks.md"
    scenarios_path = feature_root / "scenarios.gherkin"
    context_path = feature_root / "context.md"
    out_path = feature_root / "definitions.json"

    feature_id = feature_root.name

    # spec_slug from frontmatter, fall back to feature_id
    spec_slug = feature_id
    if spec_path.exists():
        fm = parse_frontmatter(spec_path.read_text(encoding="utf-8", errors="replace"))
        spec_slug = fm.get("specSlug") or fm.get("slug") or feature_id

    test_dir: str | None = None
    if use_test_dir_from_context and context_path.exists():
        test_dir = extract_test_dir(context_path.read_text(encoding="utf-8", errors="replace"))
    if test_dir is None:
        # NEVER fall through to a literal "{TEST_DIR}" placeholder — the state
        # engine performs no substitution, so a placeholder path is stat'd
        # literally at verify time and the scenario can never verify (the
        # 2026-07-03 {TEST_DIR} defect deadlocked every consumer spec).
        # Resolve via the sibling four-strategy resolver instead; its final
        # strategy always yields a value ("test/"), so test_dir is never None
        # past this point.
        test_dir = _resolve_test_dir_fallback(feature_root, context_path)

    tasks = parse_tasks(tasks_path)
    scenarios = parse_scenarios(scenarios_path)
    scenario_ids = {s["id"] for s in scenarios}

    # Split tasks into parent tasks vs subtasks
    parents: dict[str, dict] = {}
    subtasks: list[dict] = []

    for task in tasks:
        tid = task["id"]
        if "." in tid:
            parent_id, _, _ = tid.partition(".")
            subtasks.append(task)
            parents.setdefault(parent_id, {
                "id": parent_id,
                "description": f"Phase {task.get('phase') or parent_id.lstrip('T')}",
                "phase": task.get("phase") or parent_id.lstrip("T"),
            })
        else:
            parents[tid] = {
                "id": tid,
                "description": (task.get("description") or "").strip()
                    or f"Phase {task.get('phase') or tid.lstrip('T')}",
                "phase": task.get("phase") or tid.lstrip("T"),
            }

    # Build parentTasks array (sorted)
    parent_task_defs = [
        {
            "id": p["id"],
            "description": p["description"],
            "phase": str(p["phase"]),
        }
        for p in sorted(parents.values(), key=lambda p: _sort_key(p["id"]))
    ]

    # Build tasks (subtasks) array
    task_defs = []
    for task in subtasks:
        valid_supports: list[str] = []
        for sid in task.get("supports", []):
            if sid in scenario_ids:
                valid_supports.append(sid)
            else:
                errors.append({
                    "file": "tasks.md",
                    "issue": (
                        f"Task {task['id']} supports {sid!r} which is not "
                        f"declared in scenarios.gherkin."
                    ),
                })
        depends_on = [d for d in task.get("depends_on", []) if d]
        task_defs.append({
            "id": task["id"],
            "description": task.get("description") or "",
            "phase": str(task.get("phase") or "1"),
            "workingDirectory": task.get("working_directory") or "",
            "dependsOn": depends_on,
            "supportsScenarios": valid_supports,
            "tests": parse_tests_field(task.get("tests")),
        })

    # Split scenarios into regular scenarios vs build checks
    scenario_defs = []
    build_check_defs = []
    for sc in scenarios:
        sid = sc["id"]
        if not GRAMMAR.is_id(sid):
            errors.append({
                "file": "scenarios.gherkin",
                "issue": (
                    f"Scenario id {sid!r} does not match the scenario id grammar "
                    f"({SCENARIO_ID_SOURCE}). The reporter could never route its "
                    f"evidence. Use an id such as S1, DELIVERY-2 or BUILD-1."
                ),
            })
            continue
        if sid.startswith("BUILD-"):
            command = extract_build_check_command(sc.get("gherkin", ""))
            if not command:
                # Use description as a fallback hint
                command = sc.get("description") or sid
            build_check_defs.append({
                "id": sid,
                "description": sc.get("description") or "",
                "command": command,
                "workingDirectory": "",
            })
        else:
            # test_dir is always resolved by this point (context extraction or
            # the resolver fallback) — the literal "{TEST_DIR}" placeholder is
            # deliberately unreachable and state_init now rejects it anyway.
            test_file = f"{test_dir.rstrip('/')}/verify-{feature_id}-{sid}.spec.ts"
            routed = GRAMMAR.routed_id(Path(test_file).name)
            if routed != sid:
                errors.append({
                    "file": "scenarios.gherkin",
                    "issue": (
                        f"Scenario {sid!r}: testFile {Path(test_file).name!r} routes to "
                        f"{routed!r}, not {sid!r}. "
                        f"Rename the feature folder or the scenario id."
                    ),
                })
                continue
            entry: dict = {
                "id": sid,
                "description": sc.get("description") or "",
                "testFile": test_file,
                "workingDirectory": "",
            }
            if sc.get("gherkin"):
                entry["gherkin"] = sc["gherkin"]
            scenario_defs.append(entry)

    definitions = {
        "$schema": SCHEMA_URI,
        "specSlug": spec_slug,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "parentTasks": parent_task_defs,
        "tasks": task_defs,
        "scenarios": scenario_defs,
        "buildChecks": build_check_defs,
    }

    if not errors:
        out_path.write_text(
            json.dumps(definitions, indent=2) + "\n" if pretty
            else json.dumps(definitions) + "\n",
            encoding="utf-8",
        )

    return {
        "status": "ok" if not errors else "failed",
        "feature_id": feature_id,
        "counts": {
            "parentTasks": len(parent_task_defs),
            "tasks": len(task_defs),
            "scenarios": len(scenario_defs),
            "buildChecks": len(build_check_defs),
        },
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Emit definitions.json from spec content (Stage 10). "
            "Outputs structured JSON on stdout. Exit code 1 if structural issues found."
        ),
    )
    parser.add_argument("feature_root", help="Path to a single feature folder.")
    parser.add_argument(
        "--test-dir-from-context",
        action="store_true",
        help="Extract TEST_DIR from context.md and use it in scenario testFile paths.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print the emitted definitions.json (stdout summary is always compact).",
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Diagnostics to stderr.")
    args = parser.parse_args()

    feature_root = Path(args.feature_root).resolve()

    if args.verbose:
        print(f"feature_root: {feature_root}", file=sys.stderr)
        print(f"test_dir_from_context: {args.test_dir_from_context}", file=sys.stderr)

    if GRAMMAR_ERROR is not None:
        result = {
            "status": "failed",
            "feature_id": feature_root.name,
            "counts": {"parentTasks": 0, "tasks": 0, "scenarios": 0, "buildChecks": 0},
            "errors": [{"file": str(ACTOR_DEFINITIONS_SCHEMA), "issue": GRAMMAR_ERROR}],
        }
    elif not feature_root.is_dir():
        result = {
            "status": "failed",
            "feature_id": None,
            "counts": {"parentTasks": 0, "tasks": 0, "scenarios": 0, "buildChecks": 0},
            "errors": [{"file": str(feature_root), "issue": "Feature root does not exist."}],
        }
    else:
        result = generate(
            feature_root,
            use_test_dir_from_context=args.test_dir_from_context,
            pretty=args.pretty,
        )

    print(json.dumps(result))

    if args.verbose:
        c = result["counts"]
        print(
            f"parentTasks={c.get('parentTasks',0)} tasks={c.get('tasks',0)} "
            f"scenarios={c.get('scenarios',0)} buildChecks={c.get('buildChecks',0)} "
            f"errors={len(result['errors'])}",
            file=sys.stderr,
        )

    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
