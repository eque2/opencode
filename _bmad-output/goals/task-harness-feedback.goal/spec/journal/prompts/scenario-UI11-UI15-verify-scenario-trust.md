You are verifying scenario UI11, UI12, UI13, UI14, UI15 (action: verify-scenario-trust). You are a fresh-context reviewer spawned DIRECTLY by the orchestrator — NOT by the subagent that built this work. Do not assume anything about how the work was built beyond what the committed code, the test file and spec.md tell you.

Paths:
- Repository root (a git worktree; run every command from here or with absolute paths): /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
- SPEC_FOLDER: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec
- STATE_CLI: node /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-setup/scripts/state.mjs
- Skill folder: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-develop-spec/ — read references/guardrails.md in full first, then follow semantic-verify-scenario/SKILL.md (Layer 3: semantic trust; call `verdict` exactly once, for this scenario only).

RECOVERY: First read SPEC_FOLDER/journal/scenario/<ID>.md if it exists; resume from where earlier work stopped.
JOURNAL: write INTENT (before acting) and OUTCOME (after acting) entries to SPEC_FOLDER/journal/scenario/<ID>.md.


THIS DISPATCH IS A BATCH of 5 scenarios: UI11, UI12, UI13, UI14, UI15. Take them one at a time, in this order, and do the whole procedure below for each one before the next (its own journal, your own reading and runs of its test file, its own single `verdict`); `<ID>` below means the scenario in hand. One scenario's failure does not stop the others. Write one transcript per scenario.

VERIFICATION DETAILS (from `STATE_CLI SPEC_FOLDER query scenario/<id>`):
{
 "scenarioId": "UI11",
 "description": "Each task shows its duration where the UX document places it",
 "gherkin": "  Scenario: UI11 Each task shows its duration where the UX document places it\n    Given a status with a running task, an ended task and a task that never started\n    When the designs render while the run is live\n    Then the running task's duration counts from its start, the ended task's is fixed, and the unstarted task's is blank\n    And durations appear in the Gantt right column, the Matrix time column, the Board card, the HUD selected-task line and the Peek heading\n    And a duration reads \"45s\", \"3m 12s\" or \"1h 4m\"\n\n  @phase4 @edge @ASSUMPTION:A2.a",
 "testFile": "packages/opencode/test/task/verify-spec-UI11.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "UI12",
 "description": "A run that stands still freezes its durations and its diamond (owner ruling 5)",
 "gherkin": "  Scenario: UI12 A run that stands still freezes its durations and its diamond (owner ruling 5)\n    Given a status whose heartbeat is older than 15 seconds and whose run has not ended\n    When the task-ui renders\n    Then a running task's duration stops at the heartbeat time\n    And the diamond is a static \u25c6\n\n  @phase4 @core",
 "testFile": "packages/opencode/test/task/verify-spec-UI12.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "UI13",
 "description": "The shortcut bar no longer shows the task-design switch hint",
 "gherkin": "  Scenario: UI13 The shortcut bar no longer shows the task-design switch hint\n    Given a live run in any design\n    When the shortcut bar renders\n    Then it shows no \"/task-design switch\" part\n    And /task-design still switches designs from the command list\n\n  @phase4 @core @accessibility",
 "testFile": "packages/opencode/test/task/verify-spec-UI13.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "UI14",
 "description": "The In the Flow diamond grows and melts while the run is live",
 "gherkin": "  Scenario: UI14 The In the Flow diamond grows and melts while the run is live\n    Given a live run\n    When any In the Flow mark renders\n    Then its diamond plays the frames \u00b7 \u2b29 \u2b2a \u2b25 \u25c6 \u2b25 \u2b2a \u2b29 at about 120 ms each through the spinner element\n    And it is a static \u25c6 when the run has ended or animations are off\n    And the Peek border title and the toast title stay static\n    And the diamond is not bold in either form\n\n  @phase4 @core",
 "testFile": "packages/opencode/test/task/verify-spec-UI14.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "UI15",
 "description": "The run's tokens and cost are shown for a /task root session",
 "gherkin": "  Scenario: UI15 The run's tokens and cost are shown for a /task root session\n    Given a /task root session whose child harness sessions spent tokens\n    When the prompt footer, the sidebar and the task-ui render\n    Then each shows the summed tokens and cost of the child sessions, live\n    And nothing shows before any harness session reports tokens, and other sessions are unchanged\n    And a free model that spent tokens shows \"$0.00\", and a narrow footer drops the root's own figure, then the word tokens\n    And the closing summary repeats the run total\n\n  @phase4 @ops",
 "testFile": "packages/opencode/test/task/verify-spec-UI15.spec.ts",
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

Report back in under 150 words: the outcome, the CLI response's state and trustLevel, and any gap.