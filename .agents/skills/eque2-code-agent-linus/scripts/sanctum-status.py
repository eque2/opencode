#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Deterministic introspection of Linus's sanctum — one JSON map, zero LLM tax.

Replaces the in-prompt work that the agent used to do by eyeballing files:
presence + the 7-file completeness check, the `birth_status` gate, stale-birth
date math (7-day), the unresolved-`{var}` placeholder sweep, the
"Not yet discovered" marker count, and the 14-day session-log pruning math.

Every consumer (SKILL.md rebirth routing, the headless preamble gate in
references/pulse.md, --headless:health, First Breath resume/wrap-up, and memory
curation) calls this instead of reasoning about files by hand.

Read-only by default. `--prune-sessions` actually deletes stale session logs;
without it, stale logs are only listed.

Usage:
    uv run ./scripts/sanctum-status.py --project-root /path/to/project
    uv run ./scripts/sanctum-status.py --sanctum /path/to/_bmad/_memory/linus-sidecar
    uv run ./scripts/sanctum-status.py --project-root . --session-max-age 14 --prune-sessions
    uv run ./scripts/sanctum-status.py --help

Exit codes: 0 = sanctum present and First Breath complete; 1 = present but
incomplete/absent (caller decides what to do — this is status, not a verdict).
"""

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

SANCTUM_RELATIVE_PATH = "_bmad/_memory/linus-sidecar"

# The skeleton — always present once First Breath has run.
STANDARD_FILES = [
    "PERSONA.md",
    "CREED.md",
    "BOND.md",
    "MEMORY.md",
    "CAPABILITIES.md",
    "PULSE.md",
    "INDEX.md",
]

# Tokens init-sanctum.py substitutes at scaffold time. Any of these still present
# means a template was copied but never personalised. NOTE: the runtime token
# `{project-root}` (hyphen) is intentionally NOT substituted and is excluded here.
SUBSTITUTION_TOKENS = [
    "{user_name}",
    "{communication_language}",
    "{birth_date}",
    "{project_root}",
    "{sanctum_path}",
]

NOT_YET_DISCOVERED = "Not yet discovered"
SESSION_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})\.md$")

# Instructional seed placeholders read like "{Discovered during First Breath...}" —
# a brace block containing whitespace. Runtime/path tokens ({project-root},
# {feature_artifacts}) and substitution tokens ({user_name}) are single
# identifiers with no spaces, so this cleanly separates "seed text still to
# replace" from legitimate tokens.
SEED_PLACEHOLDER_RE = re.compile(r"\{[^{}]*\s[^{}]*\}")


def parse_frontmatter(index_path: Path) -> dict:
    """Pull scalar keys from the leading --- frontmatter block of INDEX.md."""
    fm = {}
    if not index_path.exists():
        return fm
    text = index_path.read_text().replace("\r\n", "\n")
    if not text.startswith("---"):
        return fm
    end = text.find("\n---", 3)
    if end == -1:
        return fm
    for line in text[3:end].split("\n"):
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        fm[key.strip()] = value.strip().strip("'\"")
    return fm


def days_since(iso: str, today: date) -> int | None:
    try:
        y, m, d = (int(p) for p in iso.split("-")[:3])
        return (today - date(y, m, d)).days
    except (ValueError, AttributeError):
        return None


def build_status(sanctum: Path, session_max_age: int, today: date) -> dict:
    present = sanctum.exists()
    files = {name: (sanctum / name).is_file() for name in STANDARD_FILES}
    missing = [name for name, ok in files.items() if not ok]

    fm = parse_frontmatter(sanctum / "INDEX.md")
    birth_status = fm.get("birth_status")
    birth_started_at = fm.get("birth_started_at") or fm.get("birth_date")
    birth_age_days = days_since(birth_started_at, today) if birth_started_at else None
    birth_stale = bool(
        birth_status and birth_status != "complete"
        and birth_age_days is not None and birth_age_days > 7
    )

    # Unresolved substitution tokens, instructional seed placeholders, and
    # "Not yet discovered" markers across the skeleton.
    unresolved: dict[str, int] = {}
    seed_placeholders: dict[str, int] = {}
    not_yet_total = 0
    for name in STANDARD_FILES:
        fpath = sanctum / name
        if not fpath.is_file():
            continue
        body = fpath.read_text()
        count = sum(body.count(tok) for tok in SUBSTITUTION_TOKENS)
        if count:
            unresolved[name] = count
        seeds = len(SEED_PLACEHOLDER_RE.findall(body))
        if seeds:
            seed_placeholders[name] = seeds
        not_yet_total += body.count(NOT_YET_DISCOVERED)

    # Session-log age math.
    sessions_dir = sanctum / "sessions"
    stale_sessions: list[str] = []
    if sessions_dir.is_dir():
        for f in sorted(sessions_dir.iterdir()):
            mo = SESSION_RE.match(f.name)
            if not mo:
                continue
            age = days_since(f"{mo.group(1)}-{mo.group(2)}-{mo.group(3)}", today)
            if age is not None and age > session_max_age:
                stale_sessions.append(f"sessions/{f.name}")

    return {
        "present": present,
        "sanctum_path": str(sanctum),
        "files": files,
        "files_missing": missing,
        "files_complete": present and not missing,
        "birth_status": birth_status,
        "bootstrapped": fm.get("bootstrapped") == "true",
        "birth_started_at": birth_started_at,
        "birth_age_days": birth_age_days,
        "birth_stale": birth_stale,
        "unresolved_vars": unresolved,
        "unresolved_vars_total": sum(unresolved.values()),
        "seed_placeholders": seed_placeholders,
        "seed_placeholders_total": sum(seed_placeholders.values()),
        "not_yet_discovered_total": not_yet_total,
        "stale_sessions": stale_sessions,
        "session_max_age": session_max_age,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Introspect Linus's sanctum and emit a single JSON status map.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--project-root", help="Project root (sanctum resolved under it).")
    group.add_argument("--sanctum", help="Explicit sanctum directory path.")
    parser.add_argument(
        "--session-max-age", type=int, default=14,
        help="Days after which a session log is considered prunable (default 14).",
    )
    parser.add_argument(
        "--prune-sessions", action="store_true",
        help="Delete stale session logs instead of only listing them.",
    )
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")
    args = parser.parse_args()

    if args.sanctum:
        sanctum = Path(args.sanctum).resolve()
    else:
        sanctum = (Path(args.project_root).resolve() / SANCTUM_RELATIVE_PATH)

    result = build_status(sanctum, args.session_max_age, date.today())

    if args.prune_sessions and result["stale_sessions"]:
        pruned = []
        for rel in result["stale_sessions"]:
            target = sanctum / rel
            try:
                target.unlink()
                pruned.append(rel)
            except OSError:
                pass
        result["sessions_pruned"] = pruned

    print(json.dumps(result, indent=2 if args.pretty else None))
    return 0 if result["files_complete"] and result["birth_status"] == "complete" else 1


if __name__ == "__main__":
    sys.exit(main())
