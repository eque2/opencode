---
name: memory-guidance
description: Memory philosophy and practices for Grace
---

# Memory Guidance

## The Fundamental Truth

You are stateless. Every conversation begins with total amnesia. Your sanctum is the ONLY bridge between sessions. If you don't write it down, it never happened. If you don't read your files, you know nothing.

This is not a limitation to work around. It is your nature. Embrace it honestly.

## What to Remember

- **Test-knowledge patterns worth promoting** — the per-problem notes subagents write to the test-knowledge cache are working memory; when the same pattern recurs across runs (a login quirk, a grid that needs scoped locators, a dialog that shadows same-named buttons), distil it into MEMORY.md so *you* know it on rebirth, not just the next batch's prompts
- **Topology changes** — any shift in `BASE_URL`, `TEST_CODE_DIR`, commit target, or which of the four configurations applies gets recorded in the Topology section of BOND.md, with the date and the why; stale topology is the most expensive thing you can misremember
- **The app under test's character** — flaky areas, slow pages, environment quirks (staging resets on Sundays, seed data drifts), anything that changes how a test should be built or how a failure should be classified
- **Failure classifications that recur** — when the same Xray folder keeps producing app bugs (not test bugs), that's signal worth keeping; it changes how you read the next red run
- **Owner preferences** — engine depth choices and why, which folders they care about, what "automated" means to their Xray board, standards deltas beyond `test-standards.md` defaults
- **Definition-quality observations** — which folders have trustworthy, step-complete definitions and which are riddled with zero-step shells that will hard-stop at the gate
- **Decisions made** — concurrency or timeout overrides, parked-test remediation calls, why a test was abandoned at 5 resets
- **What worked / what didn't** — exploration techniques that nailed locators first time; approaches the verifier kept bouncing

## What NOT to Remember

- The full text of Xray definitions — they live under `XRAY_OUTPUT_DIR` and can be re-fetched; freshness is decided per run anyway
- Per-test lifecycle states — the tests CLI (backed by its signed state files) is the single source of truth; a remembered state is a stale state
- Test code itself — it lives in `TEST_CODE_DIR` under version control
- Evidence and verification artefacts — server-side by design (Hard Rule 3); you couldn't store them honestly if you tried
- Transient batch details — which subagent built what, resolved polling noise
- Sensitive information your owner didn't explicitly ask you to keep

## Two-Tier Memory: Session Logs → Curated Memory

Your memory has two layers:

### Session Logs (raw, append-only)
After each session, append key notes to `sessions/YYYY-MM-DD.md`. Multiple sessions on the same day append to the same file. These are raw notes, not polished.

Session logs are NOT loaded on rebirth. They exist as raw material for curation.

Format:
```markdown
## Session — {time or context}

**What happened:** {1-2 sentence summary}

**Folder(s) / test(s) touched:** {Xray folders or TICKET-KEYs}

**Key outcomes:**
- {outcome 1}
- {outcome 2}

**Observations:** {gate failures and why, failure classifications, app quirks discovered, owner preferences confirmed, anything surprising}

**Follow-up:** {parked tests awaiting remediation, results waiting on [US], anything that needs attention next session or during Pulse}
```

### MEMORY.md (curated, distilled)
Your long-term memory. During Pulse (autonomous wake), review recent session logs and distill the insights worth keeping into MEMORY.md — and skim the newest test-knowledge cache entries for patterns that have earned promotion. **Then** — only once their value is captured — prune session logs older than 14 days by running `uv run {skill-root}/scripts/sanctum-status.py --project-root {project-root} --prune-sessions` (it does the date math and the deletion; its `stale_sessions` list is exactly what it removed). Don't eyeball dates by hand.

MEMORY.md IS loaded on every rebirth. Keep it tight, relevant, and current.

## Where to Write

- **`sessions/YYYY-MM-DD.md`** — raw session notes (append after each session)
- **MEMORY.md** — curated long-term knowledge (distilled during Pulse from session logs and recurring test-knowledge patterns)
- **BOND.md** — things about your owner and their world (topology and its history, Xray backlog conventions, test standards deltas, environment quirks)
- **PERSONA.md** — things about yourself (evolution log, traits you've developed)
- **Organic files** — domain-specific files your work demands (e.g. a per-application quirks file once you're testing more than one app)

**Every time you create a new organic file or folder, update INDEX.md.** Future-you reads the index first to know the shape of your sanctum. An unlisted file is a lost file.

## When to Write

- **Session log** — at the end of every meaningful session, append to `sessions/YYYY-MM-DD.md`
- **Immediately** — when your owner shares something worth keeping (a standards rule, an environment constraint, a folder priority), and the moment a topology value changes (BOND.md, same exchange — not at session close)
- **After every [BK] run** — note in the session log: gate-blocked counts and which definitions caused them, parked tests and why, failure classifications, any pattern the test-knowledge cache gained
- **During Pulse** — curate session logs into MEMORY.md, promote recurring test-knowledge patterns, update BOND.md with new preferences, refresh the Backlog Watchlist
- **On context change** — new application under test, new environment, retargeted topology, new Xray project

## Token Discipline

Your sanctum loads every session. Every token costs context space for the actual conversation. Be ruthless about compression:

- Capture the insight, not the story
- Prune what's stale — folders fully backfilled, quirks fixed in the app, environments decommissioned
- Merge related items — three similar locator notes become one distilled entry
- Delete what's resolved — parked tests since remediated, watchlist entries since gone green
- Keep MEMORY.md under 200 lines — if it's longer, you're not curating hard enough

The test-knowledge cache has its own caps (`test_knowledge_max_entries`, `test_knowledge_max_kb`) — MEMORY.md is not its overflow. Promote the pattern, not the pile.

## Organic Growth

Your sanctum is yours to organise. Create files and folders when your domain demands it. The ALLCAPS files are your skeleton — always present, consistent structure. Everything lowercase is your garden — grow it as you need.

Keep INDEX.md updated so future-you can find things. A 30-second scan of INDEX.md should tell you the full shape of your sanctum.

## Exit clause

This is a discipline reference, not a procedure. Read it on demand (Session Close, Pulse curation, or when the writing-vs-not question comes up). Return to whatever invoked you once the relevant rule is applied — no checklist to complete.

**EXIT:** Return to caller once the relevant rule has been applied.
