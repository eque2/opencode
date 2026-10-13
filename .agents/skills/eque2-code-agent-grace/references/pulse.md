---
name: pulse
description: Headless task routing for Grace's --headless invocations
---

**Language:** Use `{communication_language}` for all output.

# Pulse — Headless Task Routing

When Grace is invoked with `--headless` (with or without a named task), follow this routing. Do NOT load the greeting/menu flow. Do execute the named task, write results to the session log, and exit silently.

## Hard Rules (apply to every task below, and every subagent it dispatches)

1. **No Xray scripts.** All Xray access goes through the xray CLI (`node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs <verb>`) — never bespoke Xray shell/Node scripts, never direct API calls from prompts.
2. **No test generation without a passing Xray gate.** A test is only ever built from an existing Xray definition with `stepCount ≥ 1`. Gate fails → HARD STOP for that test: record it blocked and move on. Never invent steps, never scaffold a placeholder.
3. **Evidence is minted by the verifier.** The test-lifecycle verifier signs passing tests with HMAC evidence under the committed keyring. Verification dispatches as the NAMED `eque2-verifier` subagent. Neither you nor your subagents self-certify, and nobody touches evidence files or signing-key material (`state/integrity-key.json`, `.signer-key`, legacy `.evidence-key`).
4. **Mint-verb policy (incident CMC-32874).**
   **Clause A — never-probe:** Privileged verbs (`verdict`, `force-reset`, `verification-reset`) are never invoked to see what happens, to discover flags, or to test validation. Discovery is `--help` only. Sole exception: inside a disposable fixture repo under `EQUE2_TESTS_ADMIN=1` canary mode (the sanctioned test path this project's own suite uses).
   **Clause B — anti-reclassification:** Running a mint verb IS minting, whatever you call it — probe, test, dry run, experiment. There is no intent exception outside the sanctioned canary mode above; the CLI records the invocation as an attempt regardless of outcome.

Headless mode amplifies these — there's no human to catch a fabricated status. When in doubt, report less and mark it honestly.

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
   This prevents headless invocations from trashing a half-built sanctum or running against an undiscovered topology. **Exception:** `--headless:bootstrap` is the task that *creates* readiness, so it skips this gate entirely (see Bootstrap below).

2. **Stamp every output** — `ok`, `failed`, and `halted` JSON outputs all carry these fields in addition to task-specific fields:
   - `timestamp` — ISO-8601 of invocation start
   - `agent_version` — read from `bmad-manifest.json` (or `"unknown"` if unavailable)
   - `session_log` — path to the session log entry written for this run

## Exit-code convention (all headless tasks)

| Code | Meaning |
|---|---|
| 0 | `status: ok` — task completed successfully |
| 1 | `status: failed` — task ran but encountered a hard failure |
| 2 | `status: halted` — task refused to run (precondition not met: birth_incomplete, lifecycle_server_absent, xray_gate_failed, etc.) |

Cron / CI consumers can branch on exit code without parsing JSON. The JSON `status` field is authoritative within each code.

## Task Routing

| Invocation | Action |
|------------|--------|
| `--headless` (no task) | **Default wake** — see below |
| `--headless:status` | **Status scan** — see below |
| `--headless:fetch-tests <folder>` | **Headless [FT]** — see below |
| `--headless:build-test <XRAY-ID>` | **Headless [BT]** — see below |
| `--headless:backfill <folder>` | **Headless [BK]** — see below |
| `--headless:update-status` | **Headless [US]** — see below |
| `--headless:report` | **Headless [RP]** — see below |
| `--headless:bootstrap` | **Headless bootstrap (CI cold-start)** — see below |

Any other `--headless:<name>` is unknown — log to session and emit `{"status": "unknown_task", "task": "<name>"}` on stdout. `unknown_task` is a precondition failure, so it **exits 2** (halted), not 1 — a cron consumer can then tell "this task doesn't exist" apart from "the task ran and failed".

## Default Wake

When invoked with `--headless` alone:

1. Load sanctum (PERSONA, CREED, BOND, MEMORY, CAPABILITIES, PULSE). You need your full self, not just the bootloader — Pulse work is curation, which is identity work.
2. **Memory curation first.** Execute the "Memory Curation" section of PULSE.md — distil recent session logs into MEMORY.md, promote recurring test-knowledge patterns, prune what's stale (see `references/memory-guidance.md`).
3. **Then the lifecycle scan.** If the tests CLI is resolvable, run `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs summary` and collate states (pending / blocked / building / awaiting verification / needing fixes / verified / failed). If the CLI is **not resolvable**, log that the tests CLI isn't installed and skip the scan cleanly — record `"lifecycle_scan": "skipped_server_absent"` in the output. **Never fabricate lifecycle state.**
4. Execute the "Self-Improvement" section of PULSE.md.
5. Write a session log entry summarising what was done.
6. Update MEMORY.md if new patterns or blind spots were confirmed.
7. Update INDEX.md if any new organic files appeared.
8. Emit `{"status": "ok", "task": "default-wake", "memory_entries_curated": M, "lifecycle_scan": "ok" | "skipped_server_absent", "tests_scanned": N}` on stdout (`tests_scanned` omitted when the scan was skipped).
9. Exit 0 — an unresolvable tests CLI degrades the wake, it doesn't fail it.

## Status Scan

When invoked with `--headless:status`:

1. Load sanctum lite — PERSONA, CREED, MEMORY (skip BOND, CAPABILITIES, PULSE; not needed for a read-only scan).
2. If the tests CLI is not resolvable (e.g. `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs --help` fails, or the script file is missing), halt with `{"status": "halted", "task": "status", "reason": "lifecycle_server_absent", "detail": "Re-run /eque2-code-setup on an upgraded module."}` (exit 2). A status scan with no source of truth has nothing honest to say.
3. Run `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs summary` (and `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs query` for detail where the summary flags anomalies). Collate per lifecycle state: pending / blocked / building / awaiting_verification / needs_compliance_fix / needs_run_fix / verified_passing / failed.
4. Write a session log entry with the full collation.
5. If new blocked or failed tests appeared since the last scan (compare against the last scan's session log), note them in MEMORY.md under a "Backlog Watchlist" section.
6. Emit structured JSON on stdout:
   ```json
   {
     "status": "ok",
     "task": "status",
     "summary": {"pending": N, "blocked": B, "building": I, "awaiting_verification": A, "needs_fix": X, "verified_passing": V, "failed": F},
     "blocked_tests": ["PROJ-123", ...],
     "failed_tests": ["PROJ-456", ...]
   }
   ```
7. Exit 0.

Designed for monitoring / cron — parseable backlog health without a human in the loop.

## Headless [FT]

When invoked with `--headless:fetch-tests <folder>`:

1. Load sanctum lite (PERSONA, CREED — a fetch task doesn't need the full self).
2. Run pre-flight silently; halt with `{"status": "halted", "reason": "missing_xray_credentials"}` (exit 2) if `.env` lacks Xray credentials.
3. Invoke the `eque2-code-fetch-tests` skill (via the Skill tool) for `<folder>`, `interactive: false`. All Xray access through the xray CLI (Hard Rule 1). Definitions land under `XRAY_OUTPUT_DIR`.
4. On ok:
   ```json
   {
     "status": "ok",
     "task": "fetch-tests",
     "folder": "<folder>",
     "output_dir": "<XRAY_OUTPUT_DIR>",
     "definitions_fetched": N,
     "definitions_without_steps": Z
   }
   ```
   `definitions_without_steps` matters — those tests will hard-stop at the gate in any later [BT]/[BK]; surfacing the count here lets a consumer see the blockage before spending build tokens.
5. On failure: structured JSON with `status: "failed"`, the failing stage, and the categorised reason. Append session log entry, exit 1.

Use this to refresh a folder's definitions before a scheduled backfill, or as a CI step that materialises the backlog into the repo.

## Headless [BT]

When invoked with `--headless:build-test <XRAY-ID>`:

1. Load full sanctum + run pre-flight silently (Xray credentials and topology config are blockers here — a build with no `BASE_URL` or `TEST_CODE_DIR` has nowhere to explore and nowhere to land).
2. **Run the Xray gate first (Hard Rule 2).** Fetch the definition for `<XRAY-ID>` via the xray CLI (`node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs test --testId=<ID>`). If no definition exists or `stepCount == 0`, HARD STOP: record the test blocked (via the tests CLI when available), halt with `{"status": "halted", "task": "build-test", "xray_id": "<ID>", "reason": "xray_gate_failed", "detail": "No definition or zero steps — nothing to build from."}` (exit 2). No generation is attempted.
3. Invoke the `eque2-code-e2e-test` skill (via the Skill tool) with the Xray test ID, `interactive: false`, engine depth from config. It explores the live UI, maps each Xray step to a `test.step()`, verifies green, and commits to the topology-configured target repo.
4. Verification is the server's call, not yours (Hard Rule 3): the result you report is the lifecycle/verifier outcome, never a self-assessment.
5. On ok, emit `{"status": "ok", "task": "build-test", "xray_id": "<ID>", "test_file": "<path>", "steps": N, "verified": true, "committed": true}`. On failure (test won't go green after capped retries) emit `status: "failed"` with the failing stage. Exit 0 / 1.

## Headless [BK]

When invoked with `--headless:backfill <folder>`:

1. Load full sanctum + run pre-flight silently.
2. Run the **Pre-[BK] Viability Gate** (`references/workflow-dispatch.md`): Xray credentials present, topology configured, tests CLI reachable. In headless, any miss halts with `{"status": "halted", "task": "backfill", "reason": "viability_gate", "detail": "<which check failed>"}` (exit 2) — a batch with a missing precondition fails fifty times, not once.
3. Invoke the `eque2-code-backfill` skill (via the Skill tool) for `<folder>`, `interactive: false`. It seeds the lifecycle state from the folder's definitions, fans out up to `{agent.batch_concurrency}` build subagents through the shared E2E pipeline, lets the verifier mint evidence server-side, polls `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs transitions-since` on the configured interval, parks stalls, and reports. **If loop state from a previous run exists (heartbeat, seen-history, parked-tasks), the run resumes rather than restarting** — completed tests are not rebuilt.
4. Every subagent re-runs the Xray gate for its own test (Hard Rule 2): a definition with zero steps is marked blocked and skipped; the batch continues with the rest. Subagents operate under the Subagent Discipline below, without exception.
5. On completion, emit the batch summary:
   ```json
   {
     "status": "ok" | "failed",
     "task": "backfill",
     "folder": "<folder>",
     "resumed": true | false,
     "totals": {"seeded": N, "verified_passing": V, "blocked": B, "parked": P, "failed": F},
     "parked_tests": ["PROJ-123", ...],
     "next_step": "update-status"
   }
   ```
   `status` is `ok` when the batch ran to completion — individual blocked/failed tests are honest line items, not a batch failure. `failed` is reserved for the orchestration itself breaking (server lost mid-run, loop state corrupt, parked count exceeding `max_parked_tasks` with nothing progressing).
6. Append a session log entry with the full picture regardless of outcome. Exit 0 / 1.

## Headless [US]

When invoked with `--headless:update-status`:

1. Load sanctum lite + pre-flight silently.
2. If the tests CLI is not resolvable, or the Xray write-back verb is not present on the xray CLI, halt with `{"status": "halted", "task": "update-status", "reason": "lifecycle_server_absent" | "xray_writeback_absent"}` (exit 2) — there is either nothing trustworthy to sync from, or no sanctioned way to sync it (Hard Rule 1: the write-back is a CLI verb, never a bespoke script).
3. Invoke the `eque2-code-update-status` skill (via the Skill tool), `interactive: false`. Only **verifier-signed** results are synced — a test without server-minted evidence is not "passing" anywhere, including Xray (Hard Rule 3).
4. On ok, emit `{"status": "ok", "task": "update-status", "synced": N, "skipped_unverified": M}`. On failure emit `status: "failed"`. Exit 0 / 1.

## Headless [RP]

When invoked with `--headless:report`:

1. Load sanctum lite + pre-flight silently.
2. If the tests CLI is not resolvable, halt with `{"status": "halted", "task": "report", "reason": "lifecycle_server_absent"}` (exit 2) — never report fabricated coverage.
3. Invoke the `eque2-code-test-report` skill (via the Skill tool), `interactive: false`, **without** evidence attachment (attachment is an interactive choice; headless produces the report only).
4. On ok, emit `{"status": "ok", "task": "report", "report_file": "<path>", "coverage": {"verified": V, "total": T}}`. On failure emit `status: "failed"`. Exit 0 / 1.

## Headless bootstrap

When invoked with `--headless:bootstrap` (CI cold-start — **skips the readiness gate** because it is what establishes readiness):

1. Run `uv run {skill-root}/scripts/init-sanctum.py {project-root} {skill-root} --bootstrap`. This scaffolds the sanctum if absent and flips `birth_status` to `complete` with `bootstrapped: true`. If the sanctum already exists, init-sanctum is a no-op and bootstrap reports it as already present.
2. Do **not** run a First Breath conversation — there's no human. The BOND/PERSONA seeds stay at template level; `bootstrapped: true` is the breadcrumb that a human still owes First Breath enrichment. In particular, **topology is not discovered by bootstrap** — `BASE_URL`/`TEST_CODE_DIR` must already be in `.env` (e.g. set by the CI pipeline) or subsequent build tasks will halt at pre-flight.
3. Emit `{"status": "ok", "task": "bootstrap", "sanctum_path": "<path>", "scaffolded": true|false, "bootstrapped": true, "note": "Seeds are template-level; run interactively to personalise and confirm topology."}`. Exit 0.

Use this as the first step of a CI pipeline so subsequent `--headless:backfill` / `--headless:build-test` calls clear the readiness gate. A bootstrapped Grace is functionally correct but generically calibrated — schedule a real First Breath when a human is available.

## Idempotency & re-entrancy (retried headless runs)

CI retries a transient failure by re-invoking the same task. Each headless task must be safe to re-run:

- **`[FT]`** — re-fetch overwrites the folder's definitions under `XRAY_OUTPUT_DIR` in place; safe to repeat.
- **`[BT]`** — if a verifier-signed test already exists for the Xray ID, report `ok` with `"already_present": true` rather than regenerating. The Xray gate re-runs regardless — freshness is decided per run.
- **`[BK]`** — resumable by construction: loop state (heartbeat, seen-history, parked-tasks) persists across sessions, and the tests CLI's state is the single source of per-test truth. A retry continues the batch; verified tests are never rebuilt.
- **`[US]`** — sync is reconciliation, not append: a retry re-confirms statuses already synced rather than duplicating updates.
- **`[RP]`** — read-only over the tests CLI's state; trivially repeatable.
- **`bootstrap`** — idempotent by construction (init-sanctum is detect-and-skip).

Tasks that mutate a working tree (`[BT]`, the build subagents inside `[BK]`) must check for their own prior partial output before acting, so a retry after a mid-run crash does not double-apply.

## Subagent Discipline (All Headless Tasks)

Per the global Subagent Circuit Breaker (see `{project-root}/.claude/CLAUDE.md`):

- Maximum 3 fix-and-retry iterations per single issue
- Bash timeout never exceeds 180000ms (3 minutes) per command
- Kill any command producing zero output for >120 seconds
- Poll background subagents every 10 minutes; kill on two consecutive stalls (~20 minutes) — for [BK], stalled tests are parked via the tests CLI, not silently dropped
- Never read, modify, or fabricate evidence files, and never read signing-key material (`state/integrity-key.json`, `.signer-key`, legacy `.evidence-key`)

These are hard constraints. Headless mode amplifies the cost of misbehaving subagents because there's no human to interrupt — and [BK] multiplies that by `{agent.batch_concurrency}`. Discipline matters more, not less.

## Logging

Headless mode writes everything to `{sanctum}/sessions/YYYY-MM-DD.md` and reserves stdout for structured JSON. Diagnostic output goes to stderr. Cron/CI consumers can parse stdout safely without grepping through narrative.
