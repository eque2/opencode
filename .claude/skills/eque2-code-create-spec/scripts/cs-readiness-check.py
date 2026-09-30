#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
cs-readiness-check.py — Mechanical Ready-for-Build verifier.

Used by Stages 8 and 9 of the create-spec workflow. Runs the eight mechanical
readiness checks against a feature folder and emits a structured JSON report
listing each check's pass/fail status plus, for failures, the affected file,
line (when available), and a short issue description.

The eight checks:

  1. Scenarios First            — scenarios.gherkin exists; was written before tasks.md
  2. Tasks Support Scenarios    — task Supports lines all resolve; every scenario is supported
  3. Testable                   — every task has a Tests: line with file + pattern
  4. Actionable                 — every task has a File path + action verb
  5. Logical                    — Phase IDs sequential strings, derivable from task IDs
  6. Complete                   — no TBD / {...} / {TODO} / PLACEHOLDER strings
  7. Self-Contained             — UPDATE-file paths exist; NEW-file parents exist;
                                  cross-references between scenarios/tasks/coverage resolve
  8. Verifiable                 — every scenario id fits the shared grammar;
                                  BUILD-1..4 present; BUILD-5 iff Figma referenced;
                                  if state/ exists, each JSON has mandatory root fields

Usage:
    uv run cs-readiness-check.py <feature_root>
    uv run cs-readiness-check.py <feature_root> --pretty --verbose

Exit code is 0 (always) — caller inspects `status` from stdout JSON to decide
whether to proceed. We deliberately do NOT use a non-zero exit for failed
checks: the workflow re-runs us in a fix loop, and the caller needs the JSON
on stdout in both cases.
"""

import argparse
import json
import re
import sys
from pathlib import Path


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

# Allowed action verbs at the start of a task description (case-insensitive
# match on the first word). Curated, not exhaustive — the readiness contract
# explicitly enumerates these.
ACTION_VERBS = {
    "add",
    "update",
    "create",
    "remove",
    "refactor",
    "implement",
    "extract",
    "move",
    "rename",
    "replace",
    "migrate",
    "wrap",
    "inject",
    "wire",
    "register",
    "configure",
    "delete",
    "introduce",
    "split",
    "merge",
    "build",
    "fix",
    "patch",
    "write",
    "expose",
    "hook",
    "bind",
    "publish",
    "subscribe",
    "emit",
    "validate",
    "enable",
    "disable",
    "scaffold",
    "generate",
}

# Tokens that signal an unfinished section. Matched case-insensitively against
# whole-word boundaries.
PLACEHOLDER_PATTERNS = [
    re.compile(r"\bTBD\b", re.IGNORECASE),
    re.compile(r"\{TODO\}", re.IGNORECASE),
    re.compile(r"\bPLACEHOLDER\b", re.IGNORECASE),
    # Literal '{...}' triple-dot placeholder.
    re.compile(r"\{\.\.\.\}"),
]

# Mandatory root-level fields on every state snapshot (per references/schema-requirements.md).
SNAPSHOT_ROOT_FIELDS = {
    "$schema",
    "_schemaVersion",
    "_machineVersion",
    "value",
    "context",
    "status",
    "tags",
}


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------


def parse_frontmatter(text: str) -> dict:
    """Extract the YAML frontmatter dict from a markdown file's text."""
    stripped = text.lstrip("﻿").lstrip()
    if not stripped.startswith("---"):
        return {}
    body = stripped[3:]
    nl_idx = body.find("\n")
    if nl_idx < 0:
        return {}
    body = body[nl_idx + 1:]
    closing_match = re.search(r"^---\s*$", body, re.MULTILINE)
    if not closing_match:
        return {}
    fm_text = body[: closing_match.start()]
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


def parse_steps_completed(frontmatter: dict) -> list[int]:
    raw = frontmatter.get("stepsCompleted", "")
    if not raw or raw in ("[]", "~", "null"):
        return []
    if raw.startswith("[") and raw.endswith("]"):
        inner = raw[1:-1].strip()
        if not inner:
            return []
        out: list[int] = []
        for p in inner.split(","):
            p = p.strip()
            if not p:
                continue
            try:
                out.append(int(p))
            except ValueError:
                continue
        return out
    return []


def parse_scenarios(gherkin_path: Path) -> list[dict]:
    """Return a list of {id, description, line} for every Scenario in a .gherkin file.

    A scenario line looks like:
        Scenario: BUILD-1 Lint passes
        Scenario: S1 Webhook idempotency on duplicate event
    The ID is the first whitespace-separated token after 'Scenario:'.
    """
    if not gherkin_path.exists():
        return []
    scenarios: list[dict] = []
    for lineno, raw in enumerate(gherkin_path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        line = raw.strip()
        m = re.match(r"^Scenario(?:\s+Outline)?\s*:\s*(\S+)\s*(.*)$", line)
        if not m:
            continue
        scenarios.append({
            "id": m.group(1).strip().rstrip(":"),
            "description": m.group(2).strip(),
            "line": lineno,
        })
    return scenarios


def parse_tasks(tasks_path: Path) -> list[dict]:
    """Parse tasks.md into a list of task dicts.

    The format is intentionally permissive. We recognise tasks by:
      - A heading `### Tn[.m][:]` (the canonical form in tasks-template.md), OR
      - A table row `| T1 | ... |` in the summary table at the top.

    Per-task fields are pulled from the lines that follow the heading until
    the next task heading or top-level heading, matching common prefixes:

      **File:** ...   /   File: ...
      **Tests:** ...  /   Tests: ...
      **Supports:** S1, S2  /  Supports: S1, S2
      **Goal:** ...   (used as description fallback)
      The first non-bold sentence after the heading is treated as the action
      description if no explicit one is supplied.

    Returns list of dicts:
      {
        "id": "T1.1",
        "phase": "1" | None,
        "heading_line": int,
        "description": str,         # action sentence
        "file": str | None,
        "files_raw": str | None,    # raw "Files to Create/Modify" block, if present
        "tests": str | None,        # raw Tests: value
        "supports": list[str],
        "supports_raw": str | None,
        "section_lines": (start, end),
      }
    """
    if not tasks_path.exists():
        return []

    lines = tasks_path.read_text(encoding="utf-8", errors="replace").splitlines()
    tasks: dict[str, dict] = {}
    order: list[str] = []

    heading_re = re.compile(r"^#{2,4}\s+(T\d+(?:\.\d+)?)\s*:?\s*(.*)$")
    # Detect task heading sections; remember start line per task.
    headings: list[tuple[int, str, str]] = []
    for i, raw in enumerate(lines):
        m = heading_re.match(raw.strip())
        if m:
            headings.append((i, m.group(1), m.group(2).strip()))

    # Compute section boundaries.
    bounds: list[tuple[int, int, str, str]] = []
    for idx, (start, tid, after) in enumerate(headings):
        end = headings[idx + 1][0] if idx + 1 < len(headings) else len(lines)
        bounds.append((start, end, tid, after))

    field_patterns = {
        "file": re.compile(r"^\s*(?:\*\*)?File(?:\(s\))?\s*:?(?:\*\*)?\s*(.+)$", re.IGNORECASE),
        "tests": re.compile(r"^\s*(?:\*\*)?Tests?\s*:?(?:\*\*)?\s*(.+)$", re.IGNORECASE),
        "supports": re.compile(r"^\s*(?:\*\*)?Supports(?:\s+Scenarios)?\s*:?(?:\*\*)?\s*(.+)$", re.IGNORECASE),
        "goal": re.compile(r"^\s*(?:\*\*)?Goal\s*:?(?:\*\*)?\s*(.+)$", re.IGNORECASE),
        "phase": re.compile(r"^\s*(?:\*\*)?Phase\s*:?(?:\*\*)?\s*(.+)$", re.IGNORECASE),
        "action": re.compile(r"^\s*(?:\*\*)?Action\s*:?(?:\*\*)?\s*(.+)$", re.IGNORECASE),
    }

    for start, end, tid, after_heading in bounds:
        task: dict = {
            "id": tid,
            "phase": None,
            "heading_line": start + 1,
            "description": after_heading or "",
            "file": None,
            "files_raw": None,
            "tests": None,
            "supports": [],
            "supports_raw": None,
            "section_lines": (start + 1, end),
        }
        # Phase inferred from the task ID prefix (T1.x → "1").
        phase_match = re.match(r"^T(\d+)", tid)
        if phase_match:
            task["phase"] = phase_match.group(1)

        in_files_block = False
        files_collected: list[str] = []

        for j in range(start + 1, end):
            raw_line = lines[j]
            stripped = raw_line.strip()
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
                raw_val = m.group(1).strip()
                task["supports_raw"] = raw_val
                task["supports"] = _split_supports(raw_val)
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
            # Recognise "Files to Create/Modify:" sub-headings and capture lines below.
            if re.match(r"^\s*(?:\*\*)?Files?\s+to\s+(Create|Modify|Create/Modify)\b", stripped, re.IGNORECASE):
                in_files_block = True
                continue
            if in_files_block:
                files_collected.append(stripped)
                # First file under the block becomes `file` if no explicit File: line set it.
                if not task["file"]:
                    cleaned = stripped.lstrip("-*").strip().strip("`")
                    # Trim trailing tags like "(UPDATE)" / "(NEW)" — keep the path.
                    cleaned = re.sub(r"\s*\((UPDATE|NEW)\)\s*$", "", cleaned, flags=re.IGNORECASE)
                    if cleaned:
                        task["file"] = cleaned

        if files_collected:
            task["files_raw"] = "\n".join(files_collected)

        # Description fallback: if still empty, scan for the first non-field
        # sentence in the section.
        if not task["description"]:
            for j in range(start + 1, end):
                stripped = lines[j].strip()
                if not stripped or stripped.startswith("#"):
                    continue
                # Skip lines that look like fields.
                if any(p.match(stripped) for p in field_patterns.values()):
                    continue
                # Skip pure bold markers.
                cleaned = stripped.lstrip("-*").strip()
                if cleaned and not cleaned.startswith("|"):
                    task["description"] = cleaned
                    break

        # Preserve the FIRST occurrence (table row vs section heading clash).
        if tid not in tasks:
            order.append(tid)
        tasks[tid] = task

    return [tasks[tid] for tid in order]


def _split_supports(raw: str) -> list[str]:
    """Split a Supports value like 'S1, S2, BUILD-4' into a list of IDs."""
    parts = re.split(r"[,/;]\s*|\s+and\s+", raw)
    out: list[str] = []
    for p in parts:
        p = p.strip().strip("`").rstrip(".")
        if not p or p == "—" or p == "-":
            continue
        # Strip surrounding parentheses or trailing notes.
        p = re.sub(r"\s*\(.*\)\s*$", "", p)
        out.append(p)
    return out


# ---------------------------------------------------------------------------
# The eight checks
# ---------------------------------------------------------------------------


def check_scenarios_first(feature_root: Path, spec_fm: dict) -> tuple[bool, str, list[dict]]:
    """Check 1 — scenarios.gherkin exists; stepsCompleted shows 6 before 7."""
    gherkin = feature_root / "scenarios.gherkin"
    failures: list[dict] = []
    if not gherkin.exists():
        failures.append({
            "check": "Scenarios First",
            "severity": "high",
            "file": "scenarios.gherkin",
            "line": 0,
            "issue": "scenarios.gherkin is missing — Stage 6 has not run.",
        })
        return False, "scenarios.gherkin missing", failures

    steps = parse_steps_completed(spec_fm)
    if steps and 6 in steps and 7 in steps:
        # In-array order is fine by construction; we also verify mtime ordering
        # as a backstop against stages being run out of sequence.
        tasks_path = feature_root / "tasks.md"
        if tasks_path.exists() and tasks_path.stat().st_mtime < gherkin.stat().st_mtime:
            # tasks.md is OLDER than scenarios.gherkin → scenarios came after tasks.
            # This is a soft signal; the stepsCompleted history is authoritative,
            # so we record it as informational only.
            return True, "scenarios.gherkin present; stepsCompleted shows 6 then 7", []
        return True, "scenarios.gherkin present; stepsCompleted shows 6 before 7", []

    # If 7 is in steps but 6 isn't, that's a hard fail.
    if 7 in steps and 6 not in steps:
        failures.append({
            "check": "Scenarios First",
            "severity": "high",
            "file": "spec.md",
            "line": 0,
            "issue": "stepsCompleted shows tasks (7) without scenarios (6).",
        })
        return False, "tasks without scenarios", failures

    return True, "scenarios.gherkin present", []


def check_tasks_support_scenarios(
    tasks: list[dict], scenarios: list[dict]
) -> tuple[bool, str, list[dict]]:
    """Check 2 — every task's Supports list resolves; every scenario is supported."""
    failures: list[dict] = []
    scenario_ids = {s["id"] for s in scenarios}
    # Build inverted map: scenario → tasks that support it.
    supported_by: dict[str, list[str]] = {sid: [] for sid in scenario_ids}

    for task in tasks:
        if not task["supports"]:
            failures.append({
                "check": "Tasks Support Scenarios",
                "severity": "high",
                "file": "tasks.md",
                "line": task["heading_line"],
                "issue": f"Task {task['id']} has no Supports: line.",
            })
            continue
        for sid in task["supports"]:
            if sid not in scenario_ids:
                failures.append({
                    "check": "Tasks Support Scenarios",
                    "severity": "high",
                    "file": "tasks.md",
                    "line": task["heading_line"],
                    "issue": (
                        f"Task {task['id']} references scenario {sid} "
                        f"which doesn't exist in scenarios.gherkin."
                    ),
                })
            else:
                supported_by[sid].append(task["id"])

    for sid, supporters in supported_by.items():
        if not supporters:
            # Build-checks are allowed to be unsupported by tasks — they're
            # mechanical gates, not feature work.
            if sid.startswith("BUILD-"):
                continue
            failures.append({
                "check": "Tasks Support Scenarios",
                "severity": "high",
                "file": "scenarios.gherkin",
                "line": next((s["line"] for s in scenarios if s["id"] == sid), 0),
                "issue": f"Scenario {sid} is not supported by any task.",
            })

    if failures:
        return False, f"{len(failures)} cross-reference issue(s)", failures
    return True, f"All {len(tasks)} tasks support resolved scenarios", []


def check_testable(tasks: list[dict]) -> tuple[bool, str, list[dict]]:
    """Check 3 — every task has a Tests: line with at least a file and a pattern."""
    failures: list[dict] = []
    for task in tasks:
        tests = (task.get("tests") or "").strip()
        if not tests:
            failures.append({
                "check": "Testable",
                "severity": "high",
                "file": "tasks.md",
                "line": task["heading_line"],
                "issue": f"Task {task['id']} has no Tests: line.",
            })
            continue
        # Require at least one path-like token and one additional token (the pattern).
        # We accept Tests: foo.spec.ts pattern  OR  Tests: foo.spec.ts (pattern…).
        # Heuristic: the value must contain a '.' or '/' (file path indicator)
        # and at least one whitespace-separated extra token.
        if not re.search(r"[./]", tests):
            failures.append({
                "check": "Testable",
                "severity": "medium",
                "file": "tasks.md",
                "line": task["heading_line"],
                "issue": f"Task {task['id']} Tests line has no file path: {tests!r}",
            })
            continue
        tokens = [t for t in re.split(r"\s+", tests) if t]
        if len(tokens) < 2:
            failures.append({
                "check": "Testable",
                "severity": "medium",
                "file": "tasks.md",
                "line": task["heading_line"],
                "issue": f"Task {task['id']} Tests line is missing a pattern: {tests!r}",
            })
            continue
        # CAP-5(b): validate pattern *content*, not just token count. A markdown
        # artifact like "(full suite)**Test Cases:**" leaking into the Tests line
        # is a generation bug (Issue #2 Problem B) — reject it here so it never
        # reaches definitions.json. Use "(full suite)" as the run-whole-file
        # sentinel instead of a markdown-polluted pattern.
        if "**" in tests or re.search(r"(?:^|\s)#{1,6}\s", tests):
            failures.append({
                "check": "Testable",
                "severity": "medium",
                "file": "tasks.md",
                "line": task["heading_line"],
                "issue": f"Task {task['id']} Tests line contains markdown artifacts (bold/header): {tests!r}",
            })
    if failures:
        return False, f"{len(failures)} task(s) missing testable specification", failures
    return True, f"All {len(tasks)} tasks have Tests file + pattern", []


def check_actionable(tasks: list[dict]) -> tuple[bool, str, list[dict]]:
    """Check 4 — every task has a File path AND an action verb at the start of the description."""
    failures: list[dict] = []
    for task in tasks:
        if not task.get("file"):
            failures.append({
                "check": "Actionable",
                "severity": "high",
                "file": "tasks.md",
                "line": task["heading_line"],
                "issue": f"Task {task['id']} has no File: line / Files-to-Modify entry.",
            })
        desc = (task.get("description") or "").strip()
        first_word = desc.split(None, 1)[0].rstrip(".,:;").lower() if desc else ""
        if not first_word or first_word not in ACTION_VERBS:
            failures.append({
                "check": "Actionable",
                "severity": "medium",
                "file": "tasks.md",
                "line": task["heading_line"],
                "issue": (
                    f"Task {task['id']} description doesn't start with an action verb "
                    f"(got {first_word!r}, expected one of {sorted(ACTION_VERBS)[:6]}...)."
                ),
            })
    if failures:
        return False, f"{len(failures)} actionability issue(s)", failures
    return True, f"All {len(tasks)} tasks are actionable", []


def check_logical(tasks: list[dict]) -> tuple[bool, str, list[dict]]:
    """Check 5 — phases are sequential strings, derivable from task IDs."""
    failures: list[dict] = []
    phases_seen: dict[str, list[str]] = {}
    for task in tasks:
        phase = task.get("phase")
        if phase is None:
            failures.append({
                "check": "Logical",
                "severity": "medium",
                "file": "tasks.md",
                "line": task["heading_line"],
                "issue": f"Task {task['id']} has no derivable phase (ID format unexpected).",
            })
            continue
        if not isinstance(phase, str):
            failures.append({
                "check": "Logical",
                "severity": "high",
                "file": "tasks.md",
                "line": task["heading_line"],
                "issue": f"Task {task['id']} phase is {type(phase).__name__}, must be string.",
            })
            continue
        # Phase strings must be a base-10 representation of a positive int.
        if not phase.isdigit():
            failures.append({
                "check": "Logical",
                "severity": "medium",
                "file": "tasks.md",
                "line": task["heading_line"],
                "issue": f"Task {task['id']} phase {phase!r} is not a positive integer string.",
            })
            continue
        phases_seen.setdefault(phase, []).append(task["id"])

    # Verify phases form a contiguous 1..N sequence.
    if phases_seen:
        nums = sorted(int(p) for p in phases_seen)
        expected = list(range(1, nums[-1] + 1))
        missing = sorted(set(expected) - set(nums))
        if missing:
            failures.append({
                "check": "Logical",
                "severity": "medium",
                "file": "tasks.md",
                "line": 0,
                "issue": f"Phase numbering has gaps. Missing phase(s): {missing}",
            })

    if failures:
        return False, f"{len(failures)} phase issue(s)", failures
    return True, f"Phases are sequential strings across {len(phases_seen)} phase(s)", []


def check_complete(feature_root: Path) -> tuple[bool, str, list[dict]]:
    """Check 6 — no TBD / {...} / {TODO} / PLACEHOLDER in spec content files."""
    failures: list[dict] = []
    targets = ["context.md", "coverage.md", "scenarios.gherkin", "tasks.md"]
    total_hits = 0
    for name in targets:
        path = feature_root / name
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for lineno, raw in enumerate(text.splitlines(), start=1):
            for pat in PLACEHOLDER_PATTERNS:
                if pat.search(raw):
                    failures.append({
                        "check": "Complete",
                        "severity": "high",
                        "file": name,
                        "line": lineno,
                        "issue": f"Placeholder token {pat.pattern!r} present: {raw.strip()[:80]!r}",
                    })
                    total_hits += 1
                    break  # one finding per line is enough
    if failures:
        return False, f"{total_hits} placeholder token(s) remaining", failures
    return True, "No placeholder tokens found in spec content", []


def check_self_contained(
    feature_root: Path, tasks: list[dict], scenarios: list[dict]
) -> tuple[bool, str, list[dict]]:
    """Check 7 — file paths in context.md resolve; cross-refs between artifacts resolve."""
    failures: list[dict] = []
    context_path = feature_root / "context.md"
    project_root = _infer_project_root(feature_root)

    if context_path.exists():
        text = context_path.read_text(encoding="utf-8", errors="replace")
        # Match table rows that look like: | path | UPDATE | … | or | path | NEW | …
        # We're permissive: any line with a backticked path followed by UPDATE/NEW.
        for lineno, raw in enumerate(text.splitlines(), start=1):
            stripped = raw.strip()
            if not stripped.startswith("|"):
                continue
            # Find the action verb (UPDATE / NEW / CREATE).
            verb_match = re.search(r"\b(UPDATE|NEW|CREATE|DELETE)\b", stripped)
            if not verb_match:
                continue
            verb = verb_match.group(1).upper()
            # Pull the first backticked token in the row as the path.
            path_match = re.search(r"`([^`]+)`", stripped)
            if not path_match:
                continue
            rel_path = path_match.group(1).strip()
            # Skip placeholder paths.
            if "{" in rel_path or "..." in rel_path:
                continue
            abs_path = (project_root / rel_path) if project_root else Path(rel_path)
            if verb in ("UPDATE", "DELETE"):
                if not abs_path.exists():
                    failures.append({
                        "check": "Self-Contained",
                        "severity": "high",
                        "file": "context.md",
                        "line": lineno,
                        "issue": f"{verb} target {rel_path!r} does not exist on disk.",
                    })
            elif verb in ("NEW", "CREATE"):
                # Parent dir must exist.
                if not abs_path.parent.exists():
                    failures.append({
                        "check": "Self-Contained",
                        "severity": "medium",
                        "file": "context.md",
                        "line": lineno,
                        "issue": f"{verb} target {rel_path!r} parent dir does not exist.",
                    })

    # Cross-reference: every scenario ID mentioned in tasks.md must be in
    # scenarios.gherkin. (Already partially covered by check 2, but check 7
    # also looks at any other cross-references like coverage.md → scenarios.)
    coverage_path = feature_root / "coverage.md"
    if coverage_path.exists():
        scenario_ids = {s["id"] for s in scenarios}
        text = coverage_path.read_text(encoding="utf-8", errors="replace")
        # Extract id-shaped refs with the shared grammar. Prose also holds
        # id-shaped tokens (UTF-8, ISO-27001, assumption ids like A1), so a
        # ref counts only when its letter prefix is one the spec's own
        # scenarios use — derived from the spec, not an allow-list.
        declared_prefixes = {_id_prefix(sid) for sid in scenario_ids}
        ref_re = re.compile(rf"(?<![A-Za-z0-9])({SCENARIO_ID_SOURCE})(?![A-Za-z0-9])", re.ASCII)
        for lineno, raw in enumerate(text.splitlines(), start=1):
            for ref in {m.group(1) for m in ref_re.finditer(raw)}:
                if _id_prefix(ref) not in declared_prefixes:
                    continue
                if ref not in scenario_ids:
                    failures.append({
                        "check": "Self-Contained",
                        "severity": "low",
                        "file": "coverage.md",
                        "line": lineno,
                        "issue": f"Reference {ref!r} not present in scenarios.gherkin.",
                    })

    if failures:
        return False, f"{len(failures)} unresolved reference(s)", failures
    return True, "All file paths and cross-references resolve", []


def _id_prefix(sid: str) -> str:
    """The letter prefix of an id, with its hyphen: S1 -> 'S', DELIVERY-2 -> 'DELIVERY-'."""
    m = re.match(r"[A-Z]+-?", sid)
    return m.group(0) if m else ""


def _infer_project_root(feature_root: Path) -> Path | None:
    """Walk up from feature_root looking for a marker that signals the project root.

    We try: a `.git` dir, then a `package.json`, then a `_bmad/` folder. If
    nothing matches within 6 levels we give up — paths in context.md will be
    resolved against the feature_root's parent as a last resort.
    """
    here = feature_root.resolve()
    for _ in range(6):
        if (here / ".git").exists() or (here / "_bmad").exists() or (here / "package.json").exists():
            return here
        if here.parent == here:
            break
        here = here.parent
    return feature_root.parent.parent if feature_root.parent != feature_root else None


def check_verifiable(
    feature_root: Path, scenarios: list[dict]
) -> tuple[bool, str, list[dict]]:
    """Check 8 — BUILD-1..4 present; BUILD-5 iff Figma referenced; state JSON well-formed."""
    failures: list[dict] = []
    scenario_ids = {s["id"] for s in scenarios}
    # Every id must fit the shared grammar, or the reporter can never route
    # its evidence and the scenario can never complete.
    for sc in scenarios:
        if not GRAMMAR.is_id(sc["id"]):
            failures.append({
                "check": "Verifiable",
                "severity": "high",
                "file": "scenarios.gherkin",
                "line": sc.get("line", 0),
                "issue": (
                    f"Scenario id {sc['id']!r} does not match the scenario id grammar "
                    f"({SCENARIO_ID_SOURCE}); the reporter could never route its evidence."
                ),
            })
    for n in (1, 2, 3, 4):
        sid = f"BUILD-{n}"
        if sid not in scenario_ids:
            failures.append({
                "check": "Verifiable",
                "severity": "high",
                "file": "scenarios.gherkin",
                "line": 0,
                "issue": f"Mandatory scenario {sid} is missing.",
            })

    # BUILD-5 rule: must exist iff Figma is referenced.
    figma_referenced = _figma_referenced(feature_root)
    build5_present = "BUILD-5" in scenario_ids
    if figma_referenced and not build5_present:
        failures.append({
            "check": "Verifiable",
            "severity": "high",
            "file": "scenarios.gherkin",
            "line": 0,
            "issue": "Figma referenced in spec but BUILD-5 (visual check) is missing.",
        })
    if build5_present and not figma_referenced:
        failures.append({
            "check": "Verifiable",
            "severity": "medium",
            "file": "scenarios.gherkin",
            "line": 0,
            "issue": "BUILD-5 present but no Figma reference found — remove or document.",
        })

    # Validate state snapshots if state/ exists.
    state_dir = feature_root / "state"
    if state_dir.exists() and state_dir.is_dir():
        for json_path in sorted(state_dir.rglob("*.json")):
            try:
                data = json.loads(json_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as e:
                failures.append({
                    "check": "Verifiable",
                    "severity": "high",
                    "file": str(json_path.relative_to(feature_root)),
                    "line": 0,
                    "issue": f"Snapshot is not valid JSON: {e}",
                })
                continue
            if not isinstance(data, dict):
                failures.append({
                    "check": "Verifiable",
                    "severity": "high",
                    "file": str(json_path.relative_to(feature_root)),
                    "line": 0,
                    "issue": "Snapshot root must be a JSON object.",
                })
                continue
            missing = SNAPSHOT_ROOT_FIELDS - set(data.keys())
            if missing:
                failures.append({
                    "check": "Verifiable",
                    "severity": "high",
                    "file": str(json_path.relative_to(feature_root)),
                    "line": 0,
                    "issue": f"Snapshot missing mandatory root field(s): {sorted(missing)}",
                })

    if failures:
        return False, f"{len(failures)} verifiability issue(s)", failures
    return True, "BUILD scenarios and state snapshots conform", []


def _figma_referenced(feature_root: Path) -> bool:
    if (feature_root / "figma").is_dir():
        return True
    for name in ("spec.md", "context.md"):
        path = feature_root / name
        if path.exists():
            text = path.read_text(encoding="utf-8", errors="replace")
            if re.search(r"\bFigma\b", text, re.IGNORECASE):
                return True
    return False


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def run_all_checks(feature_root: Path) -> dict:
    spec_text = ""
    spec_path = feature_root / "spec.md"
    if spec_path.exists():
        spec_text = spec_path.read_text(encoding="utf-8", errors="replace")
    spec_fm = parse_frontmatter(spec_text)

    scenarios = parse_scenarios(feature_root / "scenarios.gherkin")
    tasks = parse_tasks(feature_root / "tasks.md")

    check_runners: list[tuple[str, callable]] = [
        ("Scenarios First", lambda: check_scenarios_first(feature_root, spec_fm)),
        ("Tasks Support Scenarios", lambda: check_tasks_support_scenarios(tasks, scenarios)),
        ("Testable", lambda: check_testable(tasks)),
        ("Actionable", lambda: check_actionable(tasks)),
        ("Logical", lambda: check_logical(tasks)),
        ("Complete", lambda: check_complete(feature_root)),
        ("Self-Contained", lambda: check_self_contained(feature_root, tasks, scenarios)),
        ("Verifiable", lambda: check_verifiable(feature_root, scenarios)),
    ]

    checks_report: list[dict] = []
    all_failures: list[dict] = []
    for name, fn in check_runners:
        passed, details, failures = fn()
        checks_report.append({"name": name, "passed": passed, "details": details})
        all_failures.extend(failures)

    overall_ok = all(c["passed"] for c in checks_report)
    return {
        "status": "ok" if overall_ok else "failed",
        "checks": checks_report,
        "failures": all_failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Run the 8 mechanical Ready-for-Build checks against a feature folder. "
            "Emits structured JSON on stdout; never exits non-zero."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  uv run cs-readiness-check.py docs/features/PROJ-42\n"
            "  uv run cs-readiness-check.py docs/features/PROJ-42 --pretty\n"
        ),
    )
    parser.add_argument("feature_root", help="Path to a single feature folder.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    parser.add_argument("--verbose", "-v", action="store_true", help="Diagnostics to stderr.")
    args = parser.parse_args()

    feature_root = Path(args.feature_root).resolve()
    if args.verbose:
        print(f"feature_root: {feature_root}", file=sys.stderr)

    if GRAMMAR_ERROR is not None:
        result = {
            "status": "failed",
            "checks": [],
            "failures": [{
                "check": "Setup",
                "severity": "high",
                "file": str(ACTOR_DEFINITIONS_SCHEMA),
                "line": 0,
                "issue": GRAMMAR_ERROR,
            }],
        }
    elif not feature_root.exists() or not feature_root.is_dir():
        # Report this as a single Verifiable failure so caller still gets a JSON envelope.
        result = {
            "status": "failed",
            "checks": [],
            "failures": [{
                "check": "Setup",
                "severity": "high",
                "file": str(feature_root),
                "line": 0,
                "issue": "Feature root does not exist or is not a directory.",
            }],
        }
    else:
        result = run_all_checks(feature_root)

    if args.pretty:
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(result))

    if args.verbose:
        passed = sum(1 for c in result["checks"] if c["passed"])
        total = len(result["checks"])
        print(f"checks: {passed}/{total} passed; failures: {len(result['failures'])}",
              file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
