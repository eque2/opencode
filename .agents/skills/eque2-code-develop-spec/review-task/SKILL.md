---
name: review-task
description: Adversarial code review for a just-completed task — finds and AUTO-FIXES issues. Dispatched by the DS orchestrator for action=review.
---

# Review Task

Perform an adversarial code review of a just-completed task. Find real issues, fix them automatically, commit the fixes separately. If the spec references Figma data, also dispatch `figma-compliance-review/SKILL.md`.

**Adversarial mindset** — "Looks good" is never acceptable. Find 3–10 specific issues.

## Input parameters

- `task_id` — actor ID of the completed task (e.g. `task/T1.2`)
- `action` — always `"review"`
- `context_info` — snapshot context from `node {STATE_CLI} $SPEC_FOLDER next`
- `SPEC_FOLDER` — absolute path to the feature folder

## Critical rules

1. **Minimum 3 issues** — find them. There are always bugs.
2. **Auto-fix everything** — no asking for permission.
3. **Separate commit** — review fixes in their own commit, not mixed with implementation.
4. **No user interaction** — fully autonomous.
5. **State via the CLI only** — never edit state files directly.

## Execution

### 1. Gather context

a) Run `node {STATE_CLI} $SPEC_FOLDER update task/{task_id} start --reason "Beginning review"`.

b) Run `node {STATE_CLI} $SPEC_FOLDER query task/{task_id}` for task details. Parse `context_info` for files created/modified. If absent, discover from `git diff --name-only HEAD~1`.

c) Read journal entry `{SPEC_FOLDER}/journal/task/{task_id}.md` for implementation notes.

d) Build file list (source > tests > config). Exclude generated files and lockfiles.

e) Load project standards from `project-context.md` and `CLAUDE.md`.

### 2. Deep code review

For each file:

- **Security (CRITICAL):** injection, XSS, missing validation, hardcoded secrets, auth bypasses
- **Correctness (HIGH):** logic errors, null handling, race conditions, missing error handling
- **Quality (MEDIUM):** functions >50 lines, nesting >3 levels, magic numbers, poor naming, missing types
- **Tests (HIGH):** missing tests, meaningless assertions, missing edge cases
- **Architecture (MEDIUM):** pattern violations (check `.ai/Code Reviews/review-rules/`), tight coupling, wrong layer

If fewer than 3 issues found: re-examine error handling, edge cases, validation, types, performance.

### 3. Figma compliance (conditional)

If `{SPEC_FOLDER}/spec.md` references Figma data paths, load and execute `figma-compliance-review/SKILL.md`. Pass `spec_folder`, `task_id`, `task_description`, `files_changed`, `slug`.

### 4. Fix all issues

Fix everything possible: add validation, fix null checks and error handling, extract functions, add types, write missing tests, move code to correct layer. Run lint and tests after fixing.

### 5. Commit and complete

a) Stage and commit review fixes separately: follow discovered commit convention. Example prefix: `fix(review): {task_id} — address code review issues`.

b) Write or append to `{SPEC_FOLDER}/journal/task/{task_id}.md`.

c) Run `node {STATE_CLI} $SPEC_FOLDER update task/{task_id} complete --reason "Review complete — {N} issues found, {M} fixed"`. This triggers structural verification — the task only advances if it passes. If the response has `success: false` (a side effect of type `completion-verification-failed` carries the reason), the task is NOT complete: fix what the reason names, then call `complete` again. Do NOT fall back to `fail` for a failed verification.

d) Write transcript to `{SPEC_FOLDER}/journal/transcripts/{task_id}-review-{timestamp}.md`.

## Exit states

- Completed: `update ... complete` called and structural verification passed (response `success: true`).
- Failed: `update ... fail` called with reason (e.g. critical unfixable issues blocking the spec) — only for a genuine work failure, never for a failed verification (retry `complete` after fixing instead).
