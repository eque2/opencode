#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
cs-append-catches.py — Append a catch entry to `{feature_root}/.catches.json`.

Single appender shared by Create-Spec Stages 6, 7, and 8. Replaces three copies
of hand-rolled JSON-append logic in the stage prompts. See
`references/catches-schema.md` for the envelope and entry contract.

Behaviour:
- File missing → create with `schema_version: "1"`, `entries: [entry]`.
- File present, parses, schema_version=="1" → append entry, write back.
- File present, parse failure OR schema_version mismatch → rotate the offending
  file to `.catches.json.broken-<unix-ts>` and start fresh with this entry.
  Output reports `status: "rotated"` so the caller can log the rotation.

Entry validation is intentionally lightweight — the contract is open-ended
(stage-specific arrays vary by skill). We enforce only the two required keys
(`skill`, `stage`) and `stage` being an integer. Anything else passes through.

Usage:
    uv run cs-append-catches.py <feature_root> --skill <name> --stage <int>
        (--entry <json-string> | --from-file <path>) [--pretty] [--verbose]
"""

import argparse
import json
import sys
import time
from pathlib import Path

SCHEMA_VERSION = "1"
CATCHES_FILENAME = ".catches.json"


def _load_entry(args: argparse.Namespace) -> dict:
    """Resolve the incoming entry from --entry or --from-file."""
    if args.entry and args.from_file:
        raise ValueError("Use --entry OR --from-file, not both.")
    if not args.entry and not args.from_file:
        raise ValueError("Must provide --entry <json-string> or --from-file <path>.")

    if args.entry:
        raw = args.entry
        source = "--entry"
    else:
        path = Path(args.from_file).resolve()
        if not path.exists():
            raise FileNotFoundError(f"--from-file path does not exist: {path}")
        raw = path.read_text(encoding="utf-8")
        source = f"--from-file={path}"

    try:
        entry = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON in {source}: {e}") from e

    if not isinstance(entry, dict):
        raise ValueError(f"Entry from {source} must be a JSON object, got {type(entry).__name__}.")

    # CLI flags act as the authoritative source for skill/stage. They override
    # whatever was in the entry blob — this keeps the caller from accidentally
    # mislabelling an entry by typoing the JSON payload.
    entry["skill"] = args.skill
    entry["stage"] = args.stage

    return entry


def _validate_entry(entry: dict) -> None:
    """Light contract enforcement. See references/catches-schema.md."""
    if not isinstance(entry.get("skill"), str) or not entry["skill"].strip():
        raise ValueError("entry.skill must be a non-empty string.")
    if not isinstance(entry.get("stage"), int):
        raise ValueError("entry.stage must be an integer.")


def append_entry(feature_root: Path, entry: dict) -> dict:
    """Append the entry to `.catches.json`. Returns a result dict.

    Result keys:
      status: "ok" | "rotated"
      file: absolute path to the catches file
      entry_count: total entries after append
      appended: the entry that was appended (as written)
      rotated_to: present only when status == "rotated"
    """
    catches_path = feature_root / CATCHES_FILENAME
    rotated_to: Path | None = None

    if catches_path.exists():
        envelope: dict | None
        try:
            envelope = json.loads(catches_path.read_text(encoding="utf-8"))
            if not isinstance(envelope, dict):
                raise ValueError(f"root must be object, got {type(envelope).__name__}")
            if envelope.get("schema_version") != SCHEMA_VERSION:
                raise ValueError(
                    f"schema_version mismatch (got {envelope.get('schema_version')!r}, "
                    f"expected {SCHEMA_VERSION!r})"
                )
            if not isinstance(envelope.get("entries"), list):
                raise ValueError("entries must be a list")
        except (json.JSONDecodeError, ValueError):
            # Rotate the broken file aside and start fresh.
            timestamp = int(time.time())
            rotated_to = catches_path.with_suffix(
                catches_path.suffix + f".broken-{timestamp}"
            )
            catches_path.rename(rotated_to)
            envelope = None

        if envelope is not None:
            envelope["entries"].append(entry)
        else:
            envelope = {"schema_version": SCHEMA_VERSION, "entries": [entry]}
    else:
        envelope = {"schema_version": SCHEMA_VERSION, "entries": [entry]}

    catches_path.write_text(json.dumps(envelope, indent=2) + "\n", encoding="utf-8")

    result: dict = {
        "status": "rotated" if rotated_to else "ok",
        "file": str(catches_path),
        "entry_count": len(envelope["entries"]),
        "appended": entry,
    }
    if rotated_to:
        result["rotated_to"] = str(rotated_to)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Append a catch entry to {feature_root}/.catches.json. "
            "Used by Create-Spec Stages 6, 7, 8. Emits structured JSON on stdout."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  uv run cs-append-catches.py docs/features/PROJ-42 \\\n"
            "    --skill bmad-party-mode --stage 6 \\\n"
            "    --entry '{\"added_scenarios\":[\"S5\"],\"rationale\":\"...\"}'\n"
            "  uv run cs-append-catches.py docs/features/PROJ-42 \\\n"
            "    --skill bmad-review --stage 7 \\\n"
            "    --from-file /tmp/edge-catches.json --pretty\n"
        ),
    )
    parser.add_argument("feature_root", help="Path to the feature folder (contains .catches.json).")
    parser.add_argument("--skill", required=True, help="Skill name that produced the catch.")
    parser.add_argument("--stage", required=True, type=int, help="Create-Spec stage number (6/7/8).")
    parser.add_argument("--entry", help="Inline JSON object for the entry body.")
    parser.add_argument("--from-file", help="Path to a JSON file containing the entry body.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    parser.add_argument("--verbose", "-v", action="store_true", help="Diagnostics to stderr.")
    args = parser.parse_args()

    feature_root = Path(args.feature_root).resolve()

    if args.verbose:
        print(f"feature_root: {feature_root}", file=sys.stderr)
        print(f"skill: {args.skill}  stage: {args.stage}", file=sys.stderr)

    if not feature_root.exists() or not feature_root.is_dir():
        err = {
            "status": "failed",
            "error": "feature_root_missing",
            "detail": f"{feature_root} does not exist or is not a directory.",
        }
        print(json.dumps(err, indent=2) if args.pretty else json.dumps(err))
        return 2

    try:
        entry = _load_entry(args)
        _validate_entry(entry)
    except (ValueError, FileNotFoundError) as e:
        err = {"status": "failed", "error": "invalid_entry", "detail": str(e)}
        print(json.dumps(err, indent=2) if args.pretty else json.dumps(err))
        return 2

    result = append_entry(feature_root, entry)

    if args.pretty:
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(result))

    if args.verbose:
        msg = f"appended to {result['file']} (total entries: {result['entry_count']})"
        if result["status"] == "rotated":
            msg += f"; rotated broken file to {result['rotated_to']}"
        print(msg, file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
