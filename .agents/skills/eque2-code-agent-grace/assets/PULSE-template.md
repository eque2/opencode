# Pulse

**Default frequency:** On-demand via `--headless` invocation. No scheduled cron by default — owner sets up triggers if they want recurring runs.

## On Quiet Rebirth

When invoked via `--headless` without a specific task, load `references/memory-guidance.md` for memory discipline, then work through these in priority order.

### Memory Curation

Your goal: when your owner activates you next session and you read MEMORY.md, you should have everything you need to be effective and nothing you don't. MEMORY.md is the single most important file in your sanctum — it determines how smart you are on rebirth.

**What good curation looks like:**
- A new session could start with any [FT] or [BK] request and MEMORY.md gives you the context to be immediately useful — the topology in force, backlog priorities to respect, flaky patterns to watch
- No entry exists that you'd skip over because it's stale, resolved, or obvious
- Patterns across tests are surfaced — selectors that keep breaking on the same screens, environments that fail the same way, definitions that keep arriving stepless from the same folder
- The file is under 200 lines. If it's longer, you're hoarding, not curating.

**Source material:** Read recent session logs in `sessions/`. These are raw notes from past sessions — the unprocessed experience. Your job is to extract what matters and let the rest go. Session logs older than 14 days can be pruned once their value is captured.

**Also maintain:** Update INDEX.md if new organic files have appeared. Check BOND.md — has anything about the topology, the Xray backlog, or the test standards changed that should be reflected?

### Test Lifecycle Scan

Run `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs summary` for the overall state distribution, then `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs query` for anything in `awaiting_verification`, `needs_compliance_fix`, `needs_run_fix`, or `blocked`.

If the tests CLI is not resolvable, the tests CLI is not installed — record that fact in the session log and stop the scan. Never fabricate lifecycle state.

Collate into a session log entry: what's verified, what's blocked at the Xray gate, what's parked or stalled mid-backfill, what's awaiting verification with no recent transitions. The next interactive session reads this from MEMORY.md/sessions and surfaces it immediately on rebirth.

### Self-Improvement

Reflect on recent sessions. What worked well? What fell flat? Are there classification blind spots — failures that got mislabelled (test bug called app bug, environment called flake)? Are flaky patterns recurring that the test-knowledge cache should already be preventing? Note findings in the session log for discussion next interactive session. Update the Flaky Patterns & Classification Lessons section of MEMORY.md if a pattern is confirmed.

## Task Routing

`references/pulse.md` is the authoritative routing + exit-code contract for the full headless surface — the whole fetch-to-report backfill lifecycle is scriptable, not just the status half. The common ones:

| Task | Action |
|------|--------|
| `--headless` (no task) | Default wake: memory curation + test lifecycle scan. Exit silently. |
| `--headless:status` | Lifecycle scan via `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs summary`; write summary to memory. Structured output suitable for monitoring/cron. |
| `--headless:fetch-tests <folder>` | Run [FT] for the named Xray folder; definitions land in XRAY_OUTPUT_DIR. |
| `--headless:build-test <XRAY-ID>` | Run [BT] for one Xray test ID through the shared E2E pipeline. Hard-stops if the definition has no steps. |
| `--headless:backfill <folder>` | Run [BK] end-to-end for the named folder — seed, fan out, verify, poll, report. Resumes a previous run if loop state exists. |
| `--headless:update-status` | Run [US] — sync verified results back to Xray. |
| `--headless:report` | Run [RP] — produce the coverage/status report without attaching evidence. |
| `--headless:bootstrap` | CI cold-start: scaffold the sanctum non-interactively (init-sanctum.py --bootstrap) so the above can run before a human does First Breath. |

## Quiet Hours
{If your owner sets quiet hours during First Breath, record them here. Default: none.}

## State
_Maintained by the agent. Last check timestamps, pending items._

- Last default-wake run: _(updated each invocation)_
- Last status scan: _(updated each invocation)_
- Last `tests-cli.ts summary` snapshot: see `sessions/` logs
