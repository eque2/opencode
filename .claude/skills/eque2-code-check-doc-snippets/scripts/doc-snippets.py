#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Extract fenced code blocks from Markdown into checkable harness files, and splice fixed bodies back.

extract  Lists the repo's .md files (git ls-files, tracked + untracked-not-ignored), writes one
         harness file per code block to <out>/<ext>/<id>.<ext> with the body between
         `snippet-check:body-start` and `snippet-check:body-end` markers, and writes <out>/manifest.json.
         Prelude (imports, wrappers) goes above body-start; postlude below body-end.
splice   Reads each harness body back, and writes changed bodies into their .md files after checking
         the .md still holds the original body. Drifted blocks are reported as conflicts, not written.
clean    Removes <out> (only if it holds a manifest written by extract).

Exit codes: 0 ok, 1 splice conflicts, 2 error.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_EXCLUDES = [  # BMad install trees: a fix there is overwritten on the next install
    ".claude/skills/bmad-*", ".claude/skills/eque2-code-*", ".agents/skills/*", "_bmad/*", "*node_modules/*",
]
FENCE = re.compile(r"^(?P<indent>[ \t]*)(?P<fence>`{3,}|~{3,})(?P<info>.*)$")
SKIP = re.compile(r"^\s*<!--\s*snippet-check:\s*skip\b\s*(?P<reason>.*?)\s*-->\s*$")
MANIFEST = "manifest.json"

# fence language -> (extension, comment start, comment end); comment None = no markers possible (JSON)
_SLASH, _HASH = ("//", ""), ("#", "")
LANGS: dict[str, tuple[str, tuple[str, str] | None]] = {}
for names, ext, comment in [
    ("ts typescript", "ts", _SLASH), ("tsx", "tsx", _SLASH), ("mts", "mts", _SLASH), ("cts", "cts", _SLASH),
    ("js javascript node", "js", _SLASH), ("jsx", "jsx", _SLASH), ("mjs", "mjs", _SLASH), ("cjs", "cjs", _SLASH),
    ("py python python3", "py", _HASH), ("sh bash shell zsh", "sh", _HASH),
    ("json", "json", None), ("jsonc json5", "jsonc", _SLASH), ("yaml yml", "yaml", _HASH), ("toml", "toml", _HASH),
    ("go golang", "go", _SLASH), ("rs rust", "rs", _SLASH), ("java", "java", _SLASH), ("kt kotlin", "kt", _SLASH),
    ("cs csharp c#", "cs", _SLASH), ("rb ruby", "rb", _HASH), ("php", "php", _SLASH), ("sql", "sql", ("--", "")),
    ("css", "css", ("/*", " */")), ("scss", "scss", _SLASH), ("html", "html", ("<!--", " -->")),
    ("vue", "vue", ("<!--", " -->")), ("ps1 powershell pwsh", "ps1", _HASH), ("dockerfile docker", "Dockerfile", _HASH),
]:
    for name in names.split():
        LANGS[name] = (ext, comment)


def marker(comment: tuple[str, str], text: str) -> str:
    return f"{comment[0]} snippet-check:{text}{comment[1]}"


def md_files(root: Path, paths: list[str], excludes: list[str]) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"],
        capture_output=True, text=True,
    )
    if out.returncode:
        raise SystemExit(f"error: git ls-files failed in {root}: {out.stderr.strip()}")
    files = sorted({f for f in out.stdout.split("\0") if f and (root / f).is_file()})
    if paths:
        files = [f for f in files if any(f == p or f.startswith(p.rstrip("/") + "/") or fnmatch.fnmatch(f, p) for p in paths)]
    return [f for f in files if not any(fnmatch.fnmatch(f, x) for x in excludes)]


def parse_blocks(lines: list[str]) -> list[dict]:
    """CommonMark-ish fences. ponytail: any indent opens a fence (covers list items); no fence-in-HTML-comment handling."""
    blocks, i = [], 0
    while i < len(lines):
        m = FENCE.match(lines[i])
        if not m or (m["fence"][0] == "`" and "`" in m["info"]):
            i += 1
            continue
        fence, indent = m["fence"], m["indent"]
        close = closer(fence)
        j = i + 1
        while j < len(lines) and not close.match(lines[j]):
            j += 1
        prev = []
        for k in range(i - 1, -1, -1):
            if len(prev) == 4:
                break
            if lines[k].strip():
                prev.append(k)
        skip = SKIP.match(lines[prev[0]]) if prev else None
        prose = [lines[k].strip() for k in prev[1 if skip else 0:][:3]][::-1]
        info = m["info"].strip()
        token = info.split()[0].lstrip("{.").lower() if info else ""
        blocks.append({
            "fence_line": i + 1, "close_line": j + 1, "indent": indent, "fence": fence, "info": info,
            "lang": re.match(r"[\w+#.-]*", token).group().rstrip("."),
            "body": [dedent(line, indent) for line in lines[i + 1:j]],
            "skip": (skip["reason"] or "marker") if skip else None, "prose": prose,
        })
        i = j + 1
    return blocks


def closer(fence: str) -> re.Pattern:
    return re.compile(rf"^[ \t]*{re.escape(fence[0])}{{{len(fence)},}}[ \t]*$")


def dedent(line: str, indent: str) -> str:
    """Remove up to len(indent) leading whitespace chars, as CommonMark does for fenced content."""
    n = 0
    while n < len(indent) and n < len(line) and line[n] in " \t":
        n += 1
    return line[n:]


def read_lines(path: Path) -> tuple[list[str], str, bool]:
    """Lines without endings, the file's newline, and whether it ends with one."""
    with path.open(encoding="utf-8", newline="") as fh:
        text = fh.read()
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.split(nl)
    if lines[-1] == "":
        lines.pop()
    return lines, nl, text.endswith(nl)


def cmd_extract(args: argparse.Namespace) -> int:
    root, out = Path(args.root).resolve(), Path(args.out or Path(args.root) / ".snippet-check").resolve()
    if out.exists() and any(out.iterdir()) and not (out / MANIFEST).is_file():
        print(f"error: {out} is not empty and holds no {MANIFEST}; refusing to wipe it", file=sys.stderr)
        return 2
    shutil.rmtree(out, ignore_errors=True)
    manifest, counts, n = [], {}, 0
    for f in md_files(root, args.paths, DEFAULT_EXCLUDES + args.exclude):
        for b in parse_blocks(read_lines(root / f)[0]):
            n += 1
            entry = {"id": f"{n:04d}", "file": f, **b, "harness": None, "status": None}
            ext, comment = LANGS.get(b["lang"], (None, None))
            if b["skip"]:
                entry["status"] = "skip-marker"
            elif not b["body"] or not any(line.strip() for line in b["body"]):
                entry["status"] = "empty"
            elif not ext:
                entry["status"] = "unmapped"
            else:
                path = out / ext / f"{entry['id']}.{ext}"
                path.parent.mkdir(parents=True, exist_ok=True)
                body = b["body"] if comment is None else [
                    marker(comment, f"body-start {f}:{b['fence_line'] + 1}"), *b["body"], marker(comment, "body-end")]
                path.write_text("\n".join(body) + "\n", encoding="utf-8")
                entry.update(harness=path.relative_to(out).as_posix(), ext=ext, markers=comment is not None)
            key = entry["status"] or ext
            counts[key] = counts.get(key, 0) + 1
            manifest.append(entry)
    out.mkdir(parents=True, exist_ok=True)
    (out / MANIFEST).write_text(json.dumps({"root": str(root), "blocks": manifest}, indent=1), encoding="utf-8")
    files = len({e["file"] for e in manifest})
    print(json.dumps({"out": str(out), "manifest": str(out / MANIFEST), "md_files_with_blocks": files,
                      "blocks": len(manifest), "by_status_or_ext": dict(sorted(counts.items())),
                      "marker_skips": [f"{e['file']}:{e['fence_line']} {e['skip']}" for e in manifest if e["skip"]]},
                     indent=1))
    return 0


def harness_body(path: Path, entry: dict) -> list[str] | str:
    lines = read_lines(path)[0]
    if not entry["markers"]:
        return lines
    starts = [i for i, s in enumerate(lines) if "snippet-check:body-start" in s]
    ends = [i for i, s in enumerate(lines) if "snippet-check:body-end" in s]
    if len(starts) != 1 or len(ends) != 1 or ends[0] < starts[0]:
        return "body markers missing or duplicated in harness"
    return lines[starts[0] + 1: ends[0]]


def cmd_splice(args: argparse.Namespace) -> int:
    root, out = Path(args.root).resolve(), Path(args.out or Path(args.root) / ".snippet-check").resolve()
    try:
        blocks = json.loads((out / MANIFEST).read_text(encoding="utf-8"))["blocks"]
    except (OSError, ValueError) as e:
        print(f"error: cannot read {out / MANIFEST}: {e}", file=sys.stderr)
        return 2
    applied, conflicts, by_file = [], [], {}
    for e in blocks:
        if not e["harness"]:
            continue
        new = harness_body(out / e["harness"], e)
        if isinstance(new, str):
            conflicts.append({"id": e["id"], "file": e["file"], "line": e["fence_line"], "reason": new})
        elif new != e["body"]:
            by_file.setdefault(e["file"], []).append((e, new))
    for f, changes in by_file.items():
        lines, nl, trailing = read_lines(root / f)
        for e, new in sorted(changes, key=lambda c: -c[0]["fence_line"]):  # bottom-up keeps line numbers valid
            o, c = e["fence_line"] - 1, e["close_line"] - 1
            close = closer(e["fence"])
            same = (o < len(lines) and lines[o].lstrip(" \t").startswith(e["fence"])
                    and [dedent(s, e["indent"]) for s in lines[o + 1:c]] == e["body"]
                    and (c == len(lines) or (c < len(lines) and close.match(lines[c]))))
            reason = ("the .md changed since extract" if not same else
                      "fixed body contains a line that would close the fence" if any(close.match(s) for s in new) else None)
            if reason:
                conflicts.append({"id": e["id"], "file": f, "line": e["fence_line"], "reason": reason})
                continue
            lines[o + 1:c] = [e["indent"] + s if s.strip() else s for s in new]
            applied.append({"id": e["id"], "file": f, "line": e["fence_line"]})
        if any(a["file"] == f for a in applied):
            with (root / f).open("w", encoding="utf-8", newline="") as fh:
                fh.write(nl.join(lines) + (nl if trailing else ""))
    print(json.dumps({"applied": applied, "conflicts": conflicts}, indent=1))
    return 1 if conflicts else 0


def cmd_clean(args: argparse.Namespace) -> int:
    out = Path(args.out or Path(args.root) / ".snippet-check").resolve()
    if out.exists() and not (out / MANIFEST).is_file():
        print(f"error: {out} holds no {MANIFEST}; refusing to delete it", file=sys.stderr)
        return 2
    shutil.rmtree(out, ignore_errors=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in [("extract", cmd_extract), ("splice", cmd_splice), ("clean", cmd_clean)]:
        s = sub.add_parser(name)
        s.add_argument("--root", default=".", help="repo or package root (default: cwd)")
        s.add_argument("-o", "--out", help="harness folder (default: <root>/.snippet-check)")
        s.set_defaults(fn=fn)
        if name == "extract":
            s.add_argument("paths", nargs="*", help="limit to these .md files, folders, or globs")
            s.add_argument("--exclude", action="append", default=[], help="glob to skip (repeatable)")
    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
