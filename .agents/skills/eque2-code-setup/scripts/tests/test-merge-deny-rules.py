#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Tests for merge-deny-rules.py — target-repo secret deny-rule installation.

Covers (remove-docker workstream, Story 4.2 / E4/S10, Phase-R SF12):
- A fresh (nonexistent) settings.json gets created with all deny rules.
- A pre-existing settings.json with unrelated `permissions.deny` entries keeps
  them untouched and merges the new rules alongside.
- A pre-existing settings.json with NO `permissions` key at all (only `hooks`)
  is handled without crashing.
- Re-running the merge twice is idempotent — no duplicate entries, same count.
- The full expected rule set (.signer-key, .evidence-key, evidence/*.json,
  keychain-read, state/events.jsonl, state/HEAD.json, and the enforcement
  programs themselves) is present after merge.

Run:  uv run pytest scripts/tests/test-merge-deny-rules.py
"""

import json
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
MERGE_SCRIPT = SCRIPT_DIR.parent / "merge-deny-rules.py"


def run_merge(settings_path: Path):
    result = subprocess.run(
        [sys.executable, str(MERGE_SCRIPT), str(settings_path)],
        capture_output=True, text=True,
    )
    return result


def test_creates_fresh_settings_with_all_rules(tmp_path):
    settings = tmp_path / ".claude" / "settings.json"
    result = run_merge(settings)
    assert result.returncode == 0, result.stderr

    cfg = json.loads(settings.read_text())
    deny = cfg["permissions"]["deny"]

    assert "Read(.signer-key)" in deny
    assert "Read(.evidence-key)" in deny
    assert "Bash(cat:.evidence-key*)" in deny
    assert "Edit(evidence/*.json)" in deny
    assert "Edit(**/evidence/*.json)" in deny
    assert "Bash(cross-keychain:get*eque2-code-integrity*)" in deny
    assert "Bash(security:find-generic-password*eque2-code-integrity*)" in deny
    assert "Bash(secret-tool:lookup*eque2-code-integrity*)" in deny
    assert "Bash(cross-keychain:get*eque2-code-signer*)" in deny
    assert "Bash(security:find-generic-password*eque2-code-signer*)" in deny
    assert "Bash(secret-tool:lookup*eque2-code-signer*)" in deny
    assert "Edit(**/state/events.jsonl)" in deny
    assert "Edit(**/state/HEAD.json)" in deny

    # The enforcement programs, in both installed trees and the machine-global
    # gate runtime (problems/state-cli-schema-change-2026-08-18.md).
    for tree in ("**/", ".claude/", ".agents/"):
        assert f"Edit({tree}skills/eque2-code-setup/scripts/*.mjs)" in deny
        assert f"Edit({tree}skills/eque2-code-setup/scripts/*.py)" in deny
        assert f"Edit({tree}skills/eque2-code-goal-gate/*.sh)" in deny
    assert "Edit(**/goal-gate/gate/goal-gate-stop.sh)" in deny

    # Write(...) file rules are NOT matched by file permission checks (only
    # Edit(...) is), so they must never be shipped — they were silent no-ops.
    assert not any(r.startswith("Write(") for r in deny), \
        f"dead Write(...) rules present: {[r for r in deny if r.startswith('Write(')]}"


def test_purges_dead_write_rules_from_existing_settings(tmp_path):
    settings = tmp_path / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True)
    # An older install left the no-op Write(...) rules behind.
    settings.write_text(json.dumps({
        "permissions": {"deny": [
            "Read(.env)",
            "Write(evidence/*.json)",
            "Write(**/evidence/*.json)",
            "Write(**/state/events.jsonl)",
            "Write(**/state/HEAD.json)",
        ]}
    }))

    result = run_merge(settings)
    assert result.returncode == 0, result.stderr

    cfg = json.loads(settings.read_text())
    deny = cfg["permissions"]["deny"]
    assert "Read(.env)" in deny  # unrelated entry preserved
    assert not any(r.startswith("Write(") for r in deny)
    assert "Edit(evidence/*.json)" in deny
    assert "Edit(**/state/HEAD.json)" in deny


def test_preserves_unrelated_existing_deny_entries(tmp_path):
    settings = tmp_path / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({
        "permissions": {"deny": ["Read(.env)", "Bash(rm:-rf*)"]}
    }))

    result = run_merge(settings)
    assert result.returncode == 0, result.stderr

    cfg = json.loads(settings.read_text())
    deny = cfg["permissions"]["deny"]
    assert "Read(.env)" in deny
    assert "Bash(rm:-rf*)" in deny
    assert "Read(.signer-key)" in deny


def test_handles_settings_with_no_permissions_key(tmp_path):
    settings = tmp_path / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({
        "hooks": {"Stop": [{"matcher": "", "hooks": []}]}
    }))

    result = run_merge(settings)
    assert result.returncode == 0, result.stderr

    cfg = json.loads(settings.read_text())
    assert cfg["hooks"] == {"Stop": [{"matcher": "", "hooks": []}]}
    assert "Read(.signer-key)" in cfg["permissions"]["deny"]


def test_idempotent_on_rerun(tmp_path):
    settings = tmp_path / ".claude" / "settings.json"

    run_merge(settings)
    cfg1 = json.loads(settings.read_text())
    count1 = len(cfg1["permissions"]["deny"])

    result2 = run_merge(settings)
    assert result2.returncode == 0, result2.stderr
    payload2 = json.loads(result2.stdout)
    assert payload2["rules_added"] == 0

    cfg2 = json.loads(settings.read_text())
    count2 = len(cfg2["permissions"]["deny"])
    assert count1 == count2
    assert len(cfg2["permissions"]["deny"]) == len(set(cfg2["permissions"]["deny"]))


def test_no_write_deny_rules_in_tracked_settings():
    """Guard the bad pattern that keeps recurring: a Write(...) rule in a
    permissions.deny array is a silent no-op — file permission checks only
    match Edit(...). Scan every tracked .claude/settings.json in the repo.
    """
    # Walk up from this test file to the repo root (first dir with .git).
    root = SCRIPT_DIR
    while root != root.parent and not (root / ".git").exists():
        root = root.parent
    settings_files = list(root.rglob(".claude/settings.json"))
    if not settings_files:
        return  # shipped into a target repo with no such file — nothing to guard
    offenders = []
    for sf in settings_files:
        if "node_modules" in sf.parts:
            continue
        try:
            deny = json.loads(sf.read_text()).get("permissions", {}).get("deny", [])
        except (json.JSONDecodeError, OSError):
            continue
        offenders += [f"{sf}: {r}" for r in deny if r.startswith("Write(")]
    assert not offenders, (
        "Write(...) deny rules are no-ops (use Edit(...) — it covers Write too):\n"
        + "\n".join(offenders)
    )


def test_missing_argument_exits_nonzero():
    result = subprocess.run(
        [sys.executable, str(MERGE_SCRIPT)],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
