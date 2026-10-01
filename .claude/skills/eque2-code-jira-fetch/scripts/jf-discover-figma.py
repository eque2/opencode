#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
jf-discover-figma.py — Scan Jira artifacts for Figma URLs.

Replaces the prompt-driven discovery in [JF] Stage 4 (04-figma-discovery.md).
Scans `<jira-dir>/ticket.md` and `<jira-dir>/ticket.json` (description,
comments, custom fields) for Figma URLs. Validates file IDs against the
canonical pattern, extracts node IDs when present, deduplicates by
(file_id, node_id), and emits the result as JSON on stdout.

Patterns are loaded from `data/figma-url-patterns.md` (resolved relative to
this script's skill root; parsed from fenced ```regex blocks) so the agent's
authoritative regex list remains a single source of truth.

Design choices documented for the audit trail:

- File IDs must match `^[a-zA-Z0-9]{15,22}$` to be accepted. Shorter IDs are
  treated as `fig.ma` short-link IDs (no length check) — these are kept but
  flagged with `pattern: "fig.ma"` so the caller can decide whether to
  resolve them.
- `node_id` is extracted from `node-id=...` (URL-encoded `:` as `%3A` or raw)
  query strings. Missing node_id → null.
- Source attribution: `description`, `comment_N` (N is the 0-indexed comment
  position), `custom_field:<field-id>`, or `text:ticket.md` for non-JSON
  scrapes.
- The script falls back gracefully: if ticket.json is missing, scan ticket.md;
  if both are missing, return `status: "failed"` with `error:
  "no_input_files"`.

Usage:
    uv run jf-discover-figma.py <jira-dir> [--patterns <path>] [--pretty] [--verbose]
"""

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote

DEFAULT_PATTERNS_FILE = Path(__file__).resolve().parent.parent / "data" / "figma-url-patterns.md"
FILE_ID_PATTERN = re.compile(r"^[a-zA-Z0-9]{15,22}$")

# Hard-coded fallback patterns — used when the patterns file is missing or has
# no fenced regex blocks. Mirrors the canonical list in data/figma-url-patterns.md.
FALLBACK_PATTERNS = [
    r"https?://(?:www\.)?figma\.com/(?:file|design)/[a-zA-Z0-9]+[^\"',}\s]*",
    r"https?://fig\.ma/[a-zA-Z0-9]+",
]


def load_patterns(patterns_path: Path | None) -> list[re.Pattern]:
    """Extract regexes from fenced ```regex code blocks in the patterns markdown file."""
    raw_patterns: list[str] = []
    if patterns_path and patterns_path.exists():
        text = patterns_path.read_text(encoding="utf-8", errors="replace")
        # Match ```regex ... ``` fences. The pattern body is the inner content,
        # trimmed of whitespace. Multiple patterns supported.
        for match in re.finditer(r"```regex\s*\n(.*?)\n\s*```", text, re.DOTALL):
            body = match.group(1).strip()
            if body and not body.startswith("#"):
                raw_patterns.append(body)
    if not raw_patterns:
        raw_patterns = FALLBACK_PATTERNS

    compiled: list[re.Pattern] = []
    for p in raw_patterns:
        try:
            compiled.append(re.compile(p, re.IGNORECASE))
        except re.error:
            # Skip malformed patterns — fall back to defaults if none survive.
            continue
    if not compiled:
        compiled = [re.compile(p, re.IGNORECASE) for p in FALLBACK_PATTERNS]
    return compiled


def extract_file_id(url: str) -> tuple[str | None, str]:
    """Pull file ID + which pattern matched ("figma.com" | "fig.ma" | "unknown")."""
    m = re.search(r"figma\.com/(?:file|design)/([a-zA-Z0-9]+)", url, re.IGNORECASE)
    if m:
        return m.group(1), "figma.com"
    m = re.search(r"fig\.ma/([a-zA-Z0-9]+)", url, re.IGNORECASE)
    if m:
        return m.group(1), "fig.ma"
    return None, "unknown"


def extract_node_id(url: str) -> str | None:
    """Return the URL-decoded node-id query value, or None."""
    m = re.search(r"[?&]node-id=([^&\s\"'>]+)", url, re.IGNORECASE)
    if not m:
        return None
    return unquote(m.group(1))


def is_valid(file_id: str | None, pattern_name: str) -> bool:
    if not file_id:
        return False
    if pattern_name == "fig.ma":
        # Short links — accept any alphanumeric ID; we keep them for the caller.
        return bool(re.match(r"^[a-zA-Z0-9]+$", file_id))
    return bool(FILE_ID_PATTERN.match(file_id))


def _scan_string(text: str, patterns: list[re.Pattern], source: str,
                 raw: list[dict]) -> None:
    """Find every match across `patterns` in `text` and append to `raw`."""
    if not isinstance(text, str) or not text:
        return
    for pat in patterns:
        for match in pat.finditer(text):
            url = match.group(0)
            # Strip trailing punctuation that often clings to URLs in prose.
            url = url.rstrip(").,;:!?\"'>}]")
            raw.append({"url": url, "source": source})


def _walk_json(node, patterns: list[re.Pattern], source_prefix: str,
               raw: list[dict]) -> None:
    """Recursively scan strings in a JSON-shaped structure."""
    if isinstance(node, str):
        _scan_string(node, patterns, source_prefix, raw)
    elif isinstance(node, list):
        for i, item in enumerate(node):
            _walk_json(item, patterns, source_prefix, raw)
    elif isinstance(node, dict):
        for k, v in node.items():
            _walk_json(v, patterns, source_prefix, raw)


def discover(jira_dir: Path, patterns: list[re.Pattern]) -> dict:
    ticket_json = jira_dir / "ticket.json"
    ticket_md = jira_dir / "ticket.md"

    if not ticket_json.exists() and not ticket_md.exists():
        return {"status": "failed", "error": "no_input_files",
                "detail": "neither ticket.json nor ticket.md found"}

    raw: list[dict] = []

    # Pass 1: structured scan of ticket.json (so we can tag sources precisely).
    if ticket_json.exists():
        try:
            payload = json.loads(ticket_json.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            payload = None
        if isinstance(payload, dict):
            fields = payload.get("fields") if isinstance(payload.get("fields"), dict) else {}
            # Description (Atlassian Document Format — rendered or string).
            description = fields.get("description")
            if description is not None:
                _walk_json(description, patterns, "description", raw)
            # Comments.
            comments_container = fields.get("comment")
            comments = []
            if isinstance(comments_container, dict):
                comments = comments_container.get("comments") or []
            elif isinstance(comments_container, list):
                comments = comments_container
            for i, c in enumerate(comments):
                _walk_json(c, patterns, f"comment_{i}", raw)
            # Custom fields (anything starting with "customfield_").
            for k, v in fields.items():
                if isinstance(k, str) and k.startswith("customfield_"):
                    _walk_json(v, patterns, f"custom_field:{k}", raw)

    # Pass 2: text scrape of ticket.md (catch URLs that didn't survive JSON
    # structure or that live in a manually authored markdown summary).
    if ticket_md.exists():
        try:
            text = ticket_md.read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        _scan_string(text, patterns, "text:ticket.md", raw)

    # Normalise + filter + dedupe.
    # Two-stage dedup:
    #   1. Exact (file_id, node_id) collisions collapse to one entry.
    #   2. For each file_id, if any entry has a node_id, drop the no-node-id
    #      variants — they're a less specific match of the same design. This
    #      handles the case where two regex patterns match the same URL with
    #      different greediness (one captures the ?node-id=... query, the
    #      shorter one truncates at the path).
    rejected = 0
    candidates: list[dict] = []
    for entry in raw:
        url = entry["url"]
        file_id, pattern_name = extract_file_id(url)
        if not is_valid(file_id, pattern_name):
            rejected += 1
            continue
        candidates.append({
            "url": url,
            "file_id": file_id,
            "node_id": extract_node_id(url),
            "source": entry["source"],
            "pattern": pattern_name,
        })

    # Stage 1: collapse on (file_id, node_id).
    by_key: dict[tuple[str, str | None], dict] = {}
    for c in candidates:
        key = (c["file_id"], c["node_id"])
        if key not in by_key:
            by_key[key] = c

    # Stage 2: drop no-node-id variants when a node-id-bearing variant exists
    # for the same file_id.
    file_ids_with_node = {
        c["file_id"] for c in by_key.values() if c["node_id"] is not None
    }
    urls = [
        c for c in by_key.values()
        if c["node_id"] is not None or c["file_id"] not in file_ids_with_node
    ]

    duplicates_removed = len(candidates) - len(urls)
    if duplicates_removed < 0:
        duplicates_removed = 0

    return {
        "status": "ok",
        "urls": urls,
        "duplicates_removed": duplicates_removed,
        "invalid_rejected": rejected,
        "count": len(urls),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Discover Figma URLs in <jira-dir>/ticket.{json,md}. Extracts file/node IDs, "
            "validates, deduplicates. Emits structured JSON on stdout."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  uv run jf-discover-figma.py docs/features/PROJ-42/jira\n"
            "  uv run jf-discover-figma.py ./jira --patterns ./figma-patterns.md --pretty\n"
        ),
    )
    parser.add_argument("jira_dir", help="Directory containing ticket.json and/or ticket.md.")
    parser.add_argument(
        "--patterns",
        default=None,
        help=(
            "Path to figma-url-patterns.md (default: derived from this script's location "
            "→ ../data/figma-url-patterns.md)."
        ),
    )
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    parser.add_argument("--verbose", "-v", action="store_true", help="Diagnostics to stderr.")
    args = parser.parse_args()

    jira_dir = Path(args.jira_dir).resolve()

    if args.patterns:
        patterns_path = Path(args.patterns).resolve()
    else:
        # Default: ../data/figma-url-patterns.md relative to this script.
        patterns_path = Path(__file__).resolve().parent.parent / "data" / "figma-url-patterns.md"

    if args.verbose:
        print(f"jira_dir: {jira_dir}", file=sys.stderr)
        print(f"patterns_path: {patterns_path}", file=sys.stderr)

    if not jira_dir.exists() or not jira_dir.is_dir():
        err = {
            "status": "failed",
            "error": "jira_dir_missing",
            "detail": f"{jira_dir} does not exist or is not a directory.",
        }
        print(json.dumps(err, indent=2) if args.pretty else json.dumps(err))
        return 2

    patterns = load_patterns(patterns_path)
    if args.verbose:
        print(f"loaded {len(patterns)} pattern(s)", file=sys.stderr)

    result = discover(jira_dir, patterns)

    if args.pretty:
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(result))

    if args.verbose:
        if result["status"] == "ok":
            print(
                f"found={result['count']} dedup_removed={result['duplicates_removed']} "
                f"rejected={result['invalid_rejected']}",
                file=sys.stderr,
            )

    return 0 if result.get("status") == "ok" else 2


if __name__ == "__main__":
    sys.exit(main())
