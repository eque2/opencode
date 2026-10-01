#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Tests for SKILL.md — asserts no load-bearing Docker/MCP-registration content
survives the remove-docker workstream's Story 2.3 rewrite (Epic 2, CAP-1/CAP-2).

Narrowly scoped to SKILL.md itself (this story's only edit target). The
repo-tree-wide grep sweep (bin/*.sh, references/*.md, agent prompts) is a
LATER story's job (charter Story 3.2 / "purge ralph-loop/docker/mcp prose
repo-wide") — this test does not attempt that broader scope.

Run:  uv run pytest scripts/tests/test-skill-md-no-docker.py
"""

import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
SKILL_MD = SCRIPT_DIR.parent.parent / "SKILL.md"


def _text() -> str:
    return SKILL_MD.read_text()


def test_no_docker_commands():
    text = _text()
    # Actual shell invocations of docker — not explanatory prose about its absence.
    forbidden_patterns = [
        r"\bdocker build\b",
        r"\bdocker run\b",
        r"\bdocker exec\b",
        r"\bdocker image inspect\b",
        r"\bdocker volume create\b",
        r"\bdocker ps\b",
    ]
    for pattern in forbidden_patterns:
        matches = re.findall(pattern, text)
        assert not matches, f"SKILL.md still contains a live docker invocation matching {pattern!r}: {matches}"


def test_no_claude_mcp_add_for_the_three_servers():
    text = _text()
    for server in ("eque2-code-state", "eque2-tests", "eque2-xray"):
        pattern = re.compile(rf"claude mcp add[^\n]*{re.escape(server)}")
        assert not pattern.search(text), f"SKILL.md still registers {server} via claude mcp add"


def test_no_dockerfile_reference():
    text = _text()
    assert "Dockerfile" not in text, "SKILL.md still references a Dockerfile"


def test_no_deleted_wrapper_script_references():
    text = _text()
    deleted_wrappers = [
        "eque2-state-launch.sh",
        "eque2-state-launch.cmd",
        "eque2-state-tail.sh",
        "eque2-tests-launch.sh",
        "eque2-tests-admin.sh",
        "eque2-tests-smoke.sh",
        "eque2-tests-smoke.mjs",
        "eque2-tests-tail.sh",
    ]
    for wrapper in deleted_wrappers:
        assert wrapper not in text, f"SKILL.md still references the deleted wrapper {wrapper!r}"


def test_migration_script_is_wired_in():
    text = _text()
    assert "migrate-remove-docker.py" in text, (
        "SKILL.md must call migrate-remove-docker.py so existing Dockerized installs get cleaned up"
    )


def test_cli_help_verification_step_present():
    text = _text()
    assert "state.mjs" in text and "--help" in text, (
        "SKILL.md should verify the shipped CLI resolves (state.mjs --help) as part of setup"
    )


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-q"]))
