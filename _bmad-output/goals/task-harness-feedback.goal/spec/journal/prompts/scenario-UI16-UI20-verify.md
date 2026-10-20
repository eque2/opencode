You are verifying scenario UI16, UI17, UI18, UI19, UI20 (action: verify). You are a fresh-context reviewer spawned DIRECTLY by the orchestrator — NOT by the subagent that built this work. Do not assume anything about how the work was built beyond what the committed code, the test file and spec.md tell you.

Paths:
- Repository root (a git worktree; run every command from here or with absolute paths): /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
- SPEC_FOLDER: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec
- STATE_CLI: node /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-setup/scripts/state.mjs
- Skill folder: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-develop-spec/ — read references/guardrails.md in full first, then follow verify-scenario/SKILL.md (Layer 1+2: locate or write the test, run it, consume the evidence with `verify`).

RECOVERY: First read SPEC_FOLDER/journal/scenario/<ID>.md if it exists; resume from where earlier work stopped.
JOURNAL: write INTENT (before acting) and OUTCOME (after acting) entries to SPEC_FOLDER/journal/scenario/<ID>.md.


THIS DISPATCH IS A BATCH of 5 scenarios: UI16, UI17, UI18, UI19, UI20. Take them one at a time, in this order, and do the whole procedure below for each one before the next (its own journal, its own test file, its own run, its own `verify`); `<ID>` below means the scenario in hand. One scenario's failure does not stop the others. Write one transcript per scenario.

VERIFICATION DETAILS (from `STATE_CLI SPEC_FOLDER query scenario/<id>`):
{
 "scenarioId": "UI16",
 "description": "A run warning shows in the task-ui and goes when the spec validates again",
 "gherkin": "  Scenario: UI16 A run warning shows in the task-ui and goes when the spec validates again\n    Given a status with a run warning of two failures\n    When the task-ui renders\n    Then every run-state surface shows \"! spec no longer validates \u00b7 2 failures\"\n    And the shared region lists each failure line\n    And a warning toast appears once, and the warning goes from every surface when the status loses it\n\n  @phase4 @negative",
 "testFile": "packages/opencode/test/task/verify-spec-UI16.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "UI17",
 "description": "A refused run shows every reason in the task-ui",
 "gherkin": "  Scenario: UI17 A refused run shows every reason in the task-ui\n    Given a refused status with three failure lines\n    When the Ledger and a full-screen design render\n    Then the Ledger shows \"run: refused\" and every failure line\n    And the full-screen body reads \"No work started: the spec was refused.\" with every failure line\n\n  @phase4 @core",
 "testFile": "packages/opencode/test/task/verify-spec-UI17.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "UI18",
 "description": "A blocked unit has its own glyph and tone",
 "gherkin": "  Scenario: UI18 A blocked unit has its own glyph and tone\n    Given a status with a blocked task and a blocked scenario\n    When the designs render\n    Then the blocked units show \u2296 in the warning tone\n    And the Matrix legend lists \"\u2296 blocked\"\n    And a Ticker toast for a task that turns blocked shows its reason\n\n  @phase4 @ops",
 "testFile": "packages/opencode/test/task/verify-spec-UI18.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "UI19",
 "description": "The not-run line of a done run is muted and raises no notification",
 "gherkin": "  Scenario: UI19 The not-run line of a done run is muted and raises no notification\n    Given a done status whose reason is \"not run: S13 waits on T8\"\n    When the Ledger, the full-screen header and the Ticker render\n    Then the run reason line uses the muted tone, and the Ticker raises no notification for it\n    And a run with the stopped tag shows its reason line in the error tone\n\n  @phase4 @core",
 "testFile": "packages/opencode/test/task/verify-spec-UI19.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "UI20",
 "description": "The summary outcome line follows the outcome rules (owner ruling 1)",
 "gherkin": "  Scenario: UI20 The summary outcome line follows the outcome rules (owner ruling 1)\n    Given final statuses for a cancel with no dead task, a cancel after a dead task, a dead task, a rejected scenario with every task trusted, a done run with one parked scenario, and a subtree run\n    When each summary is built\n    Then the outcome lines read \"\u2014 cancelled: <first reason line>\", \"\u2014 budget exhausted\", \"\u2014 budget exhausted\", \"\u2014 failed: acceptance not proved\" and \"\u2014 done \u00b7 1 scenario not run\"\n    And the subtree summary starts with the task id and title, then \"from spec\" and the spec title\n    And a spec that stopped validating and then validated again still gives the run-warning line\n\n  @phase4 @core",
 "testFile": "packages/opencode/test/task/verify-spec-UI20.spec.ts",
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

Report back in under 150 words: the outcome, the CLI response's state and trustLevel, and any gap.