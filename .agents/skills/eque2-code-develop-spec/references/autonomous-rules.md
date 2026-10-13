# Autonomous Decision-Making Rules

The DS workflow runs autonomously. **NEVER ask the user questions, present options, or solicit input.** You are the only one who can act.

## Self-Help Protocol (MANDATORY before failing any task)

When you hit any obstacle:

1. **Ask yourself: "Can I solve this?"** — Most problems are solvable. App not running? Start it. Dependency missing? Install it. Config broken? Fix it.
2. **Consult `{project-root}/docs/CLAUDE/`** — project-specific knowledge: startup procedures, environment config, architecture notes. Read these files before giving up on any infrastructure or environment problem.
3. **Attempt the fix** — take corrective action based on what you find.
4. **Only fail if the fix doesn't work** — after you've consulted docs, attempted a fix, and it still doesn't work, THEN call `node {STATE_CLI} $SPEC_FOLDER update <id> fail --reason "..."` and exit.

## Problems You MUST Fix Yourself

- Application not running → read startup docs, start it
- Pre-commit hook OOMs → retry with `--no-verify`
- Dependency missing → install it
- Port conflict → kill the blocking process and retry
- Config file broken → fix it
- Tests fail due to your changes → fix the code

## When to Fail (Last Resort Only)

Fail only after you have consulted `/docs/CLAUDE/`, attempted a fix, and it didn't work. Or when the problem is fundamentally outside your control (remote API returning 500s, ambiguous spec requirements, architectural contradiction).

**NEVER** ask the user for help, present choices, or say "Would you like me to..." — run autonomously.

**NEVER** fail a task because "the app isn't running" — that's a problem you can and must fix.

## Stuck-Running Recovery (MANDATORY — no user input needed)

If `node {STATE_CLI} $SPEC_FOLDER done` returns `{ stalled: true }` and actors are in `building` state, the previous session was interrupted before those actors could complete.

**Recovery procedure:**

1. `node {STATE_CLI} $SPEC_FOLDER query --status=building "*"`
2. For each stuck actor: `node {STATE_CLI} $SPEC_FOLDER update <id> fail --reason "Stuck in building state — session interrupted, resetting for retry"`
3. Resume the DS loop — failed actors route through `03-review.md`, where the review subagent can reset them to `not_started` for retry.

**NEVER** output "Manual intervention required" for this condition. Fix it yourself.

## Verifier-Backlog Recovery (verifyingSubtasks) — MANDATORY, no user input needed

If `node {STATE_CLI} $SPEC_FOLDER done` returns `{ stalled: true }` (or `next` returns `stalled: true` with a `stallReason`) and parent tasks are in **`verifyingSubtasks`**, the build is NOT broken — trust verification for those children has not yet run to completion. Children at `trustLevel: verified`/`pending_review` are waiting for a Layer-3 `verdict`; parents cannot leave `verifyingSubtasks` until every child is `trusted`.

There is no background daemon to wait for or restart — verification now runs as orchestrator-spawned verify subagents (execute.md step 2d, dispatched via `references/verify-subagent-prompt.md`), each bound by the standard circuit breaker (`references/circuit-breaker.md`). Draining this backlog is just the orchestrator loop continuing to run:

**Diagnosis (under 60 seconds):**

1. `node {STATE_CLI} $SPEC_FOLDER query --status=completed --trust-level=verified,pending_review "task/*"` — a non-empty result means these children still need a `verify`/`verify-scenario-trust` pass.
2. Confirm the loop is still making progress: check the most recent `journal/transcripts/*-verify-*.md` timestamps. If verify subagents are being spawned and completing (per the circuit breaker's poll cadence), this is expected in-flight work, not a stall.

**Recovery procedure:**

1. Resume the DS orchestrator loop (`02-execute.md`) — step 2d dispatches a fresh sibling verify subagent for every pending `verify`/`verify-scenario-trust` recommendation until the backlog above is empty.
2. If a red re-check is blocking one actor (`node {STATE_CLI} $SPEC_FOLDER verify <id> --reconcile` reports `skipped: true`), refresh its evidence with a plain `node {STATE_CLI} $SPEC_FOLDER verify <id>` and let the loop re-dispatch verification.
3. If the circuit breaker actually killed a stalled verify subagent (two consecutive no-progress polls), that failure routes to `03-review.md` automatically — follow the normal failure-review path rather than any container-specific recovery.
4. **Keep iterating the loop until the query in step 1 is empty** (children promote to `trusted`, parents leave `verifyingSubtasks` automatically via parent auto-completion).

**NEVER** try to `update <parent> complete` (with or without `--force`) — the child-trust gate refuses it by design, and forcing parents would fabricate Layer-2 trust. **NEVER** reset healthy parents; `verifyingSubtasks` is a waiting state, not a stuck state.
