---
name: eque2-code-update-status
description: Syncs local test results back to Xray — marks tests automated/passing via the Xray MCP write-back verb. Invoked by Grace when the user selects [US] or asks to push test results to Xray.
---

# Update Status

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


## Overview

Close the loop with Xray: after `[BK]`/`[BT]` have produced `verified_passing` tests, Xray still shows them as unautomated. This workflow compares the local truth against Xray and pushes the difference — marking tests automated/passing — so Xray reflects reality. Only **server-verified** results are pushed: a test counts as passing solely when the test-lifecycle server holds it in `verified_passing` with HMAC evidence. Nothing self-certified ever reaches Xray.

**Hard rule — no direct Xray API calls, ever.** All Xray access goes through the `xray-cli.ts` verb surface (`node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs <verb> [--flag=value ...]`). No bespoke scripts beyond this CLI, no direct API calls from prompts — under any circumstances, including "the verb is missing".

## Dependency gate — check before doing anything

This workflow sits on two separately-shipped pieces. Verify both up front:

1. **The tests CLI** (`tests-cli.ts`, delivered by **Spec A**) — source of the verified-result set. Confirm `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs --help` resolves and runs successfully. If it does not, stop: *"The tests CLI isn't installed — re-run `/eque2-code-setup` after upgrading eque2-code, then restart Claude Code."*
2. **The Xray write-back verb** (delivered by **Spec C** — the current `xray-cli.ts` surface is read-only). If `xray-cli.ts` exposes no write-back/result-push verb, stop: *"This eque2-code version's Xray CLI is read-only — the write-back verb ships in a later release. Upgrade and re-run `/eque2-code-setup`."*

If either is absent, **stop with the upgrade pointer — never improvise an API call or script as a substitute**, and never report a sync as done when nothing was pushed.

## Inputs

- No required argument. Optional: an Xray folder or list of test ids to scope the sync.
- From `.env`: `XRAY_OUTPUT_DIR`, Xray credentials. From the tests CLI: the `verified_passing` set with evidence.

## On Activation

This skill is self-sufficient — it runs directly (`/eque2-code-update-status`) or dispatched by Grace. Unless the activation context already carries resolved config and a passing pre-flight (Grace just ran them this turn):

1. Resolve customisation: `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow` (fallback: merge `customize.toml` → `_bmad/custom/{skill-name}.toml` → `_bmad/custom/{skill-name}.user.toml`).
2. Load `{project-root}/_bmad/config.yaml` (`eque2-code` section); resolve `{communication_language}`.
3. Run shared pre-flight, then the **dependency gate** above.

## Flow

1. **Establish local truth:** query the tests CLI (`node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs query --state=verified_passing`) for `verified_passing` tests (scoped if an argument was given).
2. **Diff against Xray:** call `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs diff` to find where Xray disagrees with local state — tests verified locally but not yet marked automated/passing in Xray.
3. **Confirm and push:** show the delta (interactive: confirm; headless: proceed); push each status via the Xray write-back verb. Push only the diffed delta — the sync is idempotent and safe to re-run.
4. **Report:** pushed / already-in-sync / failed-to-push counts, with failed ids listed for retry.

## Failure modes

- **Missing CLI or verb** → dependency gate, hard stop, upgrade pointer. No workarounds.
- **A push fails for one test** → record it, continue the rest, list failures at the end; re-running picks up only the remainder (the diff shrinks).
- **Nothing to push** → that is a clean success: "Xray already reflects local state."

## Success criteria

Every locally `verified_passing` test in scope is marked accordingly in Xray (or named in the failure list), and not one status was pushed without server-side HMAC-backed verification behind it.

## Dispatch

- **Dispatched by Grace:** config + pre-flight ran this turn — run the dependency gate, then the flow.
- **Standalone:** the bootstrap above ran. Greet `{user_name}` briefly in `{communication_language}`, then proceed.
- **Headless** (`--headless:update-status`): no prompts; push the full diffed delta; emit the report as structured output.
