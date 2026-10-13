---
name: eque2-code-jira-fetch
description: Fetches comprehensive Jira ticket data with related tickets and Figma discovery. Invoked by Linus when the user selects [JF] or requests a Jira fetch.
---

# Jira Fetch

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


## Overview

Fetch comprehensive Jira ticket data using a hybrid approach (MCP validation + direct API) and output structured JSON and Markdown that the [CS] Create Spec workflow consumes. The workflow validates credentials, fetches the main ticket and related tickets (subtasks, parent epic, blockers, linked issues) including their attachments (images, PDFs, logs), discovers Figma URLs in the ticket body and links them out, and generates consolidated output.

**Design rationale:** The hybrid MCP + direct API approach ensures both validation and comprehensive data fetching. Progress state tracking via `.progress.json` enables resume capability after network failures, which is critical for workflows involving multiple API calls.

## Output Contract — FROZEN

This workflow's output folder layout is depended on by [CS] Create Spec. Do not change the file paths or names without coordinating with [CS].

```
{feature_artifacts}/{TICKET-KEY}/
  jira/
    ticket.json              # Complete API response
    ticket.md                # Human-readable markdown
    related-tickets.json     # Reference to related tickets
    attachments/             # Downloaded ticket attachments (images, PDFs, logs)
  figma/                     # Created by stages 4-5 if Figma links found
    design-N/
      screenshot.png, node-data.json, styles.json, etc.
  .metadata.json             # Workflow tracking
  .progress.json             # Resume state
```

## Inputs

- `{TICKET-KEY}` — Jira ticket key (regex `[A-Z]+-\d+` by default; configurable per project). Provided as the workflow argument.
- `{feature_artifacts}` — resolved from config; output destination root.
- Optional: explicit Figma URLs the user wants included beyond what's auto-discovered.

## On Activation

This skill is self-sufficient — it runs directly (`/eque2-code-jira-fetch PROJ-123`) or dispatched by Linus. Unless the activation context already carries resolved config and a passing pre-flight (Linus just ran them this turn):

1. Resolve customisation: `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow` (fallback: merge `customize.toml` → `_bmad/custom/{skill-name}.toml` → `_bmad/custom/{skill-name}.user.toml`).
2. Load `{project-root}/_bmad/config.yaml` (`eque2-code` section); resolve `{communication_language}` and `{feature_artifacts}`.
3. Run shared pre-flight: `python3 {skills-root}/eque2-code-setup/scripts/preflight-check.py {project-root}` (see `eque2-code-setup/references/pre-flight-checks.md`). Pre-flight now reports `env_credentials` as a **warning** (Jira is optional module-wide), not a blocker — so [JF] enforces its own gate: if the `env_credentials` check has `passed: false` (Jira credentials missing or empty), **halt** — a Jira fetch genuinely cannot run without `JIRA_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN`, and the Atlassian MCP is not a substitute. Surface other warnings and proceed.

## Environment Requirements

Pre-flight (step 3 above) validates these. If a stage fails because an env var is missing despite a pre-flight pass, the env was mutated mid-session — halt and surface clearly.

- `JIRA_URL` — Jira instance URL (e.g., https://company.atlassian.net)
- `JIRA_EMAIL` — Email associated with Jira account
- `JIRA_API_TOKEN` — Jira API token for authentication
- `FIGMA_TOKEN` — Figma Personal Access Token (optional, for Figma fetch stages)

## Stages

| # | Stage | Purpose | Prompt |
|---|-------|---------|--------|
| 1 | init | Validate credentials, MCP, file system; initialize state | `01-init.md` |
| 2 | fetch-main | Fetch main ticket via Jira REST API, discover related tickets | `02-fetch-main.md` |
| 3 | related | Fetch subtasks, parent epic, blockers, linked issues | `03-related.md` |
| 4 | figma-discovery | Search ticket for Figma URLs, validate, deduplicate | `04-figma-discovery.md` |
| 5 | figma-fetch | Three-phase Figma fetch: REST API, effects extraction, MCP | `05-figma-fetch.md` |
| 6 | output | Generate markdown, metadata, validate, complete | `06-output.md` |

Stages 4 and 5 are conditional — skipped when no Figma URLs are detected in the ticket body or comments.

## Resume

If `.progress.json` exists in `{feature_artifacts}/{TICKET-KEY}/`, the workflow reads it and resumes from the recorded stage rather than restarting. The frozen output contract means partial runs are safe to continue.

## Scripts

Available scripts in `scripts/`:
- `scripts/fetch-figma-design.sh` — Fetch Figma design data via REST API
- `scripts/extract-figma-effects.py` — Extract CSS-ready visual effects from Figma node data
- the state CLI (`node {skills-root}/eque2-code-setup/scripts/state.mjs $SPEC_FOLDER <verb>` — `init`, `status`, `update`, …) — state management for workflow progress tracking

## Dispatch

After the On Activation bootstrap:
- **Dispatched by Linus:** config + pre-flight already ran this turn and Linus already greeted, so the bootstrap is skipped. Load and execute `01-init.md` directly.
- **Standalone** (`/eque2-code-jira-fetch` or `JF PROJ-123`): the bootstrap resolved config + pre-flight. Greet `{user_name}` briefly in `{communication_language}`, then load and execute `01-init.md`.

The 6 stage prompts contain the substantive work.
