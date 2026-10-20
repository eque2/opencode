You are verifying scenario VF6, VF7, VF8, VF9, VF10 (action: verify-scenario-trust). You are a fresh-context reviewer spawned DIRECTLY by the orchestrator — NOT by the subagent that built this work. Do not assume anything about how the work was built beyond what the committed code, the test file and spec.md tell you.

Paths:
- Repository root (a git worktree; run every command from here or with absolute paths): /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
- SPEC_FOLDER: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/spec
- STATE_CLI: node /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-setup/scripts/state.mjs
- Skill folder: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/.claude/skills/eque2-code-develop-spec/ — read references/guardrails.md in full first, then follow semantic-verify-scenario/SKILL.md (Layer 3: semantic trust; call `verdict` exactly once, for this scenario only).

RECOVERY: First read SPEC_FOLDER/journal/scenario/<ID>.md if it exists; resume from where earlier work stopped.
JOURNAL: write INTENT (before acting) and OUTCOME (after acting) entries to SPEC_FOLDER/journal/scenario/<ID>.md.


THIS DISPATCH IS A BATCH of 5 scenarios: VF6, VF7, VF8, VF9, VF10. Take them one at a time, in this order, and do the whole procedure below for each one before the next (its own journal, your own reading and runs of its test file, its own single `verdict`); `<ID>` below means the scenario in hand. One scenario's failure does not stop the others. Write one transcript per scenario.

VERIFICATION DETAILS (from `STATE_CLI SPEC_FOLDER query scenario/<id>`):
{
 "scenarioId": "VF6",
 "description": "A subtree run after an untrusted folder task outside it is refused at the start",
 "gherkin": "  Scenario: VF6 A subtree run after an untrusted folder task outside it is refused at the start\n    Given the release-notes spec with no stored run\n    When /task runs on the T1.3 task folder, which is after T1.1\n    Then the run is refused before any work\n    And the refusal line names T1.3 and T1.1 as \"R12 <folder>: T1.3 is after T1.1, which is outside this run and not trusted\"\n    And the trust of T1.1 is read by folding the stored slices through their own plans\n\n  @phase3 @permissions",
 "testFile": "packages/opencode/test/task/verify-spec-VF6.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "VF7",
 "description": "A subtree run whose outside folder task is trusted runs, and /task trust cannot trust a folder task",
 "gherkin": "  Scenario: VF7 A subtree run whose outside folder task is trusted runs, and /task trust cannot trust a folder task\n    Given a stored run in which T1.1 ended trusted\n    When /task runs on the T1.3 task folder\n    Then the run starts and its external region for T1.1 is trusted directly after run.started\n    And /task trust T1.1 never moves an external region\n\n  @phase3 @core",
 "testFile": "packages/opencode/test/task/verify-spec-VF7.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "VF8",
 "description": "A subtree run names the scenarios it leaves out",
 "gherkin": "  Scenario: VF8 A subtree run names the scenarios it leaves out\n    Given the release-notes spec\n    When /task runs on a task folder whose scenarios need tasks outside it\n    Then the run's first message names each left-out scenario\n    And the header metadata lists the same ids\n\n  @phase3 @negative",
 "testFile": "packages/opencode/test/task/verify-spec-VF8.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "VF9",
 "description": "The format-faults folder is refused with all three faults listed",
 "gherkin": "  Scenario: VF9 The format-faults folder is refused with all three faults listed\n    Given the example-format-faults spec folder with a stray file, a TASK.md with no title and an unknown front-matter key\n    When /task runs on it\n    Then the refusal lists an R1 line, an R3 line and an R4 line, in the loader's rule order\n\n  @phase3 @negative",
 "testFile": "packages/opencode/test/task/verify-spec-VF9.spec.ts",
 "workingDirectory": "packages/opencode",
 "dependencies": []
}
{
 "scenarioId": "VF10",
 "description": "The cycle folder is refused with the cycle named",
 "gherkin": "  Scenario: VF10 The cycle folder is refused with the cycle named\n    Given the example-cycle spec folder where T1.1 is after T1.2 and T1.2 is after T1.1\n    When /task runs on it\n    Then the refusal has an R7 line that names the cycle through T1.1 and T1.2\n\n  @phase3 @negative",
 "testFile": "packages/opencode/test/task/verify-spec-VF10.spec.ts",
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