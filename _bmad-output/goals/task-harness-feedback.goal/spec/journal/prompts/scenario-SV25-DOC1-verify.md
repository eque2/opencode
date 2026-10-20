You are verifying scenario SV25, SV26, SV27, DOC1 (action: verify). You are a fresh-context reviewer spawned DIRECTLY by the orchestrator — NOT by the subagent that built this work. Do not assume anything about how the work was built beyond what the committed code, the test file and spec.md tell you.

Paths:
- Repository root (a git worktree; run every command from here or with absolute paths): /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
- SPEC_FOLDER: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec
- STATE_CLI: node /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-setup/scripts/state.mjs
- Skill folder: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-develop-spec/ — read references/guardrails.md in full first, then follow verify-scenario/SKILL.md (Layer 1+2: locate or write the test, run it, consume the evidence with `verify`).

RECOVERY: First read SPEC_FOLDER/journal/scenario/<ID>.md if it exists; resume from where earlier work stopped.
JOURNAL: write INTENT (before acting) and OUTCOME (after acting) entries to SPEC_FOLDER/journal/scenario/<ID>.md.


THIS DISPATCH IS A BATCH of 4 scenarios: SV25, SV26, SV27, DOC1. Take them one at a time, in this order, and do the whole procedure below for each one before the next (its own journal, its own test file, its own run, its own `verify`); `<ID>` below means the scenario in hand. One scenario's failure does not stop the others. Write one transcript per scenario.

VERIFICATION DETAILS (from `STATE_CLI SPEC_FOLDER query scenario/<id>`):
{
 "scenarioId": "SV25",
 "description": "A cancel before the new slice starts never lands in the previous slice",
 "gherkin": "  Scenario: SV25 A cancel before the new slice starts never lands in the previous slice\n    Given a stored release-notes slice that ended, and a new /task whose run supervisor has not yet stored run.started\n    When the background job is cancelled\n    Then the store holds the new slice's run.started before its run.cancelled\n    And the previous slice folds to the same snapshot as before the cancel\n\n  @phase2 @negative",
 "testFile": "packages/opencode/test/task/verify-spec-SV25.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "SV26",
 "description": "An actor error ends its unit or its run, never strands it",
 "gherkin": "  Scenario: SV26 An actor error ends its unit or its run, never strands it\n    Given a live run whose task supervisor, run supervisor or run actor reaches the error status\n    When the error happens\n    Then a failed unit supervisor counts as three worker failures, so its unit records task.failed with \"harness error: <defect>\"\n    And a failed run supervisor or run actor ends the job's wait, the Recorder stores nothing more, the defect is logged and the directory lease is released\n    And a later /task on that spec treats a slice whose fold dies as ended, logs it, and says in its start message that it starts a new slice\n\n  @phase2 @integrity",
 "testFile": "packages/opencode/test/task/verify-spec-SV26.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "SV27",
 "description": "A server stop leaves the run resumable",
 "gherkin": "  Scenario: SV27 A server stop leaves the run resumable\n    Given a live run with a building task and a verifying scenario\n    When the instance scope closes without a job cancel\n    Then the store holds no run.cancelled, no task.failed and no scenario.verified from the stop, and no summary is written\n    And an interrupted worker never counts as a worker failure\n    And the next /task with the same path records run.resumed\n  # ---------------------------------------------------------------------------\n  # Phase 3 \u2014 validation and fault folders (AC 1, AC 12-17)\n  # ---------------------------------------------------------------------------\n\n  @phase3 @negative",
 "testFile": "packages/opencode/test/task/verify-spec-SV27.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "DOC1",
 "description": "The blend format README answers questions 1, 3 and 4 in a Validation section",
 "gherkin": "  Scenario: DOC1 The blend format README answers questions 1, 3 and 4 in a Validation section\n    Given the blend format README\n    When a reader opens its Validation section\n    Then it says what runs before any work starts and how a refusal appears\n    And it lists every rule R1 to R13 with the place that enforces it\n    And it says how the run machine holds the order and which graph faults are refused\n    And it names the six fault folders and the two live-check folders\n\n  # ---------------------------------------------------------------------------\n  # Phase 1 \u2014 one run machine (AC 2-6)\n  # ---------------------------------------------------------------------------\n\n  @phase1 @core",
 "testFile": "packages/opencode/test/task/verify-spec-DOC1.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}

SPEC: read SPEC_FOLDER/spec.md and SPEC_FOLDER/scenarios.gherkin for this scenario; SPEC_FOLDER/tasks.md names the tasks that support it (search for "<ID>" in their Supports lines) and SPEC_FOLDER/journal/task/<task>.md maps the existing unit tests.

PROJECT RULES (owner ruling 6, goal.md "Verification"):
- Every scenario test is a `bun test` file at the testFile above, run from its workingDirectory (packages/opencode), never from the root: `bun test --timeout=30000 --reporter=junit --reporter-outfile=<run dir>/junit.xml ./test/task/verify-spec-<ID>.spec.ts`.
- Each test title starts with `[<ID>]`. The test drives the real code (the plan loader, the engine, the supervisors, the status projection, the command, the task-ui store and renders) with the project's existing test helpers (packages/opencode/test/task/lib/, test/fixture/); it never re-implements the code under test and never mocks the unit under test.
- The scenario-state-reporter supports only Vitest and Playwright. Use the adapter at /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec/journal/adapter/bun-junit-scenario-adapter.mjs: it spawns `bun test` with the JUnit reporter, reads the report, and passes each result UNCHANGED to the reporter's public Vitest hook `onTestRunEnd(files)`. If the adapter file does not exist yet, build it there following the recipe and the refusal rules in /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/log-proxy/_bmad-output/goals/log-proxy.goal/spec/journal/S6.md (it refuses a report for another file, a count mismatch, a green exit with no report, and a test-file edit during the run; a non-zero bun exit makes the file result fail). Never edit the reporter, the state CLI or any enforcement program; never read evidence or key files.
- The adapter exists and is proved (its contract is in its header comment; the recipe and the proofs are in SPEC_FOLDER/journal/scenario/RM1.md). Use it as it is; do not rebuild or edit it. One real run:
    node /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec/journal/adapter/bun-junit-scenario-adapter.mjs --cwd=/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/packages/opencode --file=./test/task/verify-spec-<ID>.spec.ts --runs=/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec/journal/adapter/runs/<ID> --spec-folder=/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec --reporter=/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-setup/scripts/scenario-state-reporter.mjs
  then `STATE_CLI SPEC_FOLDER verify <ID> --evidence=SPEC_FOLDER/evidence/<ID>.json`. Adapter exit 0 = handed off with bun 0; 1 = handed off with bun non-zero (a failing run: fix the test or record the defect); 3 = refused (read run.json in the run dir); 4 = usage or infrastructure. Run a trial without the adapter first (`bun test --timeout=30000 ./test/task/verify-spec-<ID>.spec.ts` in packages/opencode) until the file passes, then one adapter run.
- A test that renders task-ui code imports it by relative path from packages/opencode/test/task (`../../../tui/src/task-ui/...`, and the tui test helpers such as `../../../tui/test/task-ui/view`); the tui package exports no task-ui path. packages/opencode has the Solid preload (`/** @jsxImportSource @opentui/solid */`, testRender from `@opentui/solid`; see test/cli/run/footer.view.test.tsx).
- Do NOT commit anything: the orchestrator commits the test file.
- The machine is shared and can be heavily loaded: a timeout caused by load alone is not a defect; re-run once.

STATE — via the state CLI ONLY: one JSON object on stdout, exit 0 on success; a non-zero exit with a stderr message is a HARD ERROR: stop and report it.
  Before work: `STATE_CLI SPEC_FOLDER query scenario/<ID>`; if status is not_started: `STATE_CLI SPEC_FOLDER update <ID> start --reason "Beginning verification"`.
  Structural result (verify): the reporter writes signed evidence; you then run `STATE_CLI SPEC_FOLDER verify <ID> --evidence=SPEC_FOLDER/evidence/<ID>.json`. There is no manual-completion fallback.
  Semantic verdict (verify-scenario-trust only; never in a `verify` dispatch):
    Trust:  `STATE_CLI SPEC_FOLDER verdict <ID> trusted --reason "<reasoning covering each Gherkin step>"`
    Reject: `STATE_CLI SPEC_FOLDER verdict <ID> rejected --reason "<specific issues per Gherkin step>"`
    Never call `update <ID> trust`. Never call `verdict` on any other actor. If a `verdict` call is denied by the permission system, do not retry it and do not try another route: report the denial.
  Genuine inability to run or write the test: `STATE_CLI SPEC_FOLDER update <ID> fail --reason "<what went wrong>"`.

EXECUTION MODE: run every command in the FOREGROUND within this turn; no run_in_background, no detached waiters; keep each command under 10 minutes.

GUARDRAILS: Evidence, state files, and signing keys are protected by POLICY: do NOT (1) read, modify, or fabricate evidence files or a legacy `.evidence-key`; (2) modify state folders directly; (3) forge or hand-edit a verdict, `state/events.jsonl`, or `state/HEAD.json`; (4) read signing-key material (`state/integrity-key.json`, a spec folder's `.signer-key`, a legacy `.evidence-key`, or a keychain entry); (5) modify the enforcement programs (`state.mjs`, `tests-cli.mjs`, `scenario-state-reporter.mjs`, `verification-runner.py`, `preflight-check.py`, `goal-gate-stop.sh`). In a verify dispatch you may write only the scenario's test file; do not change any source file. If the code fails the scenario, record the failing evidence and report it. Other verifiers run at the same time on other scenarios; do not touch their files.

NEVER ask the user questions — run autonomously.

TRANSCRIPT: as your FINAL action, write SPEC_FOLDER/journal/transcripts/<ID>-verify-<YYYYMMDD-HHmmss>.md: what you read, each Gherkin step and the assertion that covers it (or the gap), the commands and their results, and the outcome.
This runtime is OpenCode: no permission classifier sits in front of the state CLI. THIS BATCH RE-VERIFIES THREE SCENARIOS. (a) SV25 and SV27 are already completed and verified, and their test files are committed (0ff4d640e0), but each fails a repository style check: verify-spec-SV25.spec.ts imports `eventually` and never uses it (`npx oxlint --deny-warnings` at the repository root fails, which fails the quality gate `bun lint`), and verify-spec-SV27.spec.ts fails `npx prettier --check`. For each, make ONLY that style fix (remove the unused import; run `npx prettier --write` on the file), change no assertion, run the trial, make one fresh adapter run, then call `verify <ID>` with the new evidence. Do not call `update start` for them. (b) SV26 is not_started (retry 1): its earlier verifier found defects D8 and D9 (journal/defects.md); a builder fixed them in 077320f8e4 and c8ffccfee1. The uncommitted test file verify-spec-SV26.spec.ts is the earlier verifier's; judge it against the Gherkin, run `npx prettier --write` on it (it fails prettier), run the trial, make one adapter run, call `verify SV26`. (c) DOC1 is not_started: the normal procedure. Before any adapter run, `npx oxlint --deny-warnings <file>` and `npx prettier --check <file>` from the repository root must be clean.
Report back in under 150 words: the outcome, the CLI response's state and trustLevel, and any gap.