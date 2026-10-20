You are verifying scenario UI5, UI6, UI9, UI10, UI11 (action: verify-scenario-trust). You are a fresh-context reviewer spawned DIRECTLY by the orchestrator — NOT by the subagent that built this work. Do not assume anything about how the work was built beyond what the committed code, the test file and spec.md tell you.

Paths:
- Repository root (a git worktree; run every command from here or with absolute paths): /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
- SPEC_FOLDER: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec
- STATE_CLI: node /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-setup/scripts/state.mjs
- Skill folder: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-develop-spec/ — read references/guardrails.md in full first, then follow semantic-verify-scenario/SKILL.md (Layer 3: semantic trust; call `verdict` exactly once, for this scenario only).

RECOVERY: First read SPEC_FOLDER/journal/scenario/<ID>.md if it exists; resume from where earlier work stopped.
JOURNAL: write INTENT (before acting) and OUTCOME (after acting) entries to SPEC_FOLDER/journal/scenario/<ID>.md.


THIS DISPATCH IS A BATCH of 5 scenarios: UI5, UI6, UI9, UI10, UI11. Take them one at a time, in this order, and do the whole procedure below for each one before the next (its own journal, your own reading and runs of its test file, its own single `verdict`); `<ID>` below means the scenario in hand. One scenario's failure does not stop the others. Write one transcript per scenario.

VERIFICATION DETAILS (from `STATE_CLI SPEC_FOLDER query scenario/<id>`):
{
 "scenarioId": "UI5",
 "description": "An outside wait and an external wait read differently",
 "gherkin": "  Scenario: UI5 An outside wait and an external wait read differently\n    Given a waiting task whose waitingOn holds the untrusted outside id T9 and the external id T1.1\n    When the Board card, the Peek and the collapsed views render\n    Then the outside wait reads \"waiting on T9 (outside) \u2014 run /task trust T9\" on every design, and the shortcut bar has an outside-wait part\n    And the external wait reads \"waiting on T1.1 (not in this run)\" with no trust command\n\n  @phase4 @core",
 "testFile": "packages/opencode/test/task/verify-spec-UI5.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "UI6",
 "description": "The run header shows the spec title",
 "gherkin": "  Scenario: UI6 The run header shows the spec title\n    Given the release-notes spec, whose title is \"Release notes from conventional commits\"\n    When /task starts a whole-spec run and a subtree run\n    Then the first message reads \"Implementing spec\" and the title, from structured header metadata\n    And the transcript draws \"Implementing spec\" muted and the title bold, from that metadata\n    And a subtree run reads \"Implementing\" with the task id and title, then \"from spec\" and the spec title\n    And an empty title falls back to the spec id, and the status run carries the title and, for a subtree run, the task\n    And a subtree run that leaves scenarios out adds the muted line \"Left out: <ids> \u2014 they need tasks outside this run.\"\n    And an older header in the scrollback keeps its own title when a later run starts\n\n  @phase4 @core",
 "testFile": "packages/opencode/test/task/verify-spec-UI6.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "UI9",
 "description": "Failure reasons appear in every expanded view and in the Peek heading",
 "gherkin": "  Scenario: UI9 Failure reasons appear in every expanded view and in the Peek heading\n    Given a status with a budget-exhausted task, a failed task and a blocked task\n    When each of the seven designs is expanded\n    Then the shared region lists each stopped task with its reason or upstream cause\n    And the Peek BUILDER heading shows the selected task's reason in full, wrapped\n    And the collapsed views keep only the glyph\n\n  @phase4 @core",
 "testFile": "packages/opencode/test/task/verify-spec-UI9.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "UI10",
 "description": "Every expanded view lists the run's scenarios",
 "gherkin": "  Scenario: UI10 Every expanded view lists the run's scenarios\n    Given the release-notes status with thirteen scenarios, titles, one rejected scenario and one parked scenario\n    When each of the seven designs is expanded at 120 by 40 cells\n    Then the shared region lists S1 to S13 with glyph, id, state label and title\n    And the rejected scenario shows its reason under its entry\n    And after the run ends the parked scenario reads \"not run\"\n\n  @phase4 @core",
 "testFile": "packages/opencode/test/task/verify-spec-UI10.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "UI11",
 "description": "Each task shows its duration where the UX document places it",
 "gherkin": "  Scenario: UI11 Each task shows its duration where the UX document places it\n    Given a status with a running task, an ended task and a task that never started\n    When the designs render while the run is live\n    Then the running task's duration counts from its start, the ended task's is fixed, and the unstarted task's is blank\n    And durations appear in the Gantt right column, the Matrix time column, the Board card, the HUD selected-task line and the Peek heading\n    And a duration reads \"45s\", \"3m 12s\" or \"1h 4m\"\n\n  @phase4 @edge @ASSUMPTION:A2.a",
 "testFile": "packages/opencode/test/task/verify-spec-UI11.spec.ts",
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

GUARDRAILS: Evidence, state files, and signing keys are protected by POLICY: do NOT (1) read, modify, or fabricate evidence files or a legacy `.evidence-key`; (2) modify state folders directly; (3) forge or hand-edit a verdict, `state/events.jsonl`, or `state/HEAD.json`; (4) read signing-key material (`state/integrity-key.json`, a spec folder's `.signer-key`, a legacy `.evidence-key`, or a keychain entry); (5) modify the enforcement programs (`state.mjs`, `tests-cli.mjs`, `scenario-state-reporter.mjs`, `verification-runner.py`, `preflight-check.py`, `goal-gate-stop.sh`). In a verify-scenario-trust dispatch you judge; do not change any source or test file. Other verifiers run at the same time on other scenarios; do not touch their files.

NEVER ask the user questions — run autonomously.

TRANSCRIPT: as your FINAL action, write SPEC_FOLDER/journal/transcripts/<ID>-verify-scenario-trust-<YYYYMMDD-HHmmss>.md: what you read, each Gherkin step and the assertion that covers it (or the gap), the commands and their results, and the outcome.
Committed and structurally verified UI scenarios. Review real outside/external waits, run header metadata, failure reasons in expanded views and Peek, scenario lists, and task durations. Trace each test assertion to the actual TUI sources; do not substitute a snapshot test for plugin behavior without justification. Rerun focused tests. No evidence/key reads or source/test/state edits; one CLI verdict per case, do not commit.
Report back in under 150 words: the outcome, the CLI response's state and trustLevel, and any gap.