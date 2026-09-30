---
name: eque2-code-test-report
description: Coverage and status report across the test backlog, optionally attaching evidence to Xray tickets via the Xray MCP. Invoked by Grace when the user selects [RP] or asks for a test coverage report.
---

# Test Report

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


## Overview

Produce the durable, human-readable answer to "where does test automation stand?" — coverage and status across the whole backlog, written to `{project-root}/_bmad-output/test-artifacts/`. Where `[AT]` is a live glance, `[RP]` is the artefact you hand to a stakeholder: per-folder coverage (definitions vs automated vs verified), the blocked list with reasons, terminal failures with their `reason` fields, and trend since the last report when one exists. Optionally, it attaches the verification evidence for passing tests to their Xray tickets.

**Hard rule — no direct Xray API calls, ever.** All Xray access goes through the `xray-cli.ts` verb surface (`node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs <verb> [--flag=value ...]`). No bespoke scripts beyond this CLI, no direct API calls from prompts.

## Dependency gate — check before doing anything

1. **The tests CLI** (`tests-cli.ts`, delivered by **Spec A**) — source of all lifecycle numbers (`report`, `summary`, `query`). Confirm `node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs --help` resolves and runs successfully. If it does not, stop: *"The tests CLI isn't installed — re-run `/eque2-code-setup` after upgrading eque2-code, then restart Claude Code."* Never fabricate report numbers from files or memory.
2. **Evidence attachment** (optional step) needs the Xray attachment/write verb delivered by **Spec C** — the current xray CLI surface is read-only. If it is absent and the user wants attachments, produce the report anyway but skip attachment with: *"Evidence attachment needs the Xray write verb, which ships in a later release — upgrade and re-run `/eque2-code-setup`."* **Never improvise an API call or script as a substitute** (the old `backfill-xray-attachments.mjs` behaviour is explicitly not to be reinstated as a script).

## Inputs

- No required argument. Optional: an Xray folder to scope the report; `--attach-evidence` to also push evidence to Xray tickets (interactive runs may offer it; headless never attaches).

## On Activation

This skill is self-sufficient — it runs directly (`/eque2-code-test-report`) or dispatched by Grace. Unless the activation context already carries resolved config and a passing pre-flight (Grace just ran them this turn):

1. Resolve customisation: `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow` (fallback: merge `customize.toml` → `_bmad/custom/{skill-name}.toml` → `_bmad/custom/{skill-name}.user.toml`).
2. Load `{project-root}/_bmad/config.yaml` (`eque2-code` section); resolve `{communication_language}`.
3. Run shared pre-flight, then the **dependency gate** above.

## The report

Built from the tests CLI (`node {skills-root}/eque2-code-setup/scripts/tests-cli.mjs report` first, `summary`/`query` for drill-down) cross-referenced with the synced definitions under `{XRAY_OUTPUT_DIR}` (refreshed via `node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs status`/`node {skills-root}/eque2-code-setup/scripts/xray-cli.mjs diff` where staleness matters):

1. **Headline coverage** — definitions known / automated / `verified_passing`, as counts and percentage, per folder and overall.
2. **Blocked backlog** — every `blocked` test with its reason (typically zero-step Xray definitions), framed as "fix these in Xray to unblock N tests".
3. **Failures** — terminal `failed` tests with their `reason` field; in-flight remediation states (`needs_compliance_fix`, `needs_run_fix`) listed separately.
4. **Delta** — what changed since the previous report in `test-artifacts/`, when one exists.
5. **Evidence attachment** (optional, gated above) — for `verified_passing` tests, attach the server-minted evidence to the matching Xray ticket via the Xray CLI write verb; record per-ticket success/failure in the report.

Write the report as a dated markdown file under `{project-root}/_bmad-output/test-artifacts/` and present the headline numbers inline.

## Failure modes

- **Tests CLI not resolving** → hard stop, upgrade pointer, no report.
- **Attachment verb absent** → report still produced; attachment skipped with the pointer; never worked around.
- **Individual attachment failures** → continue, list them in the report for retry.

## Success criteria

A dated report file exists whose every number traces to a tests-CLI verb or a synced Xray definition, and any evidence attachments actually landed on their tickets (or are named as failed).

## Dispatch

- **Dispatched by Grace:** config + pre-flight ran this turn — run the dependency gate, then build the report.
- **Standalone:** the bootstrap above ran. Greet `{user_name}` briefly in `{communication_language}`, then proceed.
- **Headless** (`--headless:report`): no prompts, no evidence attachment; write the report file and emit the headline numbers as structured output.
