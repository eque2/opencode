---
name: eque2-code-bug-fix
description: Fix a bug the disciplined way — reproduce it, write a test that fails for the right reason, fix it, and confirm the full suite stays green. Use when the user selects [BF], says 'fix this bug', 'BF <ticket>', or hands over a bug report.
---

# Bug Fix

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


## Overview

A lightweight, test-first bug-fix workflow. It encodes the discipline an LLM tends to skip when asked to "just fix it": reproduce the bug *before* touching code, interrogate why existing tests didn't catch it, write a test that fails *for the right reason*, make the minimal fix, and gate on the **whole** suite — not just the new test — before declaring done.

**Scope boundary — this workflow does NOT commit or push.** It ends when the fix is verified and a handoff summary is written. Review and push are a separate workflow (to be built); keeping them out of here means a verified fix is never auto-shipped.

**Design rationale:** Reproduce-first prevents fixing the wrong thing; wide investigation before the fix prevents the *half fix* (patching the symptom site while sibling cases that share the root cause stay broken); a failing-for-the-right-reason test prevents false confidence from tests that fail for unrelated reasons; an automatic full, context-rich code review of the fix catches incompleteness before a human has to; the full-suite gate catches collateral breakage. None of these are reliable LLM defaults, so the workflow states them explicitly.

## Inputs

The workflow argument (`BF <arg>`) is classified on entry:

- **Jira key** (matches `^[A-Z][A-Z0-9_]*-\d+$`, e.g. `PROJ-123`) → optionally chain [JF] (`eque2-code-jira-fetch`) to pull ticket context, then treat the ticket as the bug report. This is the **Jira flow**: Stage 1 also offers (asking first) to move the ticket to your *In Progress* status — see `01-intake.md`.
- **File path** (optionally `@`-prefixed) → read the file as the bug report.
- **Free text** → treat as the bug report inline.
- **No arg** → ask the user to describe the bug (symptom, repro steps, expected vs actual).

Also resolved from config: `{feature_artifacts}` (handoff output root), `{communication_language}`.

## On Activation

This skill runs standalone (`/eque2-code-bug-fix PROJ-123`) or dispatched by Linus. Unless the activation context already carries resolved config and a passing pre-flight (Linus just ran them this turn):

1. **Resolve customisation:** `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow` (fallback: merge `customize.toml` → `_bmad/custom/{skill-name}.toml` → `_bmad/custom/{skill-name}.user.toml`).
2. **Load config:** `{project-root}/_bmad/config.yaml` (`eque2-code` section); resolve `{communication_language}` and `{feature_artifacts}`.
3. **Run shared pre-flight:** `python3 {skills-root}/eque2-code-setup/scripts/preflight-check.py {project-root} --project-docs-glob '{workflow.project_docs_glob}'` (see `eque2-code-setup/references/pre-flight-checks.md`). Pre-flight reports `env_credentials` as a warning (Jira is optional module-wide), not a blocker. Gate on it **only** when the arg is a Jira key: if `env_credentials` has `passed: false`, the [JF] chain cannot run, so halt and ask for credentials (or a non-Jira bug report). For a file-path or free-text bug report, surface the warning and proceed — no Jira needed. This workflow does not require Docker or the state image — it never touches the state MCP. If `project_docs` is failing, apply the **Project Documentation Gate** — strongly recommend running `bmad-project-context` first and offer to launch it before fixing.

### Sanctum awareness — the test-knowledge gate

A bug fix leans hard on Linus's recorded project knowledge: BOND.md's **"Their Test Infrastructure"** section (test framework, where tests live, test-file naming convention) is what Stages 3, 4, and 6 depend on. But the sanctum *existing* is **not** the same as that knowledge being present — First Breath can complete with that section left as `Not yet discovered` or template seed text. So the gate keys on the **knowledge**, not on sanctum presence, and it runs on **every** dispatch path — including when Linus dispatches [BF]:

1. **Make sure the sanctum's knowledge is in context.**
   - Standalone with a complete sanctum (`{project-root}/_bmad/_memory/linus-sidecar/INDEX.md` has `birth_status: complete`): batch-load `PERSONA.md`, `CREED.md`, `BOND.md`, `MEMORY.md`, `CAPABILITIES.md`, become Linus.
   - Dispatched by Linus: already loaded this turn.
   - No sanctum / `birth_status: incomplete`: there's nothing to read — go straight to step 3 with the "not set up" framing.

2. **Inspect BOND.md's "Their Test Infrastructure" section.** It counts as **present** only if it holds real content — a named framework / test location / naming convention. `Not yet discovered`, `{...}` placeholders, or seed text count as **absent**. If present, proceed to the stages — Stages 3/4/6 use it directly.

3. **If the test knowledge is absent (in any path, including within Linus), do not silently proceed.** Surface it and offer the choice:

   > "I don't have your test setup recorded yet — framework, where tests live, and the naming convention. (Linus's BOND.md hasn't captured 'Their Test Infrastructure'.) I can:
   >  1. Capture it now in a quick exchange and write it back to BOND.md, so this and every future bug fix benefits — or, if Linus isn't set up at all, run his First Breath (`/eque2-code-agent-linus`, ~15–20 min).
   >  2. Proceed in generic mode — I'll detect your test setup from the codebase as I go, without persisting it.
   > Which would you prefer?"

   Wait for the answer.
   - **Capture now** → if the sanctum exists, ask the three questions (framework, location, naming), write them into BOND.md's "Their Test Infrastructure" section, then continue. If no sanctum exists, hand off to `/eque2-code-agent-linus` for First Breath and stop.
   - **Generic mode** → continue; Stage 2 detects the test setup from the repo instead of from BOND.md, and nothing is persisted.

## Stages

| # | Stage | Purpose | Prompt |
|---|-------|---------|--------|
| 1 | intake | Classify the arg, capture the bug report (optionally chain [JF]), derive a slug | `01-intake.md` |
| 2 | reproduce | Map the whole bug (root cause + every site sharing it + the input classes), reproduce it locally, capture the exact observed failure | `02-reproduce.md` |
| 3 | existing-test | Find any test covering this path; if it passes, diagnose why it missed the bug and how it shipped | `03-existing-test.md` |
| 4 | failing-test | Write a test that reproduces the bug and confirm it fails for the *right* reason | `04-failing-test.md` |
| 5 | fix | Make the minimal targeted fix | `05-fix.md` |
| 6 | verify | Auto-run a full, context-rich code review on the fix and apply gap fixes, then confirm the new test passes and the full suite stays green; write the handoff summary; STOP | `06-verify.md` |

### Auto-invoked review (default mode)

Stage 6 runs a **full, context-rich `bmad-code-review`** on the finished fix — the same review [PR] used to run, moved here where the root-cause context lives. Stage 2's analysis (root cause, sibling sites, the input-classes a complete fix must cover) is written to a context file and passed as the review's acceptance spec, so its Acceptance Auditor hunts specifically for an *incomplete* fix on top of the usual blind-hunter and edge-case layers. `decision_needed` and `patch` findings are auto-applied (with a test added/widened for each) and re-gated by the full suite; it falls back to a single `bmad-review` adversarial-lens pass if `bmad-code-review` isn't installed. Suppressed by `--no-adversarial` or `--yolo`; capped at 3 apply-and-recheck iterations per the subagent circuit breaker.

Stage 6 also checks the fix against the project's **review rules** (the resolved review-rules glob — under Linus `{agent.review_rules_glob}`, else the configured `review_rules_glob` or default `.github/review-rules/*.md` — the same anti-pattern catalogues an automated PR review enforces) and fixes the in-scope violations, so the fix reaches `[PR]` already standards-clean. Skipped cleanly when no rules are installed.

## Output (handoff artifact)

Stage 6 writes `{feature_artifacts}/bugfix-{slug}/bug-fix.md` — reproduction notes, root cause, the why-existing-tests-missed diagnosis, the fix, and verification results (new test + full-suite outcome). This is the input the future review-and-push workflow will consume; it deliberately stops short of any git operation.

## Dispatch

After the On Activation bootstrap and sanctum gate:

- **Dispatched by Linus:** config + pre-flight ran this turn and the sanctum is loaded — load and execute `01-intake.md` directly.
- **Standalone** (`/eque2-code-bug-fix` or `BF <arg>`): the bootstrap resolved config + pre-flight and the sanctum gate ran. Greet the user briefly in `{communication_language}` (as Linus if the sanctum loaded), then load and execute `01-intake.md`.

The six stage prompts contain the substantive work.
