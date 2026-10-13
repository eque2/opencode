---
name: verify-scenario
description: Locate or write a scenario test, run it with its native runner and the scenario-state-reporter, record result. Dispatched (as a fresh orchestrator-spawned sibling subagent) for action=verify.
---

# Verify Scenario

Execute the test file for a scenario and report the result. The scenario-state-reporter produces HMAC-signed evidence for Vitest and Playwright; this workflow's job is to locate or write the test, run it with its native runner, and then consume that evidence via the state CLI's `verify` verb.

## Input parameters

- `task_id` — scenario actor ID (e.g. `scenario/S1`)
- `action` — always `"verify"`
- `context_info` — snapshot context from `node {STATE_CLI} $SPEC_FOLDER next`
- `SPEC_FOLDER` — absolute path to the feature folder

## Critical rules

1. **No user interaction** — fully autonomous.
2. **Scenarios MUST run through their native runner with the reporter attached** — Vitest specs use Vitest; Playwright specs use Playwright. Running tests without the reporter will not produce evidence and verification will fail.
3. **Do NOT commit the test file** — scenario trust verification does not check `testInCommit`.
4. **State via the CLI only** — never edit state files directly.
5. **Never fabricate or touch evidence files** — HMAC signing and deny rules enforce evidence integrity.

## Execution

### 1. Load context

a) Run `node {STATE_CLI} $SPEC_FOLDER query scenario/{task_id}` — parse the JSON stdout, extract `testFile` (path relative to project root).

b) Run `node {STATE_CLI} $SPEC_FOLDER update scenario/{task_id} start --reason "Beginning verification"`.

c) Read `{SPEC_FOLDER}/spec.md` to understand the scenario's Gherkin steps and requirements.

### 2. Locate or create test file

If the test file already exists (retry/re-run): read and update rather than recreating.

**Consolidation check (before creating anything):** if `testFile` does not exist, first check
whether this scenario's assertions already live in a SIBLING verify spec (a consolidated file —
common when a TDD build covers related scenarios together). Search the test dir for
`verify-*.spec.ts` files whose content covers this scenario's Gherkin steps. If found, do NOT
duplicate the coverage into a new per-scenario file. Instead:

1. Tag the covering tests in the consolidated file with `[{task_id}]` in the it/describe title
   (e.g. `it('[S3] closes over the queued item', ...)`) — the reporter emits separate evidence
   per tagged scenario. A tag on a nested `it` counts.
2. Repoint this scenario: `node {STATE_CLI} $SPEC_FOLDER set-testfile {task_id} <consolidated-file> --reason "assertions consolidated into <file>"`.
3. Continue at step 3 running the consolidated file.

If no sibling covers it: create at the path specified by `testFile`.

Detect test framework from `package.json` and 2–3 existing `*.spec.ts` files. Consult `{project-root}/docs/CLAUDE/code-standards/` if present. Write the test asserting the scenario's key expectations, matching project import style, describe/it patterns, and assertion library.

### 3. Run with the native runner and reporter

For Vitest specs:

```bash
SPEC_FOLDER=$SPEC_FOLDER \
  npx vitest run {test-file} \
  --reporter=default \
  --reporter={skills-root}/eque2-code-setup/scripts/scenario-state-reporter.mjs
```

The reporter is purely an evidence PRODUCER: it writes HMAC-signed, source-hashed evidence JSON to `{SPEC_FOLDER}/evidence/{task_id}.json`. It does NOT call the state CLI itself — you (the verify subagent) consume that evidence next:

```bash
node {STATE_CLI} $SPEC_FOLDER verify {task_id} --evidence={SPEC_FOLDER}/evidence/{task_id}.json
```

For Playwright-native specs, use Playwright with the same reporter. `SPEC_FOLDER` is sufficient, or `playwright.config.ts` may pass `{ specFolder: '…' }` as the reporter option:

```bash
SPEC_FOLDER=$SPEC_FOLDER \
  npx playwright test {test-file} \
  --reporter={skills-root}/eque2-code-setup/scripts/scenario-state-reporter.mjs
```

Structural verification does NOT compare titles with the Gherkin step text. It checks that the evidence is signed, matches the file's source hash, and records a passing run (`exitCode` 0, every test `passed` or `skipped`, at least one `passed`), and that the file names the scenario — in its `verify-{FEATURE}-{ID}.spec.ts` name or a `[{ID}]` title tag. Whether the assertions prove the scenario is the semantic verifier's call.

If you see "evidence HMAC verification failed" or "source hash mismatch", re-run with the reporter attached to the native runner. Do not use a manual `update ... complete` fallback: scenario completion requires authentic evidence.

If you see "evidence records a failing run", the test failed: fix the code or the test and re-run. `verify` never completes a scenario on failing evidence.

If the reporter prints a WARNING that a `verify-*` file does not match the scenario id grammar, or that a scenario is registered to another file, it wrote NO evidence for that id. Fix the file name or run the registered file.

If a scenario reached `completed` on evidence that you now know is wrong, correct it with `node {STATE_CLI} $SPEC_FOLDER update {task_id} suspect --reason "<why>"`, re-run the test with the reporter, then run `verify {task_id}` again. `fail` is not legal from `completed`.

### 4. Write transcript

Write `{SPEC_FOLDER}/journal/transcripts/{task_id}-verify-{timestamp}.md` as the final action.

## Exit states

- On success: you called the state CLI's `verify` verb to consume the reporter's evidence.
- On failure: `update {task_id} fail` called via the state CLI.
