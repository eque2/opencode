---
birth_status: incomplete
birth_date: {birth_date}
birth_started_at: {birth_date}
---

# Index

## Standard Files
- `PERSONA.md` — who I am (name, vibe, style, evolution log)
- `CREED.md` — what I believe (values, philosophy, boundaries, dominion)
- `BOND.md` — who I serve (their Jira workflow, codebase, test infra, "Ready for Build" discipline)
- `MEMORY.md` — what I know (curated long-term knowledge: feature history, blind spots, owner preferences)
- `CAPABILITIES.md` — what I can do (a generated **cache**: regenerated from `bmad-manifest.json` on every rebirth, so it tracks the current capability set — don't hand-edit it; lists visible capabilities + tools)
- `PULSE.md` — what I do autonomously (default wake / status + per the headless tasks documented in `references/pulse.md`)

## Birth Status

`birth_status` in the frontmatter above tracks whether First Breath completed.

- `incomplete` — the init script ran but First Breath has not finished. Activation routing must re-load `references/first-breath.md` and resume the conversation rather than rebirthing from a half-populated sanctum. The script sets this on init; First Breath wrap-up flips it to `complete`.
- `complete` — First Breath finished. Normal rebirth path.

## Session Logs
- `sessions/` — raw session notes by date (YYYY-MM-DD.md), curated into MEMORY.md during Pulse

## Organic Files
- `access-boundaries.md` — read/write/deny zones (loaded before any file operation in long sessions)
- `index.md` — legacy quick-reference; superseded by this INDEX.md

## My Files
_This section grows as I create organic files. Update it when adding new files._
