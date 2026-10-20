You are verifying scenario RM22, RM23, DOC1, UI7, UI8 (action: verify-scenario-trust). You are a fresh-context reviewer spawned DIRECTLY by the orchestrator — NOT by the subagent that built this work. Do not assume anything about how the work was built beyond what the committed code, the test file and spec.md tell you.

Paths:
- Repository root (a git worktree; run every command from here or with absolute paths): /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
- SPEC_FOLDER: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec
- STATE_CLI: node /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-setup/scripts/state.mjs
- Skill folder: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-develop-spec/ — read references/guardrails.md in full first, then follow semantic-verify-scenario/SKILL.md (Layer 3: semantic trust; call `verdict` exactly once, for this scenario only).

RECOVERY: First read SPEC_FOLDER/journal/scenario/<ID>.md if it exists; resume from where earlier work stopped.
JOURNAL: write INTENT (before acting) and OUTCOME (after acting) entries to SPEC_FOLDER/journal/scenario/<ID>.md.


THIS DISPATCH IS A BATCH of 5 scenarios: RM22, RM23, DOC1, UI7, UI8. Take them one at a time, in this order, and do the whole procedure below for each one before the next (its own journal, your own reading and runs of its test file, its own single `verdict`); `<ID>` below means the scenario in hand. One scenario's failure does not stop the others. Write one transcript per scenario.

VERIFICATION DETAILS (from `STATE_CLI SPEC_FOLDER query scenario/<id>`):
{
 "scenarioId": "RM22",
 "description": "The walk's reduction and key are sound (owner ruling 4)",
 "gherkin": "  Scenario: RM22 The walk's reduction and key are sound (owner ruling 4)\n    Given a small plan\n    When the canonical walk and the full walk run with and without the blocked rows\n    Then both walks find the same set of stuck states\n    And the stale walk of the loaded example-cascade plan finds no stuck state\n    And every context path that a guard reads is part of the walk key\n\n  @phase1 @compat",
 "testFile": "packages/opencode/test/task/verify-spec-RM22.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "RM23",
 "description": "The port behaves as the spine relies on",
 "gherkin": "  Scenario: RM23 The port behaves as the spine relies on\n    Given the pinned xstate port\n    When the 2026-10-14 probes run\n    Then a state id is split on dots, a final state inside a parallel region still takes events, and an onDone target re-enters the region\n    And a pure transition on a done snapshot still runs a microstep, and raised and done events carry no time\n    And snapshot tags are an array, an eventless loop past the iteration cap fails, and the walk limit counts edges\n\n  @phase1 @compat",
 "testFile": "packages/opencode/test/task/verify-spec-RM23.spec.ts",
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
{
 "scenarioId": "UI7",
 "description": "A closing summary appears in the transcript when the run ends",
 "gherkin": "  Scenario: UI7 A closing summary appears in the transcript when the run ends\n    Given a run that ends with a dead task, a blocked task, a rejected scenario and a parked scenario\n    When the run machine reaches a final state\n    Then the root session gets one assistant-role markdown message with no model call\n    And it holds the outcome line, the counts line with the duration, tokens and cost, the stopped tasks with their reasons, the scenarios that did not pass with their reasons, the scenarios not run, and a table of every task's duration\n    And it holds the run-warning line when the spec stopped validating during the run\n    And a reason that holds <, *, _, a backtick or | shows each character as written, because the summary escapes model text\n\n  @phase4 @core @edge",
 "testFile": "packages/opencode/test/task/verify-spec-UI7.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "UI8",
 "description": "The summary is written even when a turn is in flight or the run was cancelled",
 "gherkin": "  Scenario: UI8 The summary is written even when a turn is in flight or the run was cancelled\n    Given a root session with a turn in flight\n    When the run ends, or the user aborts the root session, or the run is cancelled\n    Then the summary waits for the turn and is then written once\n    And a later user prompt in the root session still runs a model turn\n\n  @phase4 @core",
 "testFile": "packages/opencode/test/task/verify-spec-UI8.spec.ts",
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
All five tests are committed. RM22's signed structural run 20261017T113011Z-05ff6f passed all 7 tests including the 99-minute stale walk; the short run without TASK_GRAPH_STALE intentionally skips that one test. For RM22, do not repeat the 99-minute walk just to review semantics: read the committed test, the RM22 journal/transcript, and the adapter run.json/JUnit metadata (never evidence or keys); rerun only short tests if needed. Check the reduction claims, full stale walk assertion, and guard-path assertions against the Gherkin; reject if the coverage is weak. UI7 and UI8 were originally RED and later passed a fresh signed adapter after D10/D11 source fixes. Do not change source or tests. This is one sequential verifier batch, not a parallel fan-out. Use the state CLI verdict for each only after independent Gherkin review.
Report back in under 150 words: the outcome, the CLI response's state and trustLevel, and any gap.