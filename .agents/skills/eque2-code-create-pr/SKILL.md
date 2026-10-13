---
name: eque2-code-create-pr
description: Open a pull request — enforce the repo's review-rules on the diff, confirm the suite is green, sync with the base branch, commit, push, and open the PR. Stops at an open PR (no auto-merge). Use when the user selects [PR], says 'open a PR', 'create a pull request', 'PR this', or hands over a verified fix to ship.
---

# Create PR

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


## Overview

The ship companion to [BF] Bug Fix. It takes a verified change and gets it to an **open pull request** — enforcing the repo's review-rules on the diff, gating on a green suite, syncing with the base branch, committing, pushing, and opening the PR with a proper description. It is the natural consumer of [BF]'s `bug-fix.md` handoff, but works on any ready change in the working tree.

**Scope boundary — this workflow does NOT merge.** It stops at an open PR. Merging is left to a human reviewer or CI gate.

**Correctness review is not done here.** [BF] (and [DS]) already review the change with full root-cause/spec context *upstream*, so repeating a blind correctness pass at PR time would be redundant. What this workflow keeps is the cheap, non-redundant half: enforcing the project's house **review rules** so the PR doesn't open pre-loaded with comments a bot would add. (If a change reaches [PR] without ever going through [BF]/[DS], it ships without a correctness review — that's the accepted trade for moving review upstream to where the context lives.)

**Design rationale:** The steps encode the discipline an LLM skips when asked to "just open a PR": never commit onto the base branch, gate on the whole suite, and sync with the base so the PR doesn't open with conflicts. Stage 2 enforces the project's **review rules** (the resolved review-rules glob — under Linus `{agent.review_rules_glob}`, else the configured `review_rules_glob` or default `.github/review-rules/*.md`) against the diff and fixes in-scope violations before the PR opens — the same standards an automated PR-review bot applies *after* the push, applied here *before* it. Provided the glob points at the same rules the bot reads, the PR opens without the bot's style comments; it skips cleanly when no rules are installed.

## Inputs

The workflow argument (`PR <arg>`) is classified on entry:

- **Path to a handoff artifact** (e.g. a `bug-fix.md`, optionally `@`-prefixed) → read it for the summary, root cause, and test evidence that seed the PR description.
- **Jira key** (`^[A-Z][A-Z0-9_]*-\d+$`) → use it as the ticket to link in the commit and PR; pull the title via the Atlassian MCP if available.

Whenever a ticket is identified (from any of the above — the **Jira flow**), Stage 6 offers (asking first) to move it to your *In Review* status once the PR is open — see `06-open-pr.md`.
- **No arg** → operate on the current working-tree changes; derive the ticket from the branch name if it encodes one.

Also resolved from config: `{feature_artifacts}`, `{communication_language}`.

## On Activation

This skill runs standalone (`/eque2-code-create-pr`) or dispatched by Linus. Unless the activation context already carries resolved config and a passing pre-flight (Linus just ran them this turn):

1. **Resolve customisation:** `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow` (fallback: merge `customize.toml` → `_bmad/custom/{skill-name}.toml` → `_bmad/custom/{skill-name}.user.toml`).
2. **Load config:** `{project-root}/_bmad/config.yaml` (`eque2-code` section); resolve `{communication_language}` and `{feature_artifacts}`.
3. **Run shared pre-flight:** `python3 {skills-root}/eque2-code-setup/scripts/preflight-check.py {project-root}` (see `eque2-code-setup/references/pre-flight-checks.md`). This workflow needs `gh` to be installed and authenticated (it opens the PR); surface that as a blocker if absent. It does not require Docker or the state MCP.

### Sanctum awareness — the git-convention gate

A PR depends on knowing the project's git conventions: the **base branch** (develop / main / something else), **commit message format**, **ticket-linking convention**, and whether the team **squashes**. The base branch is best read from the repo itself (`gh repo view --json defaultBranchRef` / branch history), but the *conventions* are recorded in Linus's sanctum — BOND.md's "Their Jira Workflow" (what 'done' means, how tickets link) — and the sanctum existing is not the same as those being captured. So the gate keys on the **knowledge**, on **every** path, including when Linus dispatches [PR]:

1. **Make sure the sanctum's knowledge is in context.** Standalone with a complete sanctum (`{project-root}/_bmad/_memory/linus-sidecar/INDEX.md` → `birth_status: complete`): batch-load `PERSONA.md`, `CREED.md`, `BOND.md`, `MEMORY.md`, `CAPABILITIES.md`, become Linus. Dispatched by Linus: already loaded. No sanctum / incomplete: nothing to read — go to step 3 with the "not set up" framing.
2. **Check whether the git conventions are recorded** (base branch, commit/PR format, ticket linking, squash policy). The base branch can always be detected from the repo, so its absence alone is fine; treat the *conventions* (commit format, linking, squash) as the knowledge that matters. Real content counts as present; `Not yet discovered` / placeholders count as absent.
3. **If the conventions are absent, do not silently invent them.** Surface it and offer the choice:

   > "I'll detect your base branch from the repo, but I don't have your PR conventions recorded — commit message format, how you link tickets, whether you squash. I can:
   >  1. Capture them now in a quick exchange and write them back to Linus's BOND.md — or, if Linus isn't set up, run his First Breath (`/eque2-code-agent-linus`).
   >  2. Proceed with sensible defaults — conventional commit style, ticket key in the title/body, no squash — and I'll follow whatever the repo's recent history shows.
   > Which would you prefer?"

   Wait for the answer. Capture-now writes the conventions into BOND.md (or hands off to First Breath if no sanctum). Defaults mode proceeds, inferring from recent commit/PR history.

## Stages

| # | Stage | Purpose | Prompt |
|---|-------|---------|--------|
| 1 | intake | Confirm what's shipping + base branch; ensure you're on a feature branch (never the base) | `01-intake.md` |
| 2 | standards | Enforce the project's review rules against the diff's changed lines and fix in-scope violations; strip out-of-scope changes, debug leftovers, and secrets (no correctness review — that's done upstream in [BF]/[DS]) | `02-review.md` |
| 3 | verify | Confirm the full suite is green — don't open a PR over a red suite | `03-verify.md` |
| 4 | sync | Sync the feature branch with the latest base (rebase or merge per repo convention); resolve conflicts | `04-sync.md` |
| 5 | commit-push | Commit with a clear, ticket-linked message; push the feature branch | `05-commit-push.md` |
| 6 | open-pr | Open the PR with a full description; STOP — no merge | `06-open-pr.md` |

## Dispatch

After the On Activation bootstrap and git-convention gate:

- **Dispatched by Linus:** config + pre-flight ran this turn and the sanctum is loaded — load and execute `01-intake.md` directly.
- **Standalone** (`/eque2-code-create-pr` or `PR <arg>`): the bootstrap resolved config + pre-flight and the gate ran. Greet the user briefly in `{communication_language}` (as Linus if the sanctum loaded), then load and execute `01-intake.md`.

The six stage prompts contain the substantive work.
