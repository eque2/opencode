#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# ///
"""Check a generated documentation set for structural defects.

A page is "owned" when its YAML frontmatter carries `doc-type`. Files without it are
listed as `unowned` and never checked — they are someone else's docs.

ERROR (exit 1):
  - owned page missing `title`, or `doc-type` not one of the known types
  - page filed in the wrong section folder for its doc-type
  - content page (not an index) without a TL;DR
  - relative Markdown link whose target file does not exist
  - content page that no owned index.md links to (orphan)
WARN:
  - a `sources` path that does not exist under the project root (stale after a rename?)
  - the framework's own name in page content outside code

Output is JSON on stdout: {"pages", "errors", "warnings", "unowned"}.
Exit codes: 0 = clean, 1 = errors found, 2 = usage error.
"""
import argparse
import json
import re
import sys
from pathlib import Path

FOLDER_FOR = {
    "tutorial": "tutorials",
    "how-to": "how-to",
    "reference": "reference",
    "explanation": "explanation",
    "contributing": "contributing",
}
DOC_TYPES = set(FOLDER_FOR) | {"index"}
FENCE = re.compile(r"^(```|~~~).*?^\1", re.M | re.S)
INLINE_CODE = re.compile(r"`[^`\n]*`")
LINK = re.compile(r"\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")


def split_frontmatter(text):
    """Return (dict, body). Supports `k: v`, `k: [a, b]`, and `k:` + `- item` lines."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    meta, key = {}, None
    for line in text[3:end].splitlines():
        if not line.strip():
            continue
        item = re.match(r"\s+-\s+(.*)", line)
        if item and key:
            meta.setdefault(key, [])
            if isinstance(meta[key], list):
                meta[key].append(item.group(1).strip().strip("'\""))
            continue
        kv = re.match(r"([\w-]+):\s*(.*)", line)
        if not kv:
            continue
        key, val = kv.group(1), kv.group(2).strip()
        if val.startswith("[") and val.endswith("]"):
            meta[key] = [v.strip().strip("'\"") for v in val[1:-1].split(",") if v.strip()]
        elif val:
            meta[key] = val.strip("'\"")
    return meta, text[end + 4:]


def links_in(body):
    prose = INLINE_CODE.sub("", FENCE.sub("", body))
    for target in LINK.findall(prose):
        if re.match(r"[a-z][a-z0-9+.-]*:", target, re.I) or target.startswith("#"):
            continue  # external URL, mailto:, or same-page anchor
        yield target.split("#")[0].split("?")[0]


def validate(docs, root):
    errors, warnings, unowned = [], [], []
    pages = {}  # resolved path -> (rel, meta, body)
    for f in sorted(docs.rglob("*.md")):
        rel = f.relative_to(docs).as_posix()
        if any(part.startswith(".") for part in f.relative_to(docs).parts):
            continue
        meta, body = split_frontmatter(f.read_text(encoding="utf-8"))
        if "doc-type" not in meta:
            unowned.append(rel)
            continue
        pages[f.resolve()] = (rel, meta, body)

    linked_from_index = set()
    for path, (rel, meta, body) in pages.items():
        dtype = meta["doc-type"]
        if not meta.get("title"):
            errors.append(f"{rel}: frontmatter has no title")
        if dtype not in DOC_TYPES:
            errors.append(f"{rel}: unknown doc-type '{dtype}'")
        elif dtype != "index":
            parts = Path(rel).parts
            if len(parts) < 2 or parts[0] != FOLDER_FOR[dtype]:
                errors.append(f"{rel}: doc-type '{dtype}' belongs under {FOLDER_FOR[dtype]}/")
            if "TL;DR" not in body:
                errors.append(f"{rel}: content page has no TL;DR")
        for target in links_in(body):
            dest = (path.parent / target).resolve()
            if not dest.exists():
                errors.append(f"{rel}: broken link -> {target}")
            elif dtype == "index":
                linked_from_index.add(dest)
        sources = meta.get("sources", [])
        for src in [sources] if isinstance(sources, str) else sources:
            if not (root / src).exists():
                warnings.append(f"{rel}: source path not found: {src}")
        if re.search(r"diataxis|diátaxis", INLINE_CODE.sub("", FENCE.sub("", body)), re.I):
            warnings.append(f"{rel}: names the documentation framework in reader content")

    for path, (rel, meta, _) in pages.items():
        if meta["doc-type"] != "index" and path not in linked_from_index:
            errors.append(f"{rel}: orphan — no index.md links to it")

    return {"pages": len(pages), "errors": errors, "warnings": warnings, "unowned": unowned}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("docs_dir", help="root of the documentation set, e.g. docs/")
    ap.add_argument("--project-root", default=".", help="base for `sources` paths (default: cwd)")
    ap.add_argument("-o", "--output", help="write the JSON report here instead of stdout")
    args = ap.parse_args(argv)
    docs = Path(args.docs_dir)
    if not docs.is_dir():
        print(f"not a directory: {docs}", file=sys.stderr)
        return 2
    report = validate(docs, Path(args.project_root))
    out = json.dumps(report, indent=2)
    if args.output:
        Path(args.output).write_text(out + "\n", encoding="utf-8")
    else:
        print(out)
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
