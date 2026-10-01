#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""
Tests for install-github-review.py — installing the PR-review Actions.

Guards the one promise that matters: a re-run of setup updates files the user
never touched and never overwrites a file the user edited.

Run:  uv run pytest scripts/tests/test-install-github-review.py
"""

import json
import os
import shutil
import subprocess
import sys

import pytest
from pathlib import Path

SCRIPT = Path(__file__).parent.resolve().parent / "install-github-review.py"
ASSETS = SCRIPT.parent.parent / "assets" / "github"


def run(root: Path, source: Path) -> dict:
    out = subprocess.run([sys.executable, str(SCRIPT), "--project-root", str(root), "--source", str(source)],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_install_update_and_keep(tmp_path):
    src = tmp_path / "src"
    (src / "workflows").mkdir(parents=True)
    (src / "workflows/a.yml").write_text("v1")
    (src / "workflows/b.yml").write_text("v1")
    repo = tmp_path / "repo"
    repo.mkdir()

    assert run(repo, src)["installed"] == ["workflows/a.yml", "workflows/b.yml"]
    assert run(repo, src)["unchanged"] == ["workflows/a.yml", "workflows/b.yml"]

    # New release ships v2; the user edited b.yml in the meantime.
    (src / "workflows/a.yml").write_text("v2")
    (src / "workflows/b.yml").write_text("v2")
    (repo / ".github/workflows/b.yml").write_text("mine")
    result = run(repo, src)
    assert result["updated"] == ["workflows/a.yml"]
    assert result["kept"] == ["workflows/b.yml"]
    assert (repo / ".github/workflows/a.yml").read_text() == "v2"
    assert (repo / ".github/workflows/b.yml").read_text() == "mine"

    # Still kept on the next run — the user's edit is never adopted as "ours".
    assert run(repo, src)["kept"] == ["workflows/b.yml"]


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_scripts_load_as_commonjs_in_an_esm_host_repo(tmp_path):
    # Issue #4: a root package.json with "type": "module" made Node load the
    # CommonJS .github/scripts as ES modules, so actions/github-script's
    # require() failed and the review never started.
    (tmp_path / "package.json").write_text('{ "type": "module" }')
    run(tmp_path, ASSETS)
    for script in ("extract-pr-info.js", "find-comment.js", "delete-comments.js"):
        path = tmp_path / ".github/scripts" / script
        # Node 20 (the runner) throws "module is not defined"; Node 22+ loads the
        # file as an empty ES module instead. Either way the export is not the
        # function the workflows call.
        check = f"process.exit(typeof require({json.dumps(str(path))}) === 'function' ? 0 : 1)"
        assert subprocess.run(["node", "-e", check], capture_output=True).returncode == 0, script


def test_shipped_assets_install_with_exec_bit_and_new_rules_path(tmp_path):
    result = run(tmp_path, ASSETS)
    assert "workflows/pr-review.yml" in result["installed"]
    assert os.access(tmp_path / ".github/scripts/fetch-jira-tickets.sh", os.X_OK)
    review = (tmp_path / ".github/workflows/code-review.yml").read_text()
    assert ".github/review-rules" in review and ".ai/" not in review and "NPM_AUTH_TOKEN" not in review


HANDLER_HARNESS = r"""
const fs = require('fs');
const [scriptPath, logText, hasToken] = process.argv.slice(1);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const posted = [];
const github = {
  paginate: async () => [
    { id: 1, name: 'extract-pr-info', conclusion: 'failure', steps: [{ name: 'Extract PR information', conclusion: 'failure' }] },
    { id: 2, name: 'code-review / code-review', conclusion: 'skipped', steps: [] },
  ],
  rest: {
    actions: { listJobsForWorkflowRunAttempt: null, downloadJobLogsForWorkflowRun: async () => ({ data: logText }) },
    issues: { createComment: async (c) => posted.push(c.body) },
  },
};
const context = { repo: { owner: 'o', repo: 'r' }, runId: 9, runAttempt: 1, payload: { pull_request: { number: 1 } } };
const env = { HAS_CLAUDE_TOKEN: hasToken, JIRA_ENABLED: 'false' };
new AsyncFunction('github', 'context', 'process', fs.readFileSync(scriptPath, 'utf8'))(github, context, { env })
  .then(() => process.stdout.write(posted[0]));
"""


def handler_comment(tmp_path, log: str, has_token: str) -> str:
    # The handler is the block scalar under handle-errors' `script: |` (stdlib
    # only: the setup scripts ship with no dependencies).
    text = (ASSETS / "workflows/pr-review.yml").read_text()
    block = text[text.index("  handle-errors:"):].split("script: |\n", 1)[1]
    body = []
    for line in block.splitlines():
        if line.strip() and not line.startswith(" " * 12):
            break
        body.append(line[12:])
    script = tmp_path / "handler.js"
    script.write_text("\n".join(body))
    return subprocess.run(["node", "-e", HANDLER_HARNESS, str(script), log, has_token],
                          capture_output=True, text=True, check=True).stdout


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_failure_comment_names_the_job_and_blames_the_token_only_when_it_is_the_cause(tmp_path):
    # Issue #5: every failure used to say "Required Secrets: CLAUDE_CODE_OAUTH_TOKEN".
    esm_log = "2026-09-30T08:00:00.0Z ##[error]ReferenceError: module is not defined in ES module scope\n"
    body = handler_comment(tmp_path, esm_log, "true")
    assert body.startswith("<!-- ai-workflow:pr-review-failed -->")
    assert "**extract-pr-info** failed at step **Extract PR information**" in body
    assert "ReferenceError: module is not defined in ES module scope" in body
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in body

    assert "secret is not set" in handler_comment(tmp_path, esm_log, "false")
    auth_log = "2026-09-30T08:00:00.0Z ##[error]API Error: 401 authentication_error: OAuth token has expired\n"
    assert "authentication error" in handler_comment(tmp_path, auth_log, "true")
