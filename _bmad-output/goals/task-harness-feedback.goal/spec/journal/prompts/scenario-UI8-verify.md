You are verifying scenario UI8 (action: verify). You are a fresh-context reviewer spawned DIRECTLY by the orchestrator — NOT by the subagent that built this work. Do not assume anything about how the work was built beyond what the committed code, the test file and spec.md tell you.

Paths:
- Repository root (a git worktree; run every command from here or with absolute paths): /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
- SPEC_FOLDER: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec
- STATE_CLI: node /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-setup/scripts/state.mjs
- Skill folder: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-develop-spec/ — read references/guardrails.md in full first, then follow verify-scenario/SKILL.md (Layer 1+2: locate or write the test, run it, consume the evidence with `verify`).

RECOVERY: First read SPEC_FOLDER/journal/scenario/UI8.md if it exists; resume from where earlier work stopped.
JOURNAL: write INTENT (before acting) and OUTCOME (after acting) entries to SPEC_FOLDER/journal/scenario/UI8.md.


VERIFICATION DETAILS (from `STATE_CLI SPEC_FOLDER query scenario/<id>`):
{
 "scenarioId": "UI8",
 "description": "The summary is written even when a turn is in flight or the run was cancelled",
 "gherkin": "  Scenario: UI8 The summary is written even when a turn is in flight or the run was cancelled\n    Given a root session with a turn in flight\n    When the run ends, or the user aborts the root session, or the run is cancelled\n    Then the summary waits for the turn and is then written once\n    And a later user prompt in the root session still runs a model turn\n\n  @phase4 @core",
 "testFile": "packages/opencode/test/task/verify-spec-UI8.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}

SPEC: read SPEC_FOLDER/spec.md and SPEC_FOLDER/scenarios.gherkin for this scenario; SPEC_FOLDER/tasks.md names the tasks that support it (search for "UI8" in their Supports lines) and SPEC_FOLDER/journal/task/<task>.md maps the existing unit tests.

PROJECT RULES (owner ruling 6, goal.md "Verification"):
- Every scenario test is a `bun test` file at the testFile above, run from its workingDirectory (packages/opencode), never from the root: `bun test --timeout=30000 --reporter=junit --reporter-outfile=<run dir>/junit.xml ./test/task/verify-spec-UI8.spec.ts`.
- Each test title starts with `[UI8]`. The test drives the real code (the plan loader, the engine, the supervisors, the status projection, the command, the task-ui store and renders) with the project's existing test helpers (packages/opencode/test/task/lib/, test/fixture/); it never re-implements the code under test and never mocks the unit under test.
- The scenario-state-reporter supports only Vitest and Playwright. Use the adapter at /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec/journal/adapter/bun-junit-scenario-adapter.mjs: it spawns `bun test` with the JUnit reporter, reads the report, and passes each result UNCHANGED to the reporter's public Vitest hook `onTestRunEnd(files)`. If the adapter file does not exist yet, build it there following the recipe and the refusal rules in /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/log-proxy/_bmad-output/goals/log-proxy.goal/spec/journal/S6.md (it refuses a report for another file, a count mismatch, a green exit with no report, and a test-file edit during the run; a non-zero bun exit makes the file result fail). Never edit the reporter, the state CLI or any enforcement program; never read evidence or key files.
- The adapter exists and is proved (its contract is in its header comment; the recipe and the proofs are in SPEC_FOLDER/journal/scenario/RM1.md). Use it as it is; do not rebuild or edit it. One real run:
    node /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec/journal/adapter/bun-junit-scenario-adapter.mjs --cwd=/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/packages/opencode --file=./test/task/verify-spec-<ID>.spec.ts --runs=/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec/journal/adapter/runs/<ID> --spec-folder=/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec --reporter=/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-setup/scripts/scenario-state-reporter.mjs
  then `STATE_CLI SPEC_FOLDER verify <ID> --evidence=SPEC_FOLDER/evidence/<ID>.json`. Adapter exit 0 = handed off with bun 0; 1 = handed off with bun non-zero (a failing run: fix the test or record the defect); 3 = refused (read run.json in the run dir); 4 = usage or infrastructure. Run a trial without the adapter first (`bun test --timeout=30000 ./test/task/verify-spec-<ID>.spec.ts` in packages/opencode) until the file passes, then one adapter run.
- A test that renders task-ui code imports it by relative path from packages/opencode/test/task (`../../../tui/src/task-ui/...`, and the tui test helpers such as `../../../tui/test/task-ui/view`); the tui package exports no task-ui path. packages/opencode has the Solid preload (`/** @jsxImportSource @opentui/solid */`, testRender from `@opentui/solid`; see test/cli/run/footer.view.test.tsx).
- Do NOT commit anything: the orchestrator commits the test file.
- The machine is shared and can be heavily loaded: a timeout caused by load alone is not a defect; re-run once.

STATE — via the state CLI ONLY: one JSON object on stdout, exit 0 on success; a non-zero exit with a stderr message is a HARD ERROR: stop and report it.
  Before work: `STATE_CLI SPEC_FOLDER query scenario/UI8`; if status is not_started: `STATE_CLI SPEC_FOLDER update UI8 start --reason "Beginning verification"`.
  Structural result (verify): the reporter writes signed evidence; you then run `STATE_CLI SPEC_FOLDER verify UI8 --evidence=SPEC_FOLDER/evidence/UI8.json`. There is no manual-completion fallback.
  Semantic verdict (verify-scenario-trust only; never in a `verify` dispatch):
    Trust:  `STATE_CLI SPEC_FOLDER verdict UI8 trusted --reason "<reasoning covering each Gherkin step>"`
    Reject: `STATE_CLI SPEC_FOLDER verdict UI8 rejected --reason "<specific issues per Gherkin step>"`
    Never call `update UI8 trust`. Never call `verdict` on any other actor. If a `verdict` call is denied by the permission system, do not retry it and do not try another route: report the denial.
  Genuine inability to run or write the test: `STATE_CLI SPEC_FOLDER update UI8 fail --reason "<what went wrong>"`.

EXECUTION MODE: run every command in the FOREGROUND within this turn; no run_in_background, no detached waiters; keep each command under 10 minutes.

GUARDRAILS: Evidence, state files, and signing keys are protected by POLICY: do NOT (1) read, modify, or fabricate evidence files or a legacy `.evidence-key`; (2) modify state folders directly; (3) forge or hand-edit a verdict, `state/events.jsonl`, or `state/HEAD.json`; (4) read signing-key material (`state/integrity-key.json`, a spec folder's `.signer-key`, a legacy `.evidence-key`, or a keychain entry); (5) modify the enforcement programs (`state.mjs`, `tests-cli.mjs`, `scenario-state-reporter.mjs`, `verification-runner.py`, `preflight-check.py`, `goal-gate-stop.sh`). In a verify dispatch you may write only the scenario's test file; do not change any source file. If the code fails the scenario, record the failing evidence and report it. Other verifiers run at the same time on other scenarios; do not touch their files.

NEVER ask the user questions — run autonomously.

TRANSCRIPT: as your FINAL action, write SPEC_FOLDER/journal/transcripts/UI8-verify-<YYYYMMDD-HHmmss>.md: what you read, each Gherkin step and the assertion that covers it (or the gap), the commands and their results, and the outcome.
UI8 was completed/trusted. Commit 688450d923 changed only its committed test: the shared wait runFinal no longer folds the run's slice every 20 ms; it polls the harness lease (free) and the stored facts (the last fact present) and returns the slice, and each of the two cases that use it then asserts once that the folded slice is ended (the run-ends case before its 1 s window, the cancel case after closed); the bound rose from 60 s to 120 s and each test's timeout from 180 s to 300 s. Reason: the fold every 20 ms slowed the run under test, so UI8 failed in two full suite runs and 2 of 9 alone (summary dropped past the 5 s cancel deadline; 60 s bound passed). No product code changed. Its source hash changed, so structural verification must refresh it. Do not update start on a completed scenario. Read the Gherkin and UI8's journal; check with git show 688450d923 that the intended behaviour and every assertion are unchanged; check root-pinned oxlint (run it from the repository root) and Prettier; run one focused trial and one fresh Bun JUnit adapter run; then state.mjs verify UI8 with the new evidence. A full packages/opencode suite runs on this host at the same time; load-only slowness is not a defect, re-run once. Do not read evidence/key files, edit source/test/state, or commit. A separate fresh verifier rejudges semantics.
Report back in under 150 words: the outcome, the CLI response's state and trustLevel, and any gap.