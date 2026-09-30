Language: {communication_language}

# Stage 3: Poll and Recover

**Progress: Stage 3 of 4** — The parent loop: observe, refill, park, recover.

Outcome: every worklist test reaches a terminal lifecycle state (`verified_passing`, `failed`, `blocked`) or is honestly accounted for (timed out, parked then reaped, lost to restart) — with the loop's own state persisted to disk after every meaningful change, so a session restart resumes instead of losing the run.

All loop state lives in `{project-root}/_bmad-output/test-artifacts/backfill/` and is read/written **only** through `scripts/backfill-state.py` (atomic writes; safe against concurrent readers). The lifecycle server's own state directory and evidence store are off-limits — deny rules enforce this; the loop observes the server through its verbs, never its files.

## The poll cycle

Run one sequential cycle every `{batch_poll_interval_minutes}` minutes (default 10 — this is the repo-global parent-polling cadence; do not poll tighter in headless runs). Each cycle, in order:

### 1. Heartbeat

`uv run {skill-root}/scripts/backfill-state.py heartbeat --dir {state-dir}` — the heartbeat's freshness is the loop's liveness signal for any sibling tooling (`tests-cli.ts analytics`). It is removed only at the very end of Stage 4.

### 2. Delta-poll the server

Read the high-water mark (`backfill-state.py get-seen`), then:

```
node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs transitions-since --since={last_seen_iso}
```

Log each transition in one line (`[delta] {test_id} {from} → {to} ({event})`), then advance the mark (`backfill-state.py set-seen --timestamp <newest transition timestamp>`). This is the authoritative view of progress — server-side filtered, cheap at scale, and it is how verifier outcomes (`verified_passing`, `needs_compliance_fix`, `needs_run_fix`, `failed`) reach the parent. The server runs compliance + live Playwright on every `BUILD_COMPLETE` submission and mints HMAC evidence on pass; the parent records what the server says and never upgrades a state itself.

### 3. Inspect each active subagent (non-blocking)

For each tracked task, read its output without blocking and act on the first match:

- **Terminal line seen** (`PASSED:` / `FAILED:` / `BLOCKED:` / `ABORTED:`) → count it, free the slot. On `PASSED:`, cross-check against the server's transitions — a `PASSED:` with no corresponding `verified_passing` transition is treated as **unverified** (the claim failed; count under `failed` pending the server's word, and say so in the report). Agents never self-certify.
- **Task ended without a terminal line** → malformed; count `failed`, free the slot.
- **Output changed since last cycle** → note the new hash and timestamp; clear any stall flag.
- **Kill-on-stall:** output unchanged for **two consecutive polls (~2 × `{batch_poll_interval_minutes}`, ≈20 minutes)** → stop the task, log what stage it reached and what it was stuck on, count `failed` (reason "stalled — no progress over two polls"), free the slot. Do not retry immediately; the test can be re-run in a later batch.
- **Park at timeout:** task alive and progressing but total elapsed ≥ `{batch_timeout_minutes}` (default 60) → park it: `backfill-state.py park --dir {state-dir} --test-id … --task-id … --excerpt <last ~1000 chars> --max {max_parked_tasks}`. Parking frees the slot while the task keeps running in the background. If the script reports the park budget (`{max_parked_tasks}`, default 10) is exhausted, stop the task instead and count `timed_out` — and while the budget stays exhausted, halt new spawns and surface one line saying so.

### 3a. Dispatch and watch verification (named verifier, standard circuit breaker)

Verification runs ONLY as the NAMED **`eque2-verifier`** subagent (Task tool, `subagent_type: "eque2-verifier"`) — the name is what mints the verifier role marker via the SubagentStart hook, and the tests CLI's mint verbs fail closed without it. Each cycle: if the delta-poll shows tests in `awaiting_verification` and no verification subagent is live, spawn ONE background `eque2-verifier`; it leases, verifies (compliance rubric + live Playwright), mints verdicts, and drains the queue. The parent NEVER leases or mints — the mint-verb policy below binds it and every subagent.

**Clause A — never-probe:** Privileged verbs (`verdict`, `force-reset`, `verification-reset`) are never invoked to see what happens, to discover flags, or to test validation. Discovery is `--help` only. Sole exception: inside a disposable fixture repo under `EQUE2_TESTS_ADMIN=1` canary mode (the sanctioned test path this project's own suite uses).

**Clause B — anti-reclassification:** Running a mint verb IS minting, whatever you call it — probe, test, dry run, experiment. There is no intent exception outside the sanctioned canary mode above; the CLI records the invocation as an attempt regardless of outcome.

Health: read `{project-root}/.eque2-tests/runs/.verifier-heartbeat` (JSON: `{ts, stage, testId, runId}`) and per-run `{EQUE2_TESTS_LOG_DIR}/{testId}/{runId}/progress.jsonl` / `playwright.log`. Heartbeat `ts` older than `{verifier_stall_threshold_minutes}` (default 20) → surface **one** line:

```
⚠ verifier stalled at stage={stage} on {testId} (no progress {N}m)
```

then apply the standard circuit breaker (kill after two consecutive stalled polls) and re-dispatch next cycle. Leases carry a 30-minute TTL and the verifier's next lease call sweeps expired ones first, so a killed verification never permanently strands a test. Heartbeat file absent (no `EQUE2_TESTS_LOG_DIR`) → note once, skip this check for the rest of the run.

### 4. Reap parked tasks

For each entry in `backfill-state.py list-parked`, check its output for a terminal line. Reaped → count it (same server cross-check for `PASSED:`), `backfill-state.py unpark --test-id …`, log `[park-reaped] {test_id} → {outcome}`.

### 5. Refill the window

While slots are free, the park budget is not exhausted, and `{worklist}` is non-empty: rebuild `{test_knowledge_block}` (Stage 1 step 4 — cheap, manifest-driven), fill the Stage 2 template, spawn. Tests the server has meanwhile moved to `needs_compliance_fix` / `needs_run_fix` with no live subagent are refill candidates too — their subagent resumes from the recorded state, within the test's overall reset budget (the server enforces max 5 resets; respect its refusals).

### 6. Progress line

One line per cycle, no more:

```
{done}/{total} done · active {a} · parked {p} · remaining {r} — ✅ {passed} ❌ {failed} 🚫 {blocked} ⌛ {timed_out}
```

Interactive runs may answer user questions between cycles; headless runs emit the line and nothing else.

## Exit condition

The loop ends when `{worklist}` is empty **and** no tasks are active **and** `list-parked` is empty — or when every remaining item is permanently stuck (park budget exhausted and nothing progressing for two further cycles), in which case stop the stragglers, record them honestly, and exit. Never exit by reclassifying unfinished work as done.

## Restart semantics

If the session dies mid-loop, nothing is rolled back: lifecycle state lives on the server, loop state lives on disk. The next `[BK]` invocation re-enters at Stage 1, whose `init` + reconciliation reaps orphan handles, restores the high-water mark from `seen-history.json`, and re-derives the worklist from `tests-cli.ts summary` — the run continues where the server says it is.

## Progression

Exit condition met → load and execute `04-report.md`. Do **not** remove the heartbeat here — the report stage is still part of the live run.
