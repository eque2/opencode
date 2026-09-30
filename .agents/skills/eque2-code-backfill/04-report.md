Language: {communication_language}

# Stage 4: Report

**Progress: Stage 4 of 4** — Compile the final report and hand off.

Outcome: one durable report file capturing what the batch did, what is blocked and why, and what was learned — compiled from data already gathered, with the lifecycle server as the authority on state. Do not re-run tests or re-verify anything here.

## Sequence

### 1. Gather

- **Per-state counts** — `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs summary` (authoritative, post-run). Also capture `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs analytics --windowMinutes=<run duration>`'s closing health snapshot.
- **Loop counters** from Stage 3: `passed`, `failed`, `blocked`, `timed_out`, parked-then-reaped, `lost_on_session_restart` (from Stage 1 reconciliation), cycles executed.
- **Blocked list with reasons** — every test in `blocked` (Xray gate failures: no definition / zero steps) and every `failed` with its `reason` field, via `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs query --state=<state>`. These are the operator's to-do list.
- **Knowledge-cache additions this run** — manifest entries in `{output_folder}/test-knowledge/.manifest.jsonl` with timestamps ≥ the run's start; list test ID + the note's one-line fix summary.
- **Unverified claims**, if any (subagent said `PASSED:` but the server never minted `verified_passing`) — listed explicitly; these are never counted as passes.
- **Verifier stalls** observed this run (from Stage 3's ⚠ relay lines): how many, at which stage, on which tests, and whether they recovered after the watchdog restart. If none, say so.

### 2. Write the report

To `{project-root}/_bmad-output/test-artifacts/backfill/backfill-report-{YYYY-MM-DD-HHmm}.md` (create the directory if needed):

```markdown
# Test Backfill Report

**Date:** {date} · **Folder:** {xray_folder} · **Depth:** {engine_depth} · **Concurrency:** {concurrency}
**Tests in scope:** {total} ({skipped} already terminal/blocked at start)

## Outcomes

| Outcome | Count | % |
|---------|-------|---|
| Verified passing (server-minted HMAC evidence) | X | X% |
| Failed | X | X% |
| Blocked (Xray gate — no definition / zero steps) | X | X% |
| Timed out | X | X% |
| Parked, reaped during run | X | X% |
| Lost on session restart (orphans reaped) | X | X% |

**Poll cycles:** X · **Loop health at close:** {from tests-cli.ts analytics}

## Lifecycle state (post-run, per tests-cli.ts summary)

| State | Count |
|-------|-------|
| pending / building / awaiting_verification / needs_compliance_fix / needs_run_fix / blocked / verified_passing / failed | … |

## Blocked and failed — reasons

[One row per test: ID, name, state, reason. For blocked tests note the remedy:
author the Xray definition, then re-run [BK]. If none, write "Nothing blocked or failed."]

## Unverified claims

[Tests whose subagent reported PASSED: without a matching verified_passing
transition. If none, write "None — every claimed pass was server-verified."]

## Knowledge added this run

[Table: test ID · fix summary · note path. If none, write "No knowledge entries
added this run."]

## Verifier health & stalls

[Stalls relayed in Stage 3: count, stage they stuck at, test IDs, and whether
the circuit breaker's kill-and-lease-sweep recovered them (there is no
in-container watchdog anymore — verification runs as fresh, one-shot subagents;
recovery is the standard Subagent Circuit Breaker plus the server's own
lease-expiry sweep). If none, write "Verifier healthy — no stalls observed."]

## Where the logs are (for the next agent)

Per-run verifier artifacts live on the host directly under
`{EQUE2_TESTS_LOG_DIR}` (default `{project-root}/.eque2-tests/runs/{testId}/{runId}/`
— no bind-mount needed since there is no container): `playwright.log` (live test
output), `progress.jsonl` (per-stage timeline), `invocation.txt`, `results.json`,
traces/screenshots/videos on failure. The latest verifier heartbeat is
`.eque2-tests/runs/.verifier-heartbeat`. Read this report and those artifacts
before re-investigating a stall — don't repeat the exploratory work.
```

The empty-run path (Stage 1 found nothing to do) writes the same file with the scope line and a single sentence.

### 3. Present and hand off

Show the Outcomes and Blocked tables in chat (headless: emit the report path and the outcome counts as the structured result), then:

- Any `verified_passing` tests → **offer `[US]` (update-status) as the follow-on**: "Ready to sync these results back to Xray — run `[US]`."
- Blocked tests → point at the reasons table: definitions need authoring in Xray before a re-run can pick them up.
- `needs_compliance_fix` / `needs_run_fix` leftovers → "re-run `[BK]` to resume them" (the server's reset budget still applies).

### 4. Tear down the liveness signal (last action of the run)

```bash
uv run {skill-root}/scripts/backfill-state.py heartbeat-clear \
  --dir {project-root}/_bmad-output/test-artifacts/backfill
```

This is the **only** place the heartbeat is removed, and it happens after the report is written — sibling analytics must see the loop as live until the run is truly over. `seen-history.json` and `parked-tasks.json` are left in place for the next run's reconciliation.

## Progression

Terminal. Return to Grace's dispatch (append the outcome to her session log if her sanctum is loaded).
