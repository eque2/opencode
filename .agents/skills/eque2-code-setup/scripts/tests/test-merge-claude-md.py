#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Tests for merge-claude-md.py — installing the pinned anti-tamper clause into a
target repo's .claude/CLAUDE.md (remove-docker workstream, Story 5.3 / E5/S17,
Phase-R B4 — the 6th named surface from Story 5.1).

Covers:
- A fresh (nonexistent) CLAUDE.md is created with the managed block.
- A pre-existing CLAUDE.md with unrelated project instructions keeps that
  content and gains the block.
- Re-running the merge twice is idempotent — exactly one managed block.
- Content BEFORE and AFTER the block both survive a re-run untouched.
- A partial/mangled marker state (only one of BEGIN/END present) falls back
  to appending a fresh block rather than guessing intent — matching
  ensure-gitignore.py's exact contract.

Run:  uv run pytest scripts/tests/test-merge-claude-md.py
"""

import json
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
MERGE_SCRIPT = SCRIPT_DIR.parent / "merge-claude-md.py"

BEGIN = "<!-- >>> eque2-code managed (do not edit this block) >>> -->"
END = "<!-- <<< eque2-code managed (do not edit this block) <<< -->"


def run_merge(path: Path):
    result = subprocess.run(
        [sys.executable, str(MERGE_SCRIPT), str(path)],
        capture_output=True, text=True,
    )
    return result


def test_creates_fresh_file_with_managed_block(tmp_path):
    claude_md = tmp_path / ".claude" / "CLAUDE.md"
    result = run_merge(claude_md)
    assert result.returncode == 0, result.stderr

    payload = json.loads(result.stdout)
    assert payload["action"] == "created"

    text = claude_md.read_text()
    assert BEGIN in text
    assert END in text
    assert "protected by POLICY" in text
    # committed-plaintext-key (Story 10-1): the clause names the committed
    # keyring + plaintext signer key instead of the retired keychain services.
    # The merged block is the 7th clause surface — pin EVERY fragment the
    # 6-surface parity test pins, so the installed-repo copy cannot drift.
    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location(
        "switch_off_clause_test", Path(__file__).parent / "test-switch-off-clause.py")
    _mod = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    flat = " ".join(text.split())
    for fragment in _mod.REQUIRED_FRAGMENTS:
        assert " ".join(fragment.split()) in flat, f"merged clause missing fragment: {fragment}"


def test_preserves_unrelated_existing_content(tmp_path):
    claude_md = tmp_path / ".claude" / "CLAUDE.md"
    claude_md.parent.mkdir(parents=True)
    claude_md.write_text("# My Project Instructions\n\nDo not use tabs.\n")

    result = run_merge(claude_md)
    assert result.returncode == 0, result.stderr

    text = claude_md.read_text()
    assert "# My Project Instructions" in text
    assert "Do not use tabs." in text
    assert BEGIN in text


def test_idempotent_on_rerun_exactly_one_block(tmp_path):
    claude_md = tmp_path / ".claude" / "CLAUDE.md"
    run_merge(claude_md)
    run_merge(claude_md)
    result3 = run_merge(claude_md)
    assert result3.returncode == 0, result3.stderr

    payload3 = json.loads(result3.stdout)
    assert payload3["action"] == "unchanged"

    text = claude_md.read_text()
    assert text.count(BEGIN) == 1
    assert text.count(END) == 1


def test_content_before_and_after_block_survives_rerun(tmp_path):
    claude_md = tmp_path / ".claude" / "CLAUDE.md"
    run_merge(claude_md)

    original = claude_md.read_text()
    claude_md.write_text("# Preface\nSome context.\n\n" + original + "\n## Trailer\nMore notes.\n")

    result = run_merge(claude_md)
    assert result.returncode == 0, result.stderr

    text = claude_md.read_text()
    assert "# Preface" in text
    assert "Some context." in text
    assert "## Trailer" in text
    assert "More notes." in text
    assert text.count(BEGIN) == 1


def test_partial_marker_state_falls_back_to_append(tmp_path):
    claude_md = tmp_path / ".claude" / "CLAUDE.md"
    claude_md.parent.mkdir(parents=True)
    # Only BEGIN present (mangled/truncated state) — must not crash or misparse.
    claude_md.write_text(f"{BEGIN}\nSome truncated content, no END marker.\n")

    result = run_merge(claude_md)
    assert result.returncode == 0, result.stderr

    text = claude_md.read_text()
    assert text.count(BEGIN) == 2  # the stale one + the freshly appended one
    assert text.count(END) == 1


def test_missing_argument_exits_nonzero():
    result = subprocess.run(
        [sys.executable, str(MERGE_SCRIPT)],
        capture_output=True, text=True,
    )
    assert result.returncode != 0


def test_clause_matches_the_other_5_named_surfaces_pinned_text(tmp_path):
    # Cross-check against Story 5.1's own required-fragment list so this
    # script's clause cannot silently drift from the other 5 named surfaces.
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "test_switch_off_clause", SCRIPT_DIR / "test-switch-off-clause.py"
    )
    story_5_1_test = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(story_5_1_test)

    claude_md = tmp_path / ".claude" / "CLAUDE.md"
    run_merge(claude_md)
    text = claude_md.read_text()

    for fragment in story_5_1_test.REQUIRED_FRAGMENTS:
        assert fragment in text, f"merge-claude-md.py's clause is missing fragment from Story 5.1: {fragment!r}"
