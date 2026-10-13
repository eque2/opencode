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
import re
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


def test_shipped_assets_use_no_node20_action_majors():
    # GitHub deprecated the Node 20 runtime; these majors still run on it and
    # make every PR-review run warn "Node.js 20 is deprecated".
    last_node20_major = {"checkout": 4, "github-script": 7, "upload-artifact": 4, "download-artifact": 4}
    pin = re.compile(r"uses:\s*actions/(checkout|github-script|upload-artifact|download-artifact)@v(\d+)")
    offenders = [
        f"{path.relative_to(ASSETS)}: actions/{m[1]}@v{m[2]}"
        for path in sorted(ASSETS.rglob("*.yml"))
        for m in pin.finditer(path.read_text())
        if int(m[2]) <= last_node20_major[m[1]]
    ]
    assert not offenders, "Node 20 action majors still shipped:\n" + "\n".join(offenders)


def _shipped(*globs):
    return sorted(p for g in globs for p in ASSETS.rglob(g))


def _logical_lines(text):
    """Join shell continuations (`\\` at line end) so a split command reads as one line."""
    return re.sub(r"\\\n\s*", " ", text).splitlines()


def test_third_party_actions_are_pinned_to_a_commit_sha():
    # A moving tag lets whoever controls it change code that runs with the
    # review's secrets. First-party actions/* stay on major tags.
    offenders = [
        f"{p.relative_to(ASSETS)}: {m[1]}@{m[2]}"
        for p in _shipped("*.yml")
        for m in re.finditer(r"uses:\s*([\w.-]+/[\w./-]+)@(\S+)", p.read_text())
        if not m[1].startswith("actions/") and not re.fullmatch(r"[0-9a-f]{40}", m[2])
    ]
    assert not offenders, "Third-party actions not pinned to a commit SHA:\n" + "\n".join(offenders)


def test_review_workflows_never_grant_contents_write():
    offenders = [
        f"{p.relative_to(ASSETS)}:{n}"
        for p in _shipped("*.yml")
        for n, line in enumerate(p.read_text().splitlines(), 1)
        if re.match(r"\s*contents:\s*write\b", line)
    ]
    assert not offenders, "contents: write in a review workflow:\n" + "\n".join(offenders)


def test_comment_lists_are_read_with_pagination():
    # One page holds 30 comments (100 at most); a busy PR loses the rest.
    offenders = []
    for p in _shipped("*.js"):
        for n, line in enumerate(p.read_text().splitlines(), 1):
            if re.search(r"\.(listComments|listReviewComments|listCommentsForReview)\(", line):
                offenders.append(f"{p.relative_to(ASSETS)}:{n}: direct call, use github.paginate")
    for p in _shipped("*.yml", "*.md", "*.sh"):
        text = p.read_text()
        if p.suffix == ".md":  # prose names the endpoints too; only fenced commands run
            text = "\n".join(re.findall(r"```[^\n]*\n(.*?)```", text, re.S))
        for line in _logical_lines(text):
            is_read = "gh api" in line and re.search(r"/comments\b", line) \
                and not re.search(r"\s(-X|--method|--input|-f|-F|--field|--raw-field)\s", line)
            if is_read and "--paginate" not in line:
                offenders.append(f"{p.relative_to(ASSETS)}: {line.strip()[:120]}")
    assert not offenders, "Unpaginated comment reads:\n" + "\n".join(offenders)


def test_secret_bearing_runs_load_control_files_from_the_base_revision():
    # Own judgment, not in the issue list: the trust boundary is the costliest
    # regression. pull_request_target loads every control file from the base
    # branch; the PR's code may only land in its own folder, without credentials.
    pr_review = (ASSETS / "workflows/pr-review.yml").read_text()
    assert re.search(r"^  pull_request_target:", pr_review, re.M)
    assert not re.search(r"^  pull_request:", pr_review, re.M)
    offenders = []
    for p in _shipped("*.yml"):
        for step in re.split(r"\n\s*- (?=name:|uses:)", p.read_text()):
            if "actions/checkout@" not in step:
                continue
            if "persist-credentials: false" not in step:
                offenders.append(f"{p.relative_to(ASSETS)}: checkout keeps credentials")
            if "pull_request.head" in step and "path:" not in step:
                offenders.append(f"{p.relative_to(ASSETS)}: PR code checked out over the trusted workspace")
    assert not offenders, "\n".join(offenders)
