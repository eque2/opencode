#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Unit tests for doc-snippets.py. Run: python3 test-doc-snippets.py (or pytest on this file)."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import subprocess
import tempfile
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "doc_snippets", Path(__file__).resolve().parent.parent / "doc-snippets.py"
)
ds = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ds)

DOC = """# Guide

Call it like this:

```ts title="x.ts"
const x = foo()
```

<!-- snippet-check: skip pseudo-code -->
```ts
do the thing
```

````md
```ts
nested, not a block
```
````

1. A list item:

   ~~~python
   print("hi")
   ~~~

```json
{"a": 1}
```

```mermaid
graph TD
```

```bash
```

```ts not a fence``` because the info string holds backticks.
"""


def repo(files: dict[str, str]) -> Path:
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    for name, text in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_bytes(text.encode())
    return root


def run(*argv: str) -> tuple[int, dict | None]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
        code = ds.main(list(argv))
    return code, json.loads(buf.getvalue()) if buf.getvalue().strip() else None


def manifest(root: Path) -> list[dict]:
    return json.loads((root / ".snippet-check/manifest.json").read_text())["blocks"]


def test_parse_blocks():
    b = ds.parse_blocks(DOC.splitlines())
    assert [x["lang"] for x in b] == ["ts", "ts", "md", "python", "json", "mermaid", "bash"], b
    assert b[0]["fence_line"] == 5 and b[0]["body"] == ["const x = foo()"] and b[0]["prose"] == ["# Guide", "Call it like this:"]
    assert b[1]["skip"] == "pseudo-code" and b[1]["prose"][-1] == "```"  # marker line is not prose
    assert b[2]["body"] == ["```ts", "nested, not a block", "```"]  # 4-backtick fence holds a 3-backtick one
    assert b[3]["indent"] == "   " and b[3]["body"] == ['print("hi")']
    assert b[6]["body"] == []
    unclosed = ds.parse_blocks(["```py", "x = 1"])
    assert unclosed[0]["close_line"] == 3 and unclosed[0]["body"] == ["x = 1"]


def test_extract_writes_harnesses_and_manifest():
    root = repo({"docs/guide.md": DOC, ".claude/skills/bmad-x/SKILL.md": "```ts\nvendored\n```\n"})
    code, summary = run("extract", "--root", str(root))
    assert code == 0 and summary["blocks"] == 7, summary
    assert summary["marker_skips"] == ["docs/guide.md:10 pseudo-code"]
    by = {e["lang"]: e for e in manifest(root)}
    assert by["mermaid"]["status"] == "unmapped" and by["bash"]["status"] == "empty"
    assert by["md"]["status"] == "unmapped"
    ts = next(e for e in manifest(root) if e["lang"] == "ts" and not e["skip"])
    assert (root / ".snippet-check" / ts["harness"]).read_text() == (
        "// snippet-check:body-start docs/guide.md:6\nconst x = foo()\n// snippet-check:body-end\n")
    assert (root / ".snippet-check/json" / f"{by['json']['id']}.json").read_text() == '{"a": 1}\n'
    assert not any("bmad-x" in e["file"] for e in manifest(root))  # default exclude
    assert run("extract", "--root", str(root), "--exclude", "docs/*")[1]["blocks"] == 0


def test_extract_refuses_to_wipe_foreign_folder():
    root = repo({"a.md": "```ts\nx\n```\n", "keep/precious.txt": "data"})
    code, _ = run("extract", "--root", str(root), "--out", str(root / "keep"))
    assert code == 2 and (root / "keep/precious.txt").exists()
    assert run("clean", "--root", str(root), "--out", str(root / "keep"))[0] == 2


def test_splice_writes_body_only_and_keeps_indent_and_crlf():
    root = repo({"a.md": "Intro\r\n\r\n- item\r\n\r\n   ```python\r\n   print('hi'\r\n   ```\r\n"})
    run("extract", "--root", str(root))
    e = manifest(root)[0]
    h = root / ".snippet-check" / e["harness"]
    h.write_text("import os\n" + h.read_text().replace("print('hi'", "print('hi')\nprint(os.sep)") + "main()\n")
    code, res = run("splice", "--root", str(root))
    assert code == 0 and len(res["applied"]) == 1, res
    assert (root / "a.md").read_bytes().decode() == (
        "Intro\r\n\r\n- item\r\n\r\n   ```python\r\n   print('hi')\r\n   print(os.sep)\r\n   ```\r\n")
    assert run("clean", "--root", str(root))[0] == 0 and not (root / ".snippet-check").exists()


def test_splice_conflicts_on_drift_and_early_close_and_damaged_markers():
    root = repo({"a.md": "```ts\na\n```\n\n```ts\nb\n```\n\n```ts\nc\n```\n"})
    run("extract", "--root", str(root))
    one, two, three = manifest(root)
    (root / ".snippet-check" / one["harness"]).write_text(
        (root / ".snippet-check" / one["harness"]).read_text().replace("\na\n", "\nA\n"))
    (root / ".snippet-check" / two["harness"]).write_text(
        (root / ".snippet-check" / two["harness"]).read_text().replace("\nb\n", "\nb\n```\n"))
    (root / ".snippet-check" / three["harness"]).write_text("c\n")
    (root / "a.md").write_text("```ts\nedited by hand\n```\n\n```ts\nb\n```\n\n```ts\nc\n```\n")
    code, res = run("splice", "--root", str(root))
    reasons = {c["id"]: c["reason"] for c in res["conflicts"]}
    assert code == 1 and not res["applied"], res
    assert "changed since extract" in reasons[one["id"]]
    assert "close the fence" in reasons[two["id"]]
    assert "markers" in reasons[three["id"]]
    assert "edited by hand" in (root / "a.md").read_text()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
