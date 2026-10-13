#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Tests for collect-review-context.py. Run: python3 test-collect-review-context.py"""
from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "collect-review-context.py"
spec = importlib.util.spec_from_file_location("collect", SCRIPT)
collect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collect)


def sh(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


def make_repo(tmp: Path) -> Path:
    root = tmp / "repo"
    root.mkdir()
    sh(root, "init", "-q", "-b", "main")
    sh(root, "config", "user.email", "t@example.com")
    sh(root, "config", "user.name", "t")
    (root / "keep.ts").write_text("a\n")
    (root / "gone.ts").write_text("b\n")
    guides = root / ".ai/Code Reviews/styleguides"
    guides.mkdir(parents=True)
    (guides / "angular_v17.md").write_text(
        "# Angular\n\n**Name:** Angular 17\n**Category:** Frontend\n"
        "**Applies To:** *.component.ts files\n\n## PR Review Comment Format\n\nx\n"
    )
    rr = root / ".github/review-rules"
    rr.mkdir(parents=True)
    (rr / "python.md").write_text("# Python rules\n\nno headers here\n")
    sh(root, "add", "-A")
    sh(root, "commit", "-q", "-m", "base")
    sh(root, "checkout", "-q", "-b", "feature")
    (root / "committed.ts").write_text("c\n")
    sh(root, "add", "committed.ts")
    sh(root, "rm", "-q", "gone.ts")
    sh(root, "commit", "-q", "-m", "feature work")
    (root / "keep.ts").write_text("a changed\n")        # unstaged
    (root / "new.component.ts").write_text("n\n")        # untracked
    return root


def test_collects_every_change_and_both_rule_layouts() -> None:
    with tempfile.TemporaryDirectory() as t:
        root = make_repo(Path(t))
        out = collect.collect(root, None)
        assert out["status"] == "ok", out
        assert out["branch"] == "feature"
        assert out["base_ref"] == "main"
        files = {f["path"]: f["status"] for f in out["changed_files"]}
        assert files == {"committed.ts": "A", "gone.ts": "D", "keep.ts": "M", "new.component.ts": "?"}, files
        rules = {r["path"]: r for r in out["rules"]}
        ng = rules[".ai/Code Reviews/styleguides/angular_v17.md"]
        assert ng["name"] == "Angular 17" and ng["category"] == "Frontend"
        assert ng["applies_to"] == "*.component.ts files" and ng["has_comment_format"] is True
        py = rules[".github/review-rules/python.md"]
        assert py["name"] == "python" and py["applies_to"] is None and py["has_comment_format"] is False


def test_explicit_base_and_subdirectory_root() -> None:
    with tempfile.TemporaryDirectory() as t:
        root = make_repo(Path(t))
        sub = root / ".github"
        out = collect.collect(sub, "main")
        assert out["status"] == "ok" and out["project_root"] == root.resolve().as_posix(), out


def test_not_a_repo_and_bad_base_are_errors() -> None:
    with tempfile.TemporaryDirectory() as t:
        assert collect.collect(Path(t), None)["status"] == "error"
        root = make_repo(Path(t))
        out = collect.collect(root, "no-such-ref")
        assert out["status"] == "error" and "merge-base" in out["reason"], out


def test_no_rules_and_no_changes() -> None:
    with tempfile.TemporaryDirectory() as t:
        root = Path(t) / "bare"
        root.mkdir()
        sh(root, "init", "-q", "-b", "main")
        sh(root, "config", "user.email", "t@example.com")
        sh(root, "config", "user.name", "t")
        (root / "a.txt").write_text("a\n")
        sh(root, "add", "-A")
        sh(root, "commit", "-q", "-m", "one")
        out = collect.collect(root, None)
        assert out["status"] == "ok" and out["rules"] == [] and out["changed_files"] == [], out


if __name__ == "__main__":
    tests = [v for k, v in dict(globals()).items() if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {t.__name__}: {e!r}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
