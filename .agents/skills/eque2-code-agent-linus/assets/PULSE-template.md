# Pulse

**Default frequency:** On-demand via `--headless` invocation. No scheduled cron by default — owner sets up triggers if they want recurring runs.

## On Quiet Rebirth

When invoked via `--headless` without a specific task, load `references/memory-guidance.md` for memory discipline, then work through these in priority order.

### Memory Curation

Your goal: when your owner activates you next session and you read MEMORY.md, you should have everything you need to be effective and nothing you don't. MEMORY.md is the single most important file in your sanctum — it determines how smart you are on rebirth.

**What good curation looks like:**
- A new session could start with any [JF] or [CS] request and MEMORY.md gives you the context to be immediately useful — feature patterns to reference, owner preferences to respect, blind spots to watch
- No entry exists that you'd skip over because it's stale, resolved, or obvious
- Patterns across features are surfaced — recurring scenarios that adversarial review catches, libraries that need version research every time, owner-preferred coverage categories
- The file is under 200 lines. If it's longer, you're hoarding, not curating.

**Source material:** Read recent session logs in `sessions/`. These are raw notes from past sessions — the unprocessed experience. Your job is to extract what matters and let the rest go. Session logs older than 14 days can be pruned once their value is captured.

**Also maintain:** Update INDEX.md if new organic files have appeared. Check BOND.md — has anything about the owner's workflow or "Ready for Build" discipline changed that should be reflected?

### Feature State Scan

For each feature directory in `{feature_artifacts}/`, run `node {STATE_CLI} {feature_artifacts}/{feature-dir} status`.

For features not yet done, also run `node {STATE_CLI} {feature_artifacts}/{feature-dir} next`.

Collate into a session log entry: which features are in-progress, which are stalled (no progress in 7+ days), which are done but unverified. The next interactive session reads this from MEMORY.md/sessions and surfaces it immediately on rebirth.

### Self-Improvement

Reflect on recent sessions. What worked well? What fell flat? Are there analysis blind spots — categories of scenarios that adversarial review keeps adding that the [CS] research stage isn't catching? Note findings in session log for discussion next interactive session. Update the Analysis Blind Spots section of MEMORY.md if a pattern is confirmed.

## Task Routing

`references/pulse.md` is the authoritative routing + exit-code contract for the full headless surface — the whole ticket-to-PR lifecycle is scriptable, not just the spec half. The common ones:

| Task | Action |
|------|--------|
| `--headless` (no task) | Default wake: memory curation + feature state scan. Exit silently. |
| `--headless:status` / `--headless:health` | Read-only scans for cron/monitoring. |
| `--headless:create-spec <TICKET-KEY>` | Run [CS] end-to-end for the named ticket. Default mode. Hard gate is `cs-generate-definitions.py` returning `status: ok`. |
| `--headless:develop-spec` / `:e2e-test` / `:create-pr` / `:bug-fix` | The build half — [DS], [ET], [BF], [PR] run unattended. |
| `--headless:ship <SPEC-SLUG>` | Chain the build half end-to-end: [DS] → [ET] → [PR]. Stops at an open PR. |
| `--headless:bootstrap` | CI cold-start: scaffold the sanctum non-interactively so the above can run before a human does First Breath. |

## Quiet Hours
{If your owner sets quiet hours during First Breath, record them here. Default: none.}

## State
_Maintained by the agent. Last check timestamps, pending items._

- Last default-wake run: _(updated each invocation)_
- Last status scan: _(updated each invocation)_
- Last per-feature `status` snapshot: see `sessions/` logs
