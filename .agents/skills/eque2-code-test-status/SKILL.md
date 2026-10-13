---
name: eque2-code-test-status
description: Dashboard of test lifecycle states from the test-lifecycle MCP server — pending, building, blocked, verified. Invoked by Grace when the user selects [AT] or asks how the test backlog is doing.
---

# Test Status

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


## Overview

A read-only lifecycle dashboard: where every tracked test sits in the backfill state machine, what is stuck, and what to do next. It reads exclusively from the **`tests-cli.ts` tests CLI** (`summary`, `query`, `report` verbs) — the CLI is the single source of truth for lifecycle state, and its verified states are backed by server-minted HMAC evidence that agents cannot forge.

**Hard gate — never fabricate state.** Before doing anything, confirm `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs --help` resolves and runs successfully. If it does not, the tests CLI (delivered by Spec A) is not installed — **stop** with exactly this kind of message: *"The tests CLI isn't installed, so there is no lifecycle state to report. Re-run `/eque2-code-setup` after upgrading eque2-code, then restart Claude Code."* Do not infer state from files, git, or memory; do not present a guessed dashboard.

## Inputs

- No required argument. Optional filters: a state name, an Xray folder, or a test id — passed through to `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs query`.

## On Activation

This skill is self-sufficient — it runs directly (`/eque2-code-test-status`) or dispatched by Grace. Unless the activation context already carries resolved config and a passing pre-flight (Grace just ran them this turn):

1. Resolve customisation: `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow` (fallback: merge `customize.toml` → `_bmad/custom/{skill-name}.toml` → `_bmad/custom/{skill-name}.user.toml`).
2. Load `{project-root}/_bmad/config.yaml` (`eque2-code` section); resolve `{communication_language}`.
3. Run shared pre-flight, then apply the **hard gate above** — the tests-CLI resolvability check trumps everything else.

## The dashboard

Present, from `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs summary` (drilling into `query` / `report` for detail):

1. **Per-state counts** across the eight lifecycle states:
   `pending` · `blocked` · `building` · `awaiting_verification` · `needs_compliance_fix` · `needs_run_fix` · `verified_passing` · `failed`
   (the two terminal states are `verified_passing` — HMAC-evidenced — and `failed`, which carries a `reason` field).
2. **Blocked detail** — each `blocked` test by id with why (almost always a failed Xray gate: no definition or zero steps), so the user knows what to fix in Xray.
3. **Stuck / parked detail** — tests sitting in `needs_compliance_fix`, `needs_run_fix`, or long-lived `building` / `awaiting_verification`, with how long and any parked-by-`[BK]` markers.
4. **Suggested next actions** — concrete, not generic: `[BK] <folder>` to continue the backfill where pending/stuck work remains; `[US]` to sync once `verified_passing` tests exist that Xray does not yet know about; fix-definitions-in-Xray then `[FT]` re-fetch for the blocked set.

Keep it one screen: counts table first, detail only where counts are non-zero.

## Failure modes

- **Tests CLI not resolving** → hard stop with the upgrade pointer above. Never fabricate.
- **CLI runs but empty** (no tests seeded) → that *is* the status: report it plainly and suggest `[FT]` then `[BK]` to seed work.
- **A verb errors** → surface the CLI's error envelope as-is; do not substitute guessed numbers for the failed portion.

## Success criteria

The user can answer "what state is the backlog in and what should I do next?" from one response, and every number shown came from the tests CLI.

## Dispatch

- **Dispatched by Grace:** config + pre-flight ran this turn — run the gate, then render the dashboard.
- **Standalone:** the bootstrap above ran. Greet `{user_name}` briefly in `{communication_language}`, then render the dashboard.
- **Headless** (`--headless:status`): no prompts; emit the counts and details as structured output suitable for monitoring/cron, and write a one-line summary to memory.
