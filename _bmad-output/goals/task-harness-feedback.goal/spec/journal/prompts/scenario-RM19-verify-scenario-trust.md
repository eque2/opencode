You are verifying scenario RM19 (action: verify-scenario-trust). You are a fresh-context reviewer spawned DIRECTLY by the orchestrator — NOT by the subagent that built this work. Do not assume anything about how the work was built beyond what the committed code, the test file and spec.md tell you.

Paths:
- Repository root (a git worktree; run every command from here or with absolute paths): /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
- SPEC_FOLDER: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec
- STATE_CLI: node /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-setup/scripts/state.mjs
- Skill folder: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-develop-spec/ — read references/guardrails.md in full first, then follow semantic-verify-scenario/SKILL.md (Layer 3: semantic trust; call `verdict` exactly once, for this scenario only).

RECOVERY: First read SPEC_FOLDER/journal/scenario/RM19.md if it exists; resume from where earlier work stopped.
JOURNAL: write INTENT (before acting) and OUTCOME (after acting) entries to SPEC_FOLDER/journal/scenario/RM19.md.


VERIFICATION DETAILS (from `STATE_CLI SPEC_FOLDER query scenario/<id>`):
{
 "scenarioId": "RM19",
 "description": "The graph walk finds no stuck state in the release-notes plan (owner ruling 4)",
 "gherkin": "  Scenario: RM19 The graph walk finds no stuck state in the release-notes plan (owner ruling 4)\n    Given the release-notes plan and the engine's progress alphabet\n    When every state reachable with the canonical interleaving is walked within 60 seconds\n    Then no state that is not done lacks an event that changes its key\n    And every visited snapshot has status active or done\n\n  @phase1 @proof @ASSUMPTION:A1.a",
 "testFile": "packages/opencode/test/task/verify-spec-RM19.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}

SPEC: read SPEC_FOLDER/spec.md and SPEC_FOLDER/scenarios.gherkin for this scenario; SPEC_FOLDER/tasks.md names the tasks that support it (search for "RM19" in their Supports lines) and SPEC_FOLDER/journal/task/<task>.md maps the existing unit tests.

PROJECT RULES (owner ruling 6, goal.md "Verification"):
- Every scenario test is a `bun test` file at the testFile above, run from its workingDirectory (packages/opencode), never from the root: `bun test --timeout=30000 --reporter=junit --reporter-outfile=<run dir>/junit.xml ./test/task/verify-spec-RM19.spec.ts`.
- Each test title starts with `[RM19]`. The test drives the real code (the plan loader, the engine, the supervisors, the status projection, the command, the task-ui store and renders) with the project's existing test helpers (packages/opencode/test/task/lib/, test/fixture/); it never re-implements the code under test and never mocks the unit under test.
- The scenario-state-reporter supports only Vitest and Playwright. Use the adapter at /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec/journal/adapter/bun-junit-scenario-adapter.mjs: it spawns `bun test` with the JUnit reporter, reads the report, and passes each result UNCHANGED to the reporter's public Vitest hook `onTestRunEnd(files)`. If the adapter file does not exist yet, build it there following the recipe and the refusal rules in /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/log-proxy/_bmad-output/goals/log-proxy.goal/spec/journal/S6.md (it refuses a report for another file, a count mismatch, a green exit with no report, and a test-file edit during the run; a non-zero bun exit makes the file result fail). Never edit the reporter, the state CLI or any enforcement program; never read evidence or key files.
- The adapter exists and is proved (its contract is in its header comment; the recipe and the proofs are in SPEC_FOLDER/journal/scenario/RM1.md). Use it as it is; do not rebuild or edit it. One real run:
    node /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec/journal/adapter/bun-junit-scenario-adapter.mjs --cwd=/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/packages/opencode --file=./test/task/verify-spec-<ID>.spec.ts --runs=/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec/journal/adapter/runs/<ID> --spec-folder=/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec --reporter=/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-setup/scripts/scenario-state-reporter.mjs
  then `STATE_CLI SPEC_FOLDER verify <ID> --evidence=SPEC_FOLDER/evidence/<ID>.json`. Adapter exit 0 = handed off with bun 0; 1 = handed off with bun non-zero (a failing run: fix the test or record the defect); 3 = refused (read run.json in the run dir); 4 = usage or infrastructure. Run a trial without the adapter first (`bun test --timeout=30000 ./test/task/verify-spec-<ID>.spec.ts` in packages/opencode) until the file passes, then one adapter run.
- A test that renders task-ui code imports it by relative path from packages/opencode/test/task (`../../../tui/src/task-ui/...`, and the tui test helpers such as `../../../tui/test/task-ui/view`); the tui package exports no task-ui path. packages/opencode has the Solid preload (`/** @jsxImportSource @opentui/solid */`, testRender from `@opentui/solid`; see test/cli/run/footer.view.test.tsx).
- Do NOT commit anything: the orchestrator commits the test file.
- The machine is shared and can be heavily loaded: a timeout caused by load alone is not a defect; re-run once.

STATE — via the state CLI ONLY: one JSON object on stdout, exit 0 on success; a non-zero exit with a stderr message is a HARD ERROR: stop and report it.
  Before work: `STATE_CLI SPEC_FOLDER query scenario/RM19`; if status is not_started: `STATE_CLI SPEC_FOLDER update RM19 start --reason "Beginning verification"`.
  Structural result (verify): the reporter writes signed evidence; you then run `STATE_CLI SPEC_FOLDER verify RM19 --evidence=SPEC_FOLDER/evidence/RM19.json`. There is no manual-completion fallback.
  Semantic verdict (verify-scenario-trust only; never in a `verify` dispatch):
    Trust:  `STATE_CLI SPEC_FOLDER verdict RM19 trusted --reason "<reasoning covering each Gherkin step>"`
    Reject: `STATE_CLI SPEC_FOLDER verdict RM19 rejected --reason "<specific issues per Gherkin step>"`
    Never call `update RM19 trust`. Never call `verdict` on any other actor. If a `verdict` call is denied by the permission system, do not retry it and do not try another route: report the denial.
  Genuine inability to run or write the test: `STATE_CLI SPEC_FOLDER update RM19 fail --reason "<what went wrong>"`.

EXECUTION MODE: run every command in the FOREGROUND within this turn; no run_in_background, no detached waiters; keep each command under 10 minutes.

GUARDRAILS: Evidence, state files, and signing keys are protected by POLICY: do NOT (1) read, modify, or fabricate evidence files or a legacy `.evidence-key`; (2) modify state folders directly; (3) forge or hand-edit a verdict, `state/events.jsonl`, or `state/HEAD.json`; (4) read signing-key material (`state/integrity-key.json`, a spec folder's `.signer-key`, a legacy `.evidence-key`, or a keychain entry); (5) modify the enforcement programs (`state.mjs`, `tests-cli.mjs`, `scenario-state-reporter.mjs`, `verification-runner.py`, `preflight-check.py`, `goal-gate-stop.sh`). In a verify-scenario-trust dispatch you judge; do not change any source or test file. Other verifiers run at the same time on other scenarios; do not touch their files.

NEVER ask the user questions — run autonomously.

TRANSCRIPT: as your FINAL action, write SPEC_FOLDER/journal/transcripts/RM19-verify-scenario-trust-<YYYYMMDD-HHmmss>.md: what you read, each Gherkin step and the assertion that covers it (or the gap), the commands and their results, and the outcome.
RM19 was trusted. Commit 6c46ed46f0 changed its committed test under owner ruling 8 (goal.md, 2026-10-18, "Increase the timeout"): the walk's wall-clock bound WITHIN_MS rose from 60_000 to 180_000, the walk test's own timeout rose from 150_000 to 300_000, and the walk test title now says 'within 180 seconds'. The Gherkin text still says 60 seconds; owner ruling 8 in goal.md reads it as 180 seconds. A fresh structural run (adapter run 20261018T094942Z-44c1b9) passed and verify moved RM19 to trustLevel verified. Independently read the current Gherkin, goal.md owner rulings 4 and 8, the committed test and the real code it drives; check that no other assertion, negative control or the edge limit changed (git show 6c46ed46f0); rerun the focused test from packages/opencode. A full packages/opencode suite runs on this host at the same time; load-only slowness is not a defect. Issue exactly one CLI semantic verdict for RM19, through the hookless verifier runner: python3 .agents/skills/eque2-code-setup/scripts/verification-runner.py -- <the state.mjs verdict command>. Do not read evidence/key files, edit test/source/state, or commit.
Report back in under 150 words: the outcome, the CLI response's state and trustLevel, and any gap.