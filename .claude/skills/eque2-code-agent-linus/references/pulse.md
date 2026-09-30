---
name: pulse
description: Headless task routing for Linus's --headless invocations
---

**Language:** Use `{communication_language}` for all output.

# Pulse — Headless Task Routing

When Linus is invoked with `--headless` (with or without a named task), follow this routing. Do NOT load config-greeting-menu. Do execute the named task, write results to the session log, and exit silently.

## Universal headless preamble — applies to ALL tasks

Before routing to any specific task, every headless invocation must:

1. **Gate on sanctum readiness (deterministic).** Run `uv run {skill-root}/scripts/sanctum-status.py --project-root {project-root}` and read its JSON. If `present` is false or `birth_status` is anything other than `complete`, halt immediately with `status: halted` (exit 2):
   ```json
   {
     "status": "halted",
     "task": "<requested>",
     "reason": "birth_incomplete",
     "detail": "Sanctum absent or First Breath not complete. Run interactively, or cold-start CI with --headless:bootstrap."
   }
   ```
   This prevents headless invocations from trashing a half-built sanctum or running with incomplete owner context. **Exception:** `--headless:bootstrap` is the task that *creates* readiness, so it skips this gate entirely (see Bootstrap below).

2. **Stamp every output** — `ok`, `failed`, and `halted` JSON outputs all carry these fields in addition to task-specific fields:
   - `timestamp` — ISO-8601 of invocation start
   - `agent_version` — read from `bmad-manifest.json` (or `"unknown"` if unavailable)
   - `session_log` — path to the session log entry written for this run

   **Don't hand-assemble this.** Use the deterministic stamper so the envelope contract and exit codes can't drift:
   ```bash
   uv run {skill-root}/scripts/headless-envelope.py \
     --task <task> --status <ok|failed|halted> \
     --extra '<task-specific JSON object>' \
     --manifest {skill-root}/bmad-manifest.json \
     --session-dir {sanctum}/sessions
   ```
   It stamps `timestamp` + `agent_version` + `session_log`, merges your task payload (payload keys can't clobber `status`/`task`/stamps), prints the final JSON to stdout, and **exits with the matching code** (0/1/2). Pass the task-specific fields shown in each section below via `--extra`; let the script own the three stamps and the exit code.

## Exit-code convention (all headless tasks)

| Code | Meaning |
|---|---|
| 0 | `status: ok` — task completed successfully |
| 1 | `status: failed` — task ran but encountered a hard failure |
| 2 | `status: halted` — task refused to run (precondition not met: birth_incomplete, no_confirm, etc.) |

Cron / CI consumers can branch on exit code without parsing JSON. The JSON `status` field is authoritative within each code.

## Task Routing

| Invocation | Action |
|------------|--------|
| `--headless` (no task) | **Default wake** — see below |
| `--headless:status` | **Status scan** — see below |
| `--headless:create-spec <TICKET-KEY>` | **Headless [CS]** — see below |
| `--headless:jira-fetch <TICKET-KEY>` | **Headless [JF]** — see below |
| `--headless:create-spec-from-prose <file>` | **Headless [CS] from prose** — see below |
| `--headless:re-spec <FEATURE-ID>` | **Headless [RS]** — see below |
| `--headless:develop-spec <SPEC-SLUG>` | **Headless [DS]** — see below |
| `--headless:e2e-test <SPEC-SLUG>` | **Headless [ET]** — see below |
| `--headless:bug-fix <TICKET-KEY\|file>` | **Headless [BF]** — see below |
| `--headless:create-pr [handoff-file]` | **Headless [PR]** — see below |
| `--headless:ship <SPEC-SLUG>` | **Headless ship (DS→ET→PR chain)** — see below |
| `--headless:bootstrap` | **Headless bootstrap (CI cold-start)** — see below |
| `--headless:re-validate <FEATURE-ID>` | **Headless re-validate** — see below |
| `--headless:health` | **Health diagnostic** — see below |

Any other `--headless:<name>` is unknown — log to session and emit `{"status": "unknown_task", "task": "<name>"}` on stdout. `unknown_task` is a precondition failure, so it **exits 2** (halted), not 1 — a cron consumer can then tell "this task doesn't exist" apart from "the task ran and failed".

## Default Wake

When invoked with `--headless` alone:

1. Load sanctum (PERSONA, CREED, BOND, MEMORY, CAPABILITIES, PULSE). You need your full self, not just the bootloader — Pulse work is curation, which is identity work.
2. Execute the "Memory Curation" section of PULSE.md.
3. Execute the "Feature State Scan" section of PULSE.md.
4. Execute the "Self-Improvement" section of PULSE.md.
5. Write a session log entry summarising what was done.
6. Update MEMORY.md if new patterns or blind spots were confirmed.
7. Update INDEX.md if any new organic files appeared.
8. Emit `{"status": "ok", "task": "default-wake", "features_scanned": N, "memory_entries_curated": M}` on stdout.
9. Exit 0.

## Status Scan

When invoked with `--headless:status`:

1. Load sanctum lite — PERSONA, CREED, MEMORY (skip BOND, CAPABILITIES, PULSE; not needed for a read-only scan).
2. For each feature directory in `{feature_artifacts}/`, run `node {STATE_CLI} {feature_artifacts}/{feature-dir} status`. The CLI prints a JSON envelope on stdout; consume `result.status` and any per-task/scenario detail.
3. Collate: in-progress / done / stalled (no progress in 7+ days) / failed (any state with `status=failed`).
4. Write a session log entry with the full collation.
5. If new stalls or failures appeared since last scan (compare against last scan's session log), note them in MEMORY.md under a "Stalled Features" section.
6. Emit structured JSON on stdout:
   ```json
   {
     "status": "ok",
     "task": "status",
     "summary": {"in_progress": N, "done": M, "stalled": S, "failed": F},
     "stalled_features": ["PROJ-123", ...],
     "failed_features": ["PROJ-456", ...]
   }
   ```
7. Exit 0.

## Headless [CS]

When invoked with `--headless:create-spec <TICKET-KEY>`:

1. Load full sanctum + run pre-flight checks (silently — auto-bootstrap if Check 5 trips; halt with structured JSON if Check 1 trips).
1.5. Run the **Pre-[CS] Dispatch Checks** (`references/workflow-dispatch.md`): existing-folder collision (halt with `{"status": "halted", "reason": "feature_exists"}`, exit 2, rather than clobbering unattended) and input viability (never block — proceed and carry `viability: "ok"|"thin"` into the result JSON).
2. Invoke the `eque2-code-create-spec` skill (via the Skill tool) with:
   - `mode: default` (end-to-end, no checkpoint menus)
   - `ticket_key: <TICKET-KEY>`
   - `interactive: false`
   - `subagent_warning_acknowledged: true` (the headless invocation is the acknowledgment)
3. The workflow runs all auto-invocations (Party Mode, edge-case-hunter, adversarial-general, checklist) unless suppressed by additional flags passed alongside `--headless:create-spec` (e.g. `--no-party`).
4. On `cs-generate-definitions.py` returning `status: ok`, emit:
   ```json
   {
     "status": "ok",
     "task": "create-spec",
     "ticket_key": "<KEY>",
     "feature_artifacts": "<path>",
     "stages_completed": 10,
     "definitions": {"path": "<feature_root>/definitions.json", "counts": {"parentTasks": N, "tasks": M, "scenarios": K, "buildChecks": J}},
     "subagents_invoked": ["bmad-party-mode", "bmad-review", "bmad-review"],
     "catches_surfaced": [<entries from .catches.json>],
     "test_dir": "<TEST_DIR>",
     "viability": "ok",
     "timestamp": "<ISO-8601>",
     "agent_version": "<from manifest>",
     "session_log": "<path>"
   }
   ```
   Match the shape Stage 10 of [CS] emits — these two must stay in lockstep. The `catches_surfaced` array comes from `{feature_root}/.catches.json` entries; if the file is absent or malformed, emit `[]` rather than failing.
5. On any hard failure (blocker pre-flight, definitions generator returned `status: failed` after retries, subagent stall, etc.), emit:
   ```json
   {
     "status": "failed",
     "task": "create-spec",
     "ticket_key": "<KEY>",
     "stage": "<stage name>",
     "reason": "<one-line reason>",
     "session_log": "<path to session log entry>"
   }
   ```
6. Append a session log entry with full context regardless of outcome.
7. Exit 0 on ok, 1 on failed.

## Headless [JF]

When invoked with `--headless:jira-fetch <TICKET-KEY>`:

1. Load sanctum lite (PERSONA, CREED — no need for BOND/CAPABILITIES/PULSE for a fetch task).
2. Run pre-flight check 1 silently (`.env` has Jira credentials). Halt with `{"status": "failed", "reason": "missing_credentials"}` if absent.
3. Invoke the `eque2-code-jira-fetch` skill (via the Skill tool) and execute end-to-end for `<TICKET-KEY>`.
4. On ok:
   ```json
   {
     "status": "ok",
     "task": "jira-fetch",
     "ticket_key": "<KEY>",
     "feature_artifacts": "{feature_artifacts}/<KEY>/",
     "jira_dir": "{feature_artifacts}/<KEY>/jira/",
     "figma_designs": N,
     "related_tickets": M
   }
   ```
5. On failure: structured JSON with `status: "failed"`, the failing stage, and the categorised reason. Append session log entry, exit non-zero.

Use this to refresh a ticket folder before `[RS]` re-spec, or as a CI step that materialises ticket data into the repo.

## Headless [CS] from prose

When invoked with `--headless:create-spec-from-prose <file>`:

1. Load sanctum.
2. Run pre-flight.
3. Read `<file>` (must contain problem statement, scope, verification intent — same shape `[CS]` Stage 2 elicits in interactive spec mode).
4. Synthesise a `{FEATURE-ID}` from the file path (or accept an explicit `--feature-id <ID>` flag).
5. Invoke the `eque2-code-create-spec` skill (via the Skill tool) and execute end-to-end in spec mode with `prose_input: <file path>`.
6. On ok: same shape as `--headless:create-spec`. On failure: same.

Use this for spec'ing features that have no Jira ticket yet (research spikes, infrastructure work, exploratory builds).

## Headless [RS]

When invoked with `--headless:re-spec <FEATURE-ID>`:

This is the unattended remedy for a `feature_exists` collision — the path a cron consumer is pointed at when `--headless:create-spec` finds an existing spec and the requirements have actually changed. Unlike `--headless:re-validate` (which only re-checks the *existing* spec), this **archives the current spec and produces a fresh one with the prior context carried forward**.

1. Load full sanctum + run pre-flight silently.
2. Check `{feature_artifacts}/{FEATURE-ID}/` exists and contains a spec. If absent, halt with `{"status": "halted", "task": "re-spec", "reason": "feature_not_found", "detail": "Nothing to re-spec — use --headless:create-spec."}` (exit 2).
3. Invoke the `eque2-code-re-spec` skill (via the Skill tool) with `feature_id: <FEATURE-ID>`, `interactive: false`. It archives the existing spec, carries context forward, and chains into `eque2-code-create-spec` to produce the new one.
4. On ok, emit the same shape as `--headless:create-spec` (it ends at a fresh `definitions.json`), plus `"archived_from": "<archive path>"`. On hard failure emit `status: "failed"` with the failing stage.
5. Append a session log entry regardless of outcome. Exit 0 on ok, 1 on failed, 2 on a halted precondition.

## Headless [DS]

When invoked with `--headless:develop-spec <SPEC-SLUG>`:

1. Load full sanctum + run pre-flight silently.
2. Confirm `{feature_artifacts}/{SPEC-SLUG}/definitions.json` exists — DS consumes a spec that reached [CS] Stage 10. If absent, halt with `{"status": "halted", "task": "develop-spec", "reason": "no_definitions", "detail": "Run [CS] first."}` (exit 2).
3. Invoke the `eque2-code-develop-spec` skill (via the Skill tool) with `spec_slug: <SPEC-SLUG>`, `interactive: false`. It initialises state, builds tasks, reviews, verifies scenarios, and runs Figma compliance.
4. **Poll to a terminal verdict before returning (CAP-4 — do NOT end the session mid-verify).** Orchestrator-spawned verify subagents promote `verified → trusted` asynchronously over successive reconcile passes (see `eque2-code-develop-spec/references/execute.md` step 2d and `circuit-breaker.md`); the build skill returning does NOT mean the trust backlog is drained. Before emitting any exit envelope, **loop**: run `node {STATE_CLI} {feature_artifacts}/{SPEC-SLUG} status`; if it reports a terminal machine state (all actors `trusted`/terminal → `done`-eligible) **or** a surfaced honest failure (`stalled: true`, a circuit-breaker kill journal entry, or a failed gate), stop and emit; otherwise `sleep {EQUE2_DS_POLL_SECONDS:-60}` and poll again. Bound the loop by `{EQUE2_DS_POLL_MAX_SECONDS:-7200}` wall-clock: on exhaustion emit an **honest** `status: "failed"` envelope (`reason: "verify_backlog_not_drained"`, include the residual `pending_review`/`verified`-not-`trusted` counts) — never a false `ok`. Do not return an `ok` envelope while the verifier backlog is non-empty.
5. On ok (poll reached terminal, backlog drained), emit `{"status": "ok", "task": "develop-spec", "spec_slug": "<SLUG>", "tasks_done": N, "scenarios_verified": K, "ready_for_pr": true}`. On hard failure (build/review/verify gate fails after capped retries, or the poll bound is exhausted), emit `status: "failed"` with the failing stage. Exit 0 / 1.

> **Harness-bounded residual (CAP-4 / D12).** This contract makes the *agent* hold the session to a terminal verdict — the part eque2-code owns. It cannot override the Claude Code harness's own turn limits: a `claude -p` run that hits max-turns / quota / a context limit **mid-poll** still terminates the turn before reaching a `done`-eligible state, emitting whatever envelope it can. That boundary is a harness concern eque2-code does not own; see `_bmad-output/planning-artifacts/followups.md`. Operators drive long headless `[DS]` runs under an external resume/poll wrapper (`epic-driver.sh`) until the harness itself can hold a turn across a minutes-to-hours async drain.

## Headless [ET]

When invoked with `--headless:e2e-test <SPEC-SLUG>`:

1. Load sanctum + pre-flight silently.
2. **HARD STOP if no Xray definition** exists for the built change (the xray CLI resolves the definition for the spec's ticket) — ET is gated on it. Halt with `{"status": "halted", "task": "e2e-test", "reason": "no_xray_definition"}` (exit 2). Also halt if the spec is not Jira-sourced (`reason": "not_jira_sourced"`).
3. Invoke the `eque2-code-e2e-test` skill with `spec_slug: <SPEC-SLUG>`, `interactive: false`. It explores the live UI, maps each Xray step to a `test.step()`, verifies green, and commits.
4. On ok, emit `{"status": "ok", "task": "e2e-test", "spec_slug": "<SLUG>", "test_file": "<path>", "steps": N, "committed": true}`. On failure (test won't go green after capped retries) emit `status: "failed"`. Exit 0 / 1.

## Headless [BF]

When invoked with `--headless:bug-fix <TICKET-KEY|file>`:

1. Load sanctum + pre-flight silently. Classify the arg per *Fast-Invoke Arg Disambiguation* in `references/workflow-dispatch.md` (Jira key vs file path).
2. Invoke the `eque2-code-bug-fix` skill with the classified input, `interactive: false`. It reproduces test-first, writes a failing test, fixes, and confirms the suite stays green. **Stops before commit/push** — headless BF does not ship.
3. On ok, emit `{"status": "ok", "task": "bug-fix", "input": "<key-or-path>", "repro_test": "<path>", "suite_green": true, "committed": false}`. On failure emit `status: "failed"`. Exit 0 / 1.

## Headless [PR]

When invoked with `--headless:create-pr [handoff-file]`:

1. Load sanctum + pre-flight silently. If a handoff file (e.g. a `bug-fix.md`) is given, read it to seed the PR body.
2. Invoke the `eque2-code-create-pr` skill with `interactive: false`. It enforces the repo's review-rules on the diff (no correctness review — that's done upstream in [BF]/[DS]), confirms the suite is green, syncs with the base branch, commits, pushes, and opens the PR. **Stops at an open PR — never merges.**
3. On ok, emit `{"status": "ok", "task": "create-pr", "pr_url": "<url>", "base": "<branch>", "suite_green": true}`. If there are no working-tree changes to ship, halt with `{"status": "halted", "reason": "no_changes"}` (exit 2). On failure (review blocker, suite red, push rejected) emit `status: "failed"`. Exit 0 / 1.

## Headless ship

When invoked with `--headless:ship <SPEC-SLUG>` (optionally `--until:<stage>`):

The build-half pipeline as one chain — `[DS] → [ET] → [PR]`. Run each stage as its headless task above, in order, **stopping at the first non-`ok` stage**. `[ET]` is skipped (not failed) when the spec is not Jira-sourced or has no Xray definition — record `"skipped": "no_xray_definition"` and continue to `[PR]`.

**Stop-before control (`--until:<stage>`).** A consumer that wants the chain to halt *before* a stage passes `--until:<stage>` where `<stage>` is one of `e2e-test` or `create-pr` (the natural stop points). Run the chain normally but stop cleanly once the named stage is reached without executing it — e.g. `--until:create-pr` runs `[DS]` (and `[ET]` if applicable) then stops with the working tree built and tested but no PR opened. Report `"stopped_before": "<stage>"` and `status: "ok"` (a requested stop is success, not failure); exit 0. Without `--until`, the chain runs through to an open PR as before.

Emit a chain summary:
```json
{
  "status": "ok" | "failed" | "halted",
  "task": "ship",
  "spec_slug": "<SLUG>",
  "stages": [
    {"task": "develop-spec", "status": "ok", "ready_for_pr": true},
    {"task": "e2e-test", "status": "ok", "test_file": "<path>"},
    {"task": "create-pr", "status": "ok", "pr_url": "<url>"}
  ],
  "stopped_at": null
}
```
`status` is the worst stage outcome; `stopped_at` names the stage that broke the chain (or `null` if it reached an open PR). Exit 0 if the chain reached an open PR, 1 on a `failed` stage, 2 on a `halted` precondition.

## Headless bootstrap

When invoked with `--headless:bootstrap` (CI cold-start — **skips the readiness gate** because it is what establishes readiness):

1. Run `uv run {skill-root}/scripts/init-sanctum.py {project-root} {skill-root} --bootstrap`. This scaffolds the sanctum if absent and flips `birth_status` to `complete` with `bootstrapped: true`. If the sanctum already exists, init-sanctum is a no-op and bootstrap reports it as already present.
2. Do **not** run a First Breath conversation — there's no human. The BOND/PERSONA seeds stay at template level; `bootstrapped: true` is the breadcrumb that a human still owes First Breath enrichment.
3. Emit `{"status": "ok", "task": "bootstrap", "sanctum_path": "<path>", "scaffolded": true|false, "bootstrapped": true, "note": "Seeds are template-level; run interactively to personalise."}`. Exit 0.

Use this as the first step of a CI pipeline so subsequent `--headless:create-spec` / `--headless:ship` calls clear the readiness gate. A bootstrapped Linus is functionally correct but generically calibrated — schedule a real First Breath when a human is available.

## Idempotency & re-entrancy (retried headless runs)

CI retries a transient failure by re-invoking the same task. Each headless task must be safe to re-run:

- **`[JF]`** — re-fetch overwrites `{feature_artifacts}/{KEY}/jira/` in place; safe to repeat.
- **`[CS]` / `[CS] from prose`** — [CS] resumes from `stepsCompleted` (composable stages, each writing a discrete artifact), so a retry continues rather than restarting. A retry that finds an existing **complete** spec folder re-validates instead of re-running the expensive subagents (it does not silently clobber — see the existing-folder collision check in `references/workflow-dispatch.md`). A retry mid-pipeline picks up at the first incomplete stage.
- **`[RS]`** — archive-then-re-spec. A retry after the archive step already ran finds the prior spec already moved aside; it must not double-archive (an empty/missing live spec means the archive already happened — continue into the fresh [CS] rather than halting `feature_not_found`).
- **`[DS]`** — state lives in the signed plaintext event log the state CLI is the sole interface to; re-invoking runs `node {STATE_CLI} $SPEC_FOLDER next` and continues from the current state. Completed tasks are not redone.
- **`[ET]`** — if the test file already exists and is green, report `ok` with `"already_present": true` rather than regenerating.
- **`[PR]`** — if an open PR already exists for the branch, report `ok` with the existing `pr_url` rather than opening a duplicate.
- **`bootstrap`** — idempotent by construction (init-sanctum is detect-and-skip).

Tasks that mutate the working tree (`[BF]`, `[PR]`) must check for their own prior partial output before acting, so a retry after a mid-run crash does not double-apply.

## Headless re-validate

When invoked with `--headless:re-validate <FEATURE-ID>`:

1. Load sanctum lite.
2. Check `{feature_artifacts}/{FEATURE-ID}/` exists and contains `spec.md`, `tasks.md`, `scenarios.gherkin`. If not, halt with `{"status": "failed", "reason": "feature_not_found"}`.
3. Run `cs-readiness-check.py {feature_artifacts}/{FEATURE-ID}` and capture findings.
4. **Check `definitions.json` exists.** If absent, halt with `{"status": "failed", "reason": "no_definitions", "detail": "definitions.json missing — spec has not reached Stage 10. Run [CS] first."}`. Do NOT return `ready_for_build: true` for a spec that never reached Stage 10.
5. Re-run `uv run scripts/cs-generate-definitions.py {feature_artifacts}/{FEATURE-ID} --test-dir-from-context` and capture `status` + `errors`. The script is deterministic; this confirms the current spec content still produces a clean definitions file.
6. Output:
   ```json
   {
     "status": "ok" | "failed",
     "task": "re-validate",
     "feature_id": "<KEY>",
     "readiness_check": {"status": "...", "failures": [...]},
     "definitions": {"status": "ok|failed", "errors": [...]},
     "ready_for_build": true | false
   }
   ```
7. Exit 0 if readiness passes AND definitions generation returns `ok`. Exit 1 otherwise.

Use this after manual edits to a finalised spec to confirm the structural gate still passes — cheap re-check without re-running expensive subagents.

## Headless health

When invoked with `--headless:health`:

1. Load sanctum index only (don't batch-load all sanctum files).
2. Run pre-flight checks (all 6). Capture pass/warn/blocker per check.
3. Confirm sanctum readiness deterministically: `uv run {skill-root}/scripts/sanctum-status.py --project-root {project-root}` — fold its `present`, `files_missing`, `files_complete`, `birth_status`, `birth_stale`, and `unresolved_vars_total` straight into the `sanctum` block below.
4. Per-feature state scan via `node {STATE_CLI} {feature_artifacts}/{feature-dir} status` across `{feature_artifacts}/`. Capture: in-progress / done / stalled / failed counts.
5. Output:
   ```json
   {
     "status": "ok" | "degraded" | "failed",
     "task": "health",
     "preflight": [{"check": "...", "status": "pass|warn|blocker", "detail": "..."}, ...],
     "sanctum": {"present": true, "files_complete": true, "files_missing": [], "birth_status": "complete", "birth_stale": false},
     "features": {"in_progress": N, "done": M, "stalled": S, "failed": F},
     "blockers": [...]
   }
   ```
6. Exit 0 on `ok`, 1 on `degraded` (warnings only, nothing actionable now), 2 on `failed` (blockers present, action needed).

Designed for monitoring / cron — parseable status without a human in the loop.

## Subagent Discipline (All Headless Tasks)

Per the global Subagent Circuit Breaker (see `{project-root}/.claude/CLAUDE.md`):

- Maximum 3 fix-and-retry iterations per single issue
- Bash timeout never exceeds 180000ms (3 minutes) per command
- Kill any command producing zero output for >120 seconds
- Poll background subagents every 10 minutes; kill on two consecutive stalls (~20 minutes)
- Never read, modify, or fabricate evidence files, and never read signing-key material (`state/integrity-key.json` — committed by design, still off-limits —, `.signer-key`, or a legacy `.evidence-key`)

These are hard constraints. Headless mode amplifies the cost of misbehaving subagents because there's no human to interrupt — discipline matters more, not less.

## Logging

Headless mode writes everything to `{sanctum}/sessions/YYYY-MM-DD.md` and reserves stdout for structured JSON. Diagnostic output goes to stderr. Cron/CI consumers can parse stdout safely without grepping through narrative.
