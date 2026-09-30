---
name: build-task
description: Implement a single spec subtask using TDD red-green-refactor. Dispatched by the DS orchestrator for action=build.
---

# Build Task

Implement ONE subtask from a buildable spec using test-driven development.

**Single task focus** — implement only the specified task. Never implement adjacent tasks.

## Input parameters

Received from the DS orchestrator via the subagent prompt:

- `task_id` — actor ID (e.g. `task/T1.2`)
- `action` — always `"build"`
- `context_info` — snapshot context from `node {STATE_CLI} $SPEC_FOLDER next`
- `SPEC_FOLDER` — absolute path to the feature folder

## Critical rules

1. **TDD required** — write failing tests first, then implement, then refactor.
2. **Single task only** — never implement other tasks.
3. **No user interaction** — fully autonomous.
4. **State via the CLI only** — never edit state files directly.

## Execution

### 1. Load context

a) Run `node {STATE_CLI} $SPEC_FOLDER query task/{task_id}` — extract `.status`. Verify it is `not_started` or `building`. If terminal state, run `node {STATE_CLI} $SPEC_FOLDER update task/{task_id} fail --reason "Task already in terminal state"` and EXIT.

b) Run `node {STATE_CLI} $SPEC_FOLDER update task/{task_id} start --reason "Beginning implementation"`.

c) Read `{SPEC_FOLDER}/spec.md` — parse Overview, Implementation Plan, Context, Affected Files, and locate this task's definition.

d) Load project standards from `CLAUDE.md`, `**/project-context.md`, `{project-root}/docs/CLAUDE/code-standards/`.

e) Discover and cache commit conventions per `references/quality-checks.md`.

f) Load Figma context if the spec references Figma data paths: read `{project-root}/_bmad/eque2-code/data/figma-standards.md` (Sections 1–2), `tokens-mcp.json`, `effects.json`, `SUMMARY.md`.

g) Check `journal/task/{task_id}.md` for prior attempt context if `attemptNumber > 1`. Plan a different approach on retries.

### 2. Implement (TDD)

**RED phase:**
- Write test file(s) per project conventions. Include happy path, edge cases, error conditions.
- Run tests and confirm FAIL. Tests that pass without implementation are wrong.
- Commit: `test({slug}): Task {task_id} - add failing tests`

**GREEN phase:**
- Implement the minimum code to pass the tests.
- Apply Figma token dedup and CSS architecture rules if Figma context was loaded.
- Run tests after each change. Continue until all pass.
- If stuck after 3 attempts: run `node {STATE_CLI} $SPEC_FOLDER update task/{task_id} fail --reason "<blocker>"` and EXIT.

**REFACTOR phase:**
- Improve code quality (remove duplication, improve naming, simplify). Run tests after each refactor.
- Do NOT add new functionality.

Final test run to confirm all green.

### 3. Validate and complete

a) Run lint, full test suite, and typecheck. Fix any failures. Re-run until clean. Treat warnings as errors.

b) Mark task `[x]` in spec file.

c) Commit using the discovered commit convention.

d) Write journal entry to `{SPEC_FOLDER}/journal/task/{task_id}.md`.

e) Run `node {STATE_CLI} $SPEC_FOLDER update task/{task_id} complete --reason "<outcome summary>"`. This triggers structural verification — the task only advances if it passes. If the response has `success: false` (a side effect of type `completion-verification-failed` carries the reason), the task is NOT complete: fix what the reason names (usually a missing/failing test), then call `complete` again. Do NOT fall back to `fail` for a failed verification.

f) Write transcript to `{SPEC_FOLDER}/journal/transcripts/{task_id}-build-{timestamp}.md`.

## Exit states

- Completed: `update ... complete` called and structural verification passed (response `success: true`).
- Failed: `update ... fail` called with reason — only for a genuine, unrecoverable work failure, never for a failed verification (retry `complete` after fixing instead).
