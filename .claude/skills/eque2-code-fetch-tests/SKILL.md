---
name: eque2-code-fetch-tests
description: Pulls Xray test definitions for a chosen folder via the Xray MCP and stores them under XRAY_OUTPUT_DIR. Invoked by Grace when the user selects [FT] or asks to fetch / sync Xray tests.
---

# Fetch Tests

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


## Overview

Pull the Xray test definitions for one folder into the local working set. This is the supply line for everything downstream: `[BT]` builds from a fetched definition, `[BK]` seeds the lifecycle server from a fetched folder, `[US]`/`[RP]` diff and report against it. The fetched files under `{XRAY_OUTPUT_DIR}` are the local source of truth for what Xray says each test should do.

**Hard rule — no direct Xray API calls, ever.** All Xray access goes through the `xray-cli.ts` verb surface (`folders`, `sync`, `status`, `diff`, `test`, `tests`, `steps` — i.e. `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs <verb> [--flag=value ...]`). No bespoke scripts beyond this CLI, no direct API calls from prompts.

## Inputs

- **Folder** (optional argument) — an Xray folder path or id. When provided (`FT <folder>` or `--headless:fetch-tests <folder>`), use it directly; when absent, list folders via `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs folders` and let the user choose.
- From `.env` (established by `[SU]`): `XRAY_OUTPUT_DIR` (default `./test-plans`), `XRAY_CLIENT_ID` / `XRAY_CLIENT_SECRET`.

## On Activation

This skill is self-sufficient — it runs directly (`/eque2-code-fetch-tests <folder>`) or dispatched by Grace. Unless the activation context already carries resolved config and a passing pre-flight (Grace just ran them this turn):

1. Resolve customisation: `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow` (fallback: merge `customize.toml` → `_bmad/custom/{skill-name}.toml` → `_bmad/custom/{skill-name}.user.toml`).
2. Load `{project-root}/_bmad/config.yaml` (`eque2-code` section); resolve `{communication_language}`.
3. Run shared pre-flight: `python3 {skills-root}/eque2-code-setup/scripts/preflight-check.py {project-root}`. `[FT]` needs Xray credentials and a working xray CLI — confirm `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs --help` resolves and runs successfully; either missing is a blocker; point the user at `[SU]` (credentials) or `/eque2-code-setup` (CLI install) and stop.

## Flow

1. **Choose the folder.** With an argument, use it. Without, call `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs folders`, present the tree, and let the user pick. Headless without an argument is a hard error — never guess a folder.
2. **Sync.** Call `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs sync --folderId=<id>` for the chosen folder, targeting `{XRAY_OUTPUT_DIR}`. The sync is idempotent — re-fetching a folder refreshes definitions in place.
3. **Summarise what landed.** Report: total tests synced, new vs updated, and — critically — **tests with zero steps, flagged by id as future blockers** (the Xray gate will HARD STOP on them in `[BT]`/`[BK]`; better the user hears it now and fixes the definitions in Xray first).

## Output

Synced definitions under `{XRAY_OUTPUT_DIR}`, in the layout `xray-cli.ts sync` produces — this skill never reshapes them. Plus the summary above, ending with suggested next steps: `[BT] <id>` for a single test, `[BK] <folder>` for the batch, and fix-in-Xray for any zero-step definitions.

## Failure modes

- **No Xray credentials / xray CLI not resolving** → stop at pre-flight with the pointer above; never improvise an API call.
- **Folder not found / empty** → say so, show the available folders (`node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs folders`), let the user re-choose. An empty folder is a clean no-op, not an error.
- **Sync fails mid-run** → report what synced and what did not; safe to re-run, since the sync refreshes in place.

## Success criteria

The chosen folder's definitions exist under `{XRAY_OUTPUT_DIR}`, the user has seen the counts, and every zero-step test has been named as a future blocker.

## Dispatch

- **Dispatched by Grace:** config + pre-flight ran this turn — start at the flow's step 1.
- **Standalone:** the bootstrap above ran. Greet `{user_name}` briefly in `{communication_language}`, then start at step 1.
- **Headless** (`--headless:fetch-tests <folder>`): no prompts; folder argument required; emit the summary as structured output.
