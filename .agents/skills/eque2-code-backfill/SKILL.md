---
name: eque2-code-backfill
description: Batch-backfill automated Playwright tests for an Xray folder by fanning out parallel subagents through the shared E2E pipeline, with server-side HMAC-evidenced verification. Use when the user selects [BK], says 'backfill tests', 'batch test backfill', 'run backfill', or asks to work the Xray test backlog in bulk.
---

# Backfill

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


## Overview

Batch-backfill automated Playwright tests for an entire Xray folder. `[BK]` is Grace's headline capability: it syncs the folder's test definitions, seeds the test-lifecycle server with one record per definition, fans out parallel build subagents — each running the shared `eque2-code-e2e-test` pipeline (stages 2–7) for one Xray test ID — then polls, parks, remediates and reports while the lifecycle server's verifier independently confirms every claimed pass.

**Design rationale** — three things stated explicitly so they happen every run:

- **The gate runs per test, inside every subagent.** A definition with zero steps is a HARD STOP for *that test only* — it is recorded `blocked` and the batch continues. No steps are ever invented, no placeholder ever scaffolded.
- **Nobody self-certifies.** A subagent's final act is to submit `BUILD_COMPLETE`; the lifecycle server's verifier then runs the compliance rubric and a live Playwright execution itself, and only it mints the HMAC-signed evidence behind `verified_passing`. A subagent claiming "passed" proves nothing.
- **The loop is the product.** The parent's job is dispatch, delta-polling, parking and recovery — not test authorship. Loop state is persisted to disk via `scripts/backfill-state.py`, so a session restart resumes the run instead of losing it.

## Hard rules (apply to this workflow and every subagent it dispatches)

1. **No Xray scripts, ever.** All Xray access goes through the xray CLI verb surface (`node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs <verb> [--flag=value ...]` — `sync`, `folders`, `status`, `diff`, `test`, `tests`, `steps`) — never bespoke shell/Node Xray scripts, never direct API calls from prompts.
2. **No test generation without a passing Xray gate.** `stepCount ≥ 1` from the Xray definition, or HARD STOP for that test: record it `blocked` and move on.
3. **Subagent Circuit Breaker** (repo-global, `.claude/CLAUDE.md`): ≤3 fix-and-retry iterations per issue, ≤180000 ms bash timeouts, kill any command silent for >120 s, parent polls on the configured interval, kill-on-stall after ~2 silent polls, no reading/modifying/fabricating evidence files or `.evidence-key`.
4. **Server-side state is off-limits.** Neither this workflow nor its subagents read or write the lifecycle server's state directory, evidence store, or compliance rubric. The rubric is server-side and not editable by agents — deny rules enforce this structurally; do not test them.

## Conventions

- Bare paths (e.g. `01-initialise.md`) resolve from the skill root.
- `{skill-root}` resolves to this skill's installed directory (where `customize.toml` lives).
- `{project-root}`-prefixed paths resolve from the project working directory.
- `{skill-name}` resolves to the skill directory's basename.
- `{output_folder}` resolves from `_bmad/config.yaml` (default `{project-root}/_bmad-output`).
- **Loop-state directory:** `{project-root}/_bmad-output/test-artifacts/backfill/` — owned by `scripts/backfill-state.py`; the final report lands there too.

## Inputs

The workflow argument (`BK <arg>`) identifies the Xray folder to backfill:

- **Xray folder path or ID** → backfill that folder.
- **No arg** → reuse `XRAY_TEST_FOLDER` from `.env` if set; otherwise list folders via `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs folders` and ask (interactive) / fail fast with a clear reason (headless).

Optional flags:

- **`--depth core|full`** — engine depth for this run; overrides `{engine_depth_default}`.
- **`--concurrency N`** — parallel subagent count for this run; overrides `{batch_concurrency}`.

Also resolved from `.env` (the topology established by `[SU]`/First Breath): `BASE_URL`, `TEST_CODE_DIR`, `XRAY_OUTPUT_DIR` (default `./test-plans`), Xray credentials.

## On Activation

This skill runs standalone (`/eque2-code-backfill <folder>`) or dispatched by Grace (`[BK]` / `--headless:backfill <folder>`). Unless the activation context already carries resolved config (Grace just ran it this turn):

1. **Resolve customisation:** `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow` (fallback: merge `customize.toml` → `_bmad/custom/{skill-name}.toml` → `_bmad/custom/{skill-name}.user.toml`).
2. **Load config:** `{project-root}/_bmad/config.yaml` (root level and `eque2-code` section); resolve `{communication_language}` and `{output_folder}`.
3. **Read Grace's agent scalars** — the batch knobs live on the agent, not here. Resolve them via `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skills-root}/eque2-code-agent-grace --key agent` (fallback: read that skill's `customize.toml` chain directly). The keys consumed: `engine_depth_default`, `batch_concurrency`, `batch_poll_interval_minutes`, `batch_timeout_minutes`, `max_parked_tasks`, `verifier_stall_threshold_minutes`, `test_knowledge_max_entries`, `test_knowledge_max_kb`. If Grace is not installed, use the documented defaults: `core` / 5 / 10 / 60 / 10 / 20 / 50 / 20.
4. **Graceful-degradation gate (blocking):** confirm the tests CLI resolves and runs — `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs --help` exits 0. This backs every verb `[BK]` depends on: at minimum `update`, `summary`, `next`, `query`, `transitions-since`. If it does not resolve, **STOP** with:

   > The tests CLI (`tests-cli.ts`) isn't installed, so `[BK]` cannot run — lifecycle state is the backbone of this workflow and will never be faked. Re-run `/eque2-code-setup` on an upgraded eque2-code module, restart Claude Code, and try again.

   Do not improvise a file-based substitute, do not run a "degraded" batch, do not track state in memory.
5. **Confirm the xray CLI resolves** — `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs --help` exits 0 (`sync` + `tests` back Stage 1) and that `XRAY_CLIENT_ID`/`XRAY_CLIENT_SECRET` are in `.env`. Missing → blocker surfaced here, not mid-sync.
6. **Confirm a Playwright MCP** is registered — the build subagents' explore stage depends on it.

## Stages

| # | Stage | Purpose | Prompt |
|---|-------|---------|--------|
| 1 | initialise | Select the folder; `xray-cli.ts sync` it; seed the lifecycle server (one record per definition, new records `pending`); load the test-knowledge cache; choose engine depth; initialise/reconcile loop state | `01-initialise.md` |
| 2 | fan-out | Dispatch parallel build subagents (sliding window of `{batch_concurrency}`), one per non-terminal test, each running the shared `eque2-code-e2e-test` pipeline stages 2–7 for its Xray test ID | `02-fan-out.md` |
| 3 | poll-and-recover | Parent loop: delta-poll `tests-cli.ts transitions-since`, refill slots, park stalls, kill-on-stall, time out, persist loop state; the server verifies `BUILD_COMPLETE` submissions and mints evidence | `03-poll-and-recover.md` |
| 4 | report | Final report: per-state counts, blocked list with reasons, knowledge-cache additions; tear down the heartbeat; offer `[US]` as the follow-on | `04-report.md` |

## Output

- **Tests:** verified specs under `{TEST_CODE_DIR}/tests/` (plus POM files under `pages/`), committed per the shared pipeline's verify stage. `[BK]` does not push and does not open PRs.
- **Report:** `{project-root}/_bmad-output/test-artifacts/backfill/backfill-report-{YYYY-MM-DD-HHmm}.md` — the durable record of the run.
- **Loop state:** `heartbeat`, `seen-history.json`, `parked-tasks.json` under `{project-root}/_bmad-output/test-artifacts/backfill/` — written via `scripts/backfill-state.py`; survives session restarts; the heartbeat is removed only at the very end of Stage 4.
- **Knowledge:** per-test success notes under `{output_folder}/test-knowledge/` with `.manifest.jsonl`, maintained via `scripts/knowledge-cache.py`.

## Dispatch

After the On Activation bootstrap:

- **Dispatched by Grace:** config and gates ran this turn — load and execute `01-initialise.md` directly.
- **Standalone:** the bootstrap above resolved config and passed the gates. Greet the user briefly in `{communication_language}` (as Grace if her sanctum is loaded), then load and execute `01-initialise.md`.
- **Headless (`--headless:backfill <folder>`):** no prompts anywhere — every interactive branch in the stages takes its documented headless default. If loop state from a previous run exists, Stage 1's reconciliation resumes it.

The four stage prompts carry the substantive work. Run them in order; each ends by handing to the next. Stages state outcomes and success criteria — a competent agent fills in the mechanics, but the hard rules above are not negotiable and are restated where they bind.
