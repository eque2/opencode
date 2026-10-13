#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
jf-parse-related-tickets.py — Parse `related-tickets.json` into a structured summary.

Replaces the prompt-driven parsing in [JF] Stage 3. Reads
`<jira-dir>/related-tickets.json` and emits a normalised summary of subtasks,
parent epic, blockers, and linked issues to stdout as JSON.

The input file's shape can be one of two:

1. The Stage 3 output shape — top-level keys `parent_epic`, `subtasks`,
   `blockers`, `linked_issues`, `fetch_metadata` (as written by step 7 of
   `03-related.md`). Each entry is a ticket-like dict.

2. A raw Jira REST response — top-level `fields` dict containing `subtasks`,
   `issuelinks`, `parent`, etc. (what `gh api`/`curl` returns when fetching a
   single ticket with `expand=names,renderedFields`).

The parser is defensive: missing fields produce empty lists; unexpected types
are skipped with a note in stderr (when --verbose). The output schema is
stable regardless of which input shape was supplied.

Output (stdout JSON):

    {
      "status": "ok",
      "ticket_key": "PROJ-42" | null,
      "summary": {
        "subtasks": [{"key", "summary", "status"}, ...],
        "parent_epic": {"key", "summary"} | null,
        "blockers": [{"key", "summary"}, ...],
        "linked_issues": [{"key", "type", "summary"}, ...],
        "counts": {"subtasks": N, "blockers": N, "linked": N}
      }
    }

Usage:
    uv run jf-parse-related-tickets.py <jira-dir> [--pretty] [--verbose]
"""

import argparse
import json
import sys
from pathlib import Path

RELATED_FILENAME = "related-tickets.json"

# Jira link-type names that indicate a blocker relationship. We normalise to
# lower-case before comparing.
BLOCKER_LINK_TYPES = {"blocks", "is blocked by", "blocked by"}


def _get(d: dict, *keys, default=None):
    """Defensive dict accessor: first existing key wins, missing → default."""
    for k in keys:
        if isinstance(d, dict) and k in d and d[k] is not None:
            return d[k]
    return default


def _ticket_summary(ticket: dict) -> dict:
    """Normalise a Jira-shaped ticket dict into {key, summary, status}."""
    if not isinstance(ticket, dict):
        return {"key": None, "summary": None, "status": None}
    key = _get(ticket, "key")
    fields = _get(ticket, "fields", default={}) or {}
    summary = _get(ticket, "summary") or _get(fields, "summary")
    status_field = _get(ticket, "status") or _get(fields, "status")
    if isinstance(status_field, dict):
        status = _get(status_field, "name") or _get(status_field, "status") or None
    else:
        status = status_field if isinstance(status_field, str) else None
    return {"key": key, "summary": summary, "status": status}


def _epic_summary(epic: dict | None) -> dict | None:
    if not isinstance(epic, dict):
        return None
    key = _get(epic, "key")
    fields = _get(epic, "fields", default={}) or {}
    summary = _get(epic, "summary") or _get(fields, "summary")
    if not key and not summary:
        return None
    return {"key": key, "summary": summary}


def _link_entry(link: dict) -> dict | None:
    """Normalise a Jira issuelink into {key, type, summary, direction}.

    Jira issuelinks have shape:
      {
        "type": {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
        "inwardIssue":  {"key": "X-1", "fields": {"summary": "..."}},
        "outwardIssue": {"key": "X-2", "fields": {"summary": "..."}},
      }
    """
    if not isinstance(link, dict):
        return None
    type_field = _get(link, "type", default={}) or {}
    type_name = _get(type_field, "name") or _get(link, "type_name") or None
    inward = _get(link, "inwardIssue", "inward_issue")
    outward = _get(link, "outwardIssue", "outward_issue")
    issue = inward or outward
    direction = "inward" if inward else "outward"
    if not isinstance(issue, dict):
        return None
    fields = _get(issue, "fields", default={}) or {}
    return {
        "key": _get(issue, "key"),
        "type": type_name,
        "summary": _get(issue, "summary") or _get(fields, "summary"),
        "direction": direction,
        "_type_inward": _get(type_field, "inward"),
        "_type_outward": _get(type_field, "outward"),
    }


def _is_blocker(entry: dict) -> bool:
    """Heuristic: link type name or direction-specific phrase signals 'blocker'."""
    for candidate in (
        entry.get("type"),
        entry.get("_type_inward"),
        entry.get("_type_outward"),
    ):
        if isinstance(candidate, str) and candidate.strip().lower() in BLOCKER_LINK_TYPES:
            return True
    return False


def parse_stage3_shape(payload: dict) -> dict:
    """Parse the workflow's own output shape (parent_epic / subtasks / blockers / linked_issues)."""
    subtasks_raw = payload.get("subtasks") or []
    blockers_raw = payload.get("blockers") or []
    linked_raw = payload.get("linked_issues") or []
    parent_epic_raw = payload.get("parent_epic")

    subtasks = [_ticket_summary(t) for t in subtasks_raw if isinstance(t, dict)]
    blockers = [_ticket_summary(t) for t in blockers_raw if isinstance(t, dict)]

    linked_issues: list[dict] = []
    for entry in linked_raw:
        if not isinstance(entry, dict):
            continue
        # If the workflow already split out the issue, it may be flat.
        if "key" in entry and ("type" in entry or "summary" in entry):
            linked_issues.append({
                "key": entry.get("key"),
                "type": entry.get("type"),
                "summary": entry.get("summary"),
            })
            continue
        # Else treat as Jira issuelink.
        norm = _link_entry(entry)
        if norm:
            linked_issues.append({
                "key": norm["key"],
                "type": norm["type"],
                "summary": norm["summary"],
            })

    parent_epic = _epic_summary(parent_epic_raw) if isinstance(parent_epic_raw, dict) else None

    return {
        "subtasks": subtasks,
        "parent_epic": parent_epic,
        "blockers": blockers,
        "linked_issues": linked_issues,
    }


def parse_raw_jira_shape(payload: dict) -> dict:
    """Parse a raw Jira REST `issue` response (fields.subtasks / fields.issuelinks / fields.parent)."""
    fields = _get(payload, "fields", default={}) or {}

    subtasks_raw = _get(fields, "subtasks", default=[]) or []
    subtasks = [_ticket_summary(t) for t in subtasks_raw if isinstance(t, dict)]

    issuelinks_raw = _get(fields, "issuelinks", default=[]) or []
    blockers: list[dict] = []
    linked_issues: list[dict] = []
    for link in issuelinks_raw:
        norm = _link_entry(link)
        if not norm:
            continue
        flat = {"key": norm["key"], "type": norm["type"], "summary": norm["summary"]}
        if _is_blocker(norm):
            # For blockers, only record direction == "inward" (i.e. "is blocked by")
            # — outward "blocks" means OUR ticket blocks something else, which
            # isn't a blocker on us.
            if norm["direction"] == "inward":
                blockers.append({"key": norm["key"], "summary": norm["summary"]})
            else:
                linked_issues.append(flat)
        else:
            linked_issues.append(flat)

    # Parent epic detection: prefer fields.parent (modern), fall back to
    # customfield_10014 / "Epic Link" if present.
    parent_field = _get(fields, "parent")
    if isinstance(parent_field, dict):
        parent_epic = _epic_summary(parent_field)
    else:
        # Look for any custom field whose name contains "epic" and pull its value
        # if it looks like an issue ref.
        parent_epic = None
        for k, v in fields.items():
            if "epic" in str(k).lower() and isinstance(v, dict) and v.get("key"):
                parent_epic = _epic_summary(v)
                break

    return {
        "subtasks": subtasks,
        "parent_epic": parent_epic,
        "blockers": blockers,
        "linked_issues": linked_issues,
    }


def detect_shape(payload: dict) -> str:
    """Heuristic: stage-3 output has top-level subtasks/blockers/linked_issues."""
    if not isinstance(payload, dict):
        return "unknown"
    stage3_keys = {"subtasks", "blockers", "linked_issues", "parent_epic"}
    if stage3_keys & set(payload.keys()):
        return "stage3"
    if isinstance(_get(payload, "fields"), dict):
        return "raw_jira"
    return "unknown"


def derive_ticket_key(payload: dict) -> str | None:
    """Resolve the ticket key from common locations."""
    key = _get(payload, "ticket_key", "key")
    if key:
        return str(key)
    # Stage-3 shape sometimes nests metadata.
    meta = _get(payload, "fetch_metadata", default={}) or {}
    return _get(meta, "ticket_key", "key")


def parse_related(payload: dict) -> dict:
    shape = detect_shape(payload)
    if shape == "stage3":
        summary = parse_stage3_shape(payload)
    elif shape == "raw_jira":
        summary = parse_raw_jira_shape(payload)
    else:
        summary = {"subtasks": [], "parent_epic": None, "blockers": [], "linked_issues": []}

    counts = {
        "subtasks": len(summary["subtasks"]),
        "blockers": len(summary["blockers"]),
        "linked": len(summary["linked_issues"]),
    }
    summary["counts"] = counts

    return {
        "status": "ok",
        "ticket_key": derive_ticket_key(payload),
        "shape_detected": shape,
        "summary": summary,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Parse <jira-dir>/related-tickets.json into a normalised summary. "
            "Handles both stage-3 output shape and raw Jira API responses."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  uv run jf-parse-related-tickets.py docs/features/PROJ-42/jira\n"
            "  uv run jf-parse-related-tickets.py ./jira --pretty\n"
        ),
    )
    parser.add_argument("jira_dir", help="Directory containing related-tickets.json.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    parser.add_argument("--verbose", "-v", action="store_true", help="Diagnostics to stderr.")
    args = parser.parse_args()

    jira_dir = Path(args.jira_dir).resolve()
    related_path = jira_dir / RELATED_FILENAME

    if args.verbose:
        print(f"jira_dir: {jira_dir}", file=sys.stderr)
        print(f"related_path: {related_path}", file=sys.stderr)

    if not jira_dir.exists() or not jira_dir.is_dir():
        err = {
            "status": "failed",
            "error": "jira_dir_missing",
            "detail": f"{jira_dir} does not exist or is not a directory.",
        }
        print(json.dumps(err, indent=2) if args.pretty else json.dumps(err))
        return 2

    if not related_path.exists():
        err = {
            "status": "failed",
            "error": "related_tickets_missing",
            "detail": f"{related_path} not found.",
        }
        print(json.dumps(err, indent=2) if args.pretty else json.dumps(err))
        return 2

    try:
        payload = json.loads(related_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        err = {"status": "failed", "error": "parse_error", "detail": str(e)}
        print(json.dumps(err, indent=2) if args.pretty else json.dumps(err))
        return 2

    result = parse_related(payload)

    if args.pretty:
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(result))

    if args.verbose:
        c = result["summary"]["counts"]
        print(
            f"shape={result['shape_detected']} subtasks={c['subtasks']} "
            f"blockers={c['blockers']} linked={c['linked']}",
            file=sys.stderr,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
