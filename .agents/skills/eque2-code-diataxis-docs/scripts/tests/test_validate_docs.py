#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# ///
"""Run: python3 scripts/tests/test_validate_docs.py"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from validate_docs import validate  # noqa: E402


def page(dtype, title, body, sources=None):
    src = f"sources: [{', '.join(sources)}]\n" if sources else ""
    return f"---\ntitle: {title}\ndoc-type: {dtype}\n{src}---\n{body}\n"


def build(root, files):
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")


def test_clean_set_passes():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "src").mkdir()
        build(root / "docs", {
            "index.md": page("index", "Docs", "[Install](tutorials/install.md)"),
            "tutorials/index.md": page("index", "Tutorials", "- [Install](install.md)"),
            "tutorials/install.md": page(
                "tutorial", "Install", "> **TL;DR:** it works.\n\n```js\nh[x](y)\n```\n"
                "See [ref](../reference/cli.md#flags).", ["src"]),
            "reference/index.md": page("index", "Reference", "- [CLI](cli.md)"),
            "reference/cli.md": page("reference", "CLI", "TL;DR: flags. [web](https://x.y)"),
            "legacy.md": "# Not ours\n[gone](missing.md)\n",
            ".decision-log.md": "# log\n",
        })
        r = validate(root / "docs", root)
        assert r["errors"] == [], r["errors"]
        assert r["warnings"] == [], r["warnings"]
        assert r["unowned"] == ["legacy.md"], r["unowned"]
        assert r["pages"] == 5


def test_each_defect_is_reported():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        build(root / "docs", {
            "index.md": page("index", "Docs", "[a](how-to/a.md)"),
            "how-to/a.md": page("how-to", "A", "No summary. [b](b.md) Diataxis.", ["gone/"]),
            "reference/c.md": page("tutorial", "C", "TL;DR: c"),
            "explanation/d.md": "---\ndoc-type: explanation\n---\nTL;DR: d\n",
        })
        r = validate(root / "docs", root)
        errs = "\n".join(r["errors"])
        for expected in [
            "how-to/a.md: content page has no TL;DR",
            "how-to/a.md: broken link -> b.md",
            "reference/c.md: doc-type 'tutorial' belongs under tutorials/",
            "reference/c.md: orphan",
            "explanation/d.md: frontmatter has no title",
        ]:
            assert expected in errs, f"missing: {expected}\n{errs}"
        assert "how-to/a.md: orphan" not in errs
        warns = "\n".join(r["warnings"])
        assert "source path not found: gone/" in warns
        assert "names the documentation framework" in warns


if __name__ == "__main__":
    test_clean_set_passes()
    test_each_defect_is_reported()
    print("ok")
