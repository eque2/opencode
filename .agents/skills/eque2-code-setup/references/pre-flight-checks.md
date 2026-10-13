---
name: pre-flight-checks
description: Pre-flight environment checks for interactive activation
---

**Language:** Use `{communication_language}` for all output.

# Pre-Flight Checks

Shared pre-flight for the `eque2-code` module. Run by Linus on interactive activation (after sanctum load, before greeting) **and** by each standalone capability skill ([CS], [DS], …) during its own activation. In `--headless` mode, skip interactive prompts and warn-and-continue on non-blocking issues. A caller that has already run pre-flight this turn (e.g. a skill just dispatched by Linus) may skip it.

## Invocation — delegate to script

The script is hosted in the always-installed setup skill, so every caller invokes it by the same stable path. Each caller passes its own resolved standards globs as pass-throughs (`{agent.*}` from Linus, `{workflow.*}` from a standalone skill); both default to the module defaults if omitted.

```
uv run {skills-root}/eque2-code-setup/scripts/preflight-check.py {project-root} \
  --coding-standards-glob '<caller's coding_standards_glob>' \
  --review-rules-glob '<caller's review_rules_glob>' \
  --project-docs-glob '<caller's project_docs_glob, e.g. {planning_artifacts}/index.md>'
```

Check 7 passes on either of two markers. The current one is the **`bmad-project-context` managed block** (`<!-- bmad:context -->`) in the repo's `AGENTS.md` — checked automatically, no flag needed. The `--project-docs-glob` names the **legacy** marker, consulted only when that block is absent: an `index.md` written to `{planning_artifacts}` (resolved from `bmm/config.yaml`) by the retired `bmad-document-project`. Linus forwards `{agent.project_docs_glob}`; a standalone skill forwards `{workflow.project_docs_glob}`; both default to `{project-root}/docs/index.md` if omitted.

The script runs all checks deterministically and returns structured JSON. Exit codes: 0 ok, 1 degraded (warnings only), 2 failed (blockers present). The caller reads the JSON, surfaces the `summary_line`, halts on blockers, invokes the **`eque2-code-install-styleguide`** skill if `auto_bootstrap_needed` includes `code_standards` or `review_rules` (then re-runs the script to confirm), and surfaces warnings in the session log. The `project_docs` warning gets the special, louder treatment described under **Project Documentation Gate** below.

The checks themselves are listed below for reviewer transparency — the script is the source of truth.

## What to Verify

| # | Check | Severity | Action if Failed |
|---|-------|----------|------------------|
| 1 | `.env` contains `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Warn | Continue. Jira credentials are optional — they enable the Jira-sourced workflows ([JF], [ET]). Surface that those are unavailable until added; prose-file workflows (e.g. `CS @brief.md`) work without them. |
| 2 | `gh` CLI installed (`which gh`) | Warn | Continue. Surface when a workflow needs `gh` (most don't on Day 1). |
| 3 | `node --version` succeeds | Warn | Continue. The state, tests, and Xray CLIs (`state.ts`/`.mjs`, `tests-cli.ts`, `xray-cli.ts`) run on Node; the host needs it both to run the CLIs directly and for `pnpm` / `npm` commands invoked by setup workflows. Block [CS] state stage if missing. |
| 4 | Committed keyring `state/integrity-key.json` resolves — present and well-formed, OR absent with **no** signed history (greenfield), OR an `INTEGRITY_KEY(S)` env override is set | **Blocker** (only for the broken-clone case) | Absent **with** signed `events.jsonl` history → halt: the clone is missing the keyring commit — `git pull` (or `state.mjs key migrate` on a key-holding machine). Malformed file → halt with the file-defect diagnostic (never "tampering"). Greenfield → pass, with `state.mjs key init` guidance. |
| 5 | The caller's `coding_standards_glob` and `review_rules_glob` resolve to ≥1 file each | Auto-bootstrap | If either glob returns empty, invoke the `eque2-code-install-styleguide` skill once. |
| 6 | Package manager detected and `node_modules/` present | Warn before action | Detect; warn before any workflow that would invoke a build. Don't auto-install. |
| 7 | Project context present — a `bmad-project-context` block in `AGENTS.md`, or (legacy) the `project_docs_glob` index resolving to ≥1 file | Warn (strong) | Never block. Doc-dependent workflows (`[CS]`, `[DS]`, `[RS]`, `[BF]`, `[ET]`) **strongly recommend** running `bmad-project-context` and surface the consequences copy below before proceeding; `[JF]`/`[PR]` note it quietly in the log. See **Project Context Gate**. |
| 8 | The committed integrity keyring `state/integrity-key.json` resolves (or an explicit `INTEGRITY_KEY(S)` env override is set) | Warn | Continue. Signed-plaintext state needs the shared `integrityKey`, and it rides with every clone as a committed plaintext file — nothing to install or decrypt. If the file is absent with committed signed history, the clone is missing the keyring commit: `git pull` (or `state.mjs key migrate` from a legacy install). A brand-new repo: `state.mjs key init`, then commit. See **`references/key-onboarding.md`**. |

**Check 4 (keyring)** is the sole remaining blocker, and it only fires on a genuinely broken clone (signed history without its keyring commit). There is no Docker/image triad and no per-machine keychain dependency any more — state, tests, and Xray run as plain CLI scripts invoked directly on the host, and the shared `integrityKey` rides with the clone as a committed plaintext file. A fresh clone therefore works with zero key steps.

**Check 8 (integrity key)** is a warning, not a blocker: a repo that has not yet adopted signed state, or a Linus-only browse, can proceed. But signed-state reads/writes fail without the key, so surface the gap loudly with the fix — the committed-keyring model (clone → key present; rotation = file edit; greenfield `key init`; legacy `key migrate`; the honest policy-over-secrecy trade) is documented in **`references/key-onboarding.md`**, and `/eque2-code-setup` step 2 is its guided verification.

## Project Context Gate

Check 7 is a **strong warning, never a blocker** — the doc-dependent workflows still run without project context, but they run worse. The bar Linus expects is the output of the **`bmad-project-context`** workflow: a small verified block in the repo's `AGENTS.md` carrying what the code cannot say — required policy, where things are, what running the project takes, conventions that differ from defaults, and known pitfalls. A legacy `bmad-document-project` index still satisfies the check on repos that have one; nothing regenerates it.

**Scope — who reacts, and how loudly:**

- **Doc-dependent workflows — `[CS]`, `[DS]`, `[RS]`, `[BF]`, `[ET]`:** when `project_docs.passed` is `false`, surface the consequences copy below, **strongly recommend running `bmad-project-context` first, and offer to launch it**. This is a recommendation, not a gate — if the owner declines, proceed and note in the session log that the workflow ran without a documentation baseline.
- **`[JF]` (pure ticket fetch) and `[PR]` (operates on the diff):** documentation adds little. Log the gap quietly; do **not** nag.
- **Linus at activation:** he fronts the doc-dependent workflows, so fold a one-line recommendation into the greeting when `project_docs` is failing (e.g. *"No project context found — I strongly recommend `bmad-project-context` before we spec or build; say the word and I'll run it."*). Don't repeat it per-workflow in the same session once acknowledged.

**Consequences copy** — surface this (adapt to voice, keep the substance) when a doc-dependent workflow finds no documentation:

> ⚠️ **No project context found.** My spec, build, re-spec, bug-fix, and E2E workflows (`[CS]`, `[DS]`, `[RS]`, `[BF]`, `[ET]`) lean heavily on what this codebase cannot tell me by itself — required policy, where things are, what running it takes, conventions that differ from defaults, known pitfalls. That is the block `bmad-project-context` writes into your `AGENTS.md`.
>
> **I strongly recommend running `bmad-project-context` before we continue.** Skipping it isn't fatal, but it costs you on three fronts:
> - **Time** — without that block, every workflow re-discovers the same ground on each run, re-reading the same files and burning tokens and wall-clock that one upfront pass would have spent once.
> - **Quality** — specs miss cross-cutting concerns, tasks point at the wrong files or reinvent patterns the codebase already has, and the build phase guesses at conventions. Those guesses surface later as review churn and rework.
> - **Reliability** — the larger and less conventional the codebase, the more the gap hurts. Shared utilities, integration seams, and non-obvious conventions are exactly what gets overlooked when there's nothing to read.
>
> A few minutes now buys back compounding time-and-quality cost across everything that follows. Want me to run `bmad-project-context` first? (Or say "proceed anyway" and I'll continue without it.)

**This context must be committed to Git.** It is only useful to the next session, the next teammate, and CI if it's tracked — an ignored `AGENTS.md` or a local-only docs folder defeats the purpose. The `[IS]` workflow confirms the context exists and ensures neither path is excluded by `.gitignore` (see the install-styleguide skill). When recommending `bmad-project-context`, remind the owner to commit its output.

## Implementation Notes

- **Check 5** triggers the only auto-action. [IS] is the registered `eque2-code-install-styleguide` skill — invoke it via the Skill tool (also on Linus's dispatch menu so users can trigger it manually). In headless mode, [IS] runs with `--headless` automatically. After [IS] runs, re-evaluate the glob check before continuing.
- **Check 6** detects the package manager once and stashes the result so workflows downstream don't re-derive it. Order of precedence is `bun.lockb` → `pnpm-lock.yaml` → `yarn.lock` → default `npm`.
- All checks run in parallel where possible — they're independent reads.
- Surface a one-line summary of the pre-flight pass in the greeting ("Pre-flight: 8/8 OK" or "Pre-flight: 1 blocker — see above").

## Why These

- **Check 1** is a warning, not a blocker: Jira credentials are optional. They unlock the Jira-sourced workflows ([JF], [ET]), but Linus launches and a prose-file `[CS]` runs end-to-end without them. Surface the gap so the user knows what's deferred; never halt on it. (Headless `[JF]` itself still hard-fails on missing credentials — a Jira fetch genuinely cannot run without them — but that is the workflow's own gate, not pre-flight's.)
- **Check 5** auto-bootstraps because [CS] loads code standards during the investigation stage. Running [CS] without standards available silently degrades the spec quality. Better to take the 60 seconds to install them than to ship a thin spec.
- **Check 6** is information-only — owners hate auto-installs they didn't authorise.
- **Check 7** is a strong warning rather than a blocker because documentation is a force-multiplier, not a hard dependency: the workflows *function* without it but degrade in time, quality, and reliability (see the Gate). Blocking would punish quick one-offs and brownfield repos that haven't been documented yet; a loud, actionable recommendation respects the owner's judgement while making the cost of skipping explicit.

## Headless Mode Behaviour

- Check 1 (Jira credentials) never halts — it is a warning. Log that Jira-sourced workflows ([JF], [ET]) are unavailable when credentials are absent, and continue. (A headless `[JF]` task invoked without credentials still fails on its own gate — see its PULSE entry — but pre-flight does not block.)
- Check 5 still auto-bootstraps — silently. Invoke [IS] with `--headless`; don't prompt; just install and continue.
- Check 7 never prompts — log the missing-context warning to the session with the recommendation to run `bmad-project-context`, set `"project_docs": "missing"` in the result JSON so a cron consumer can gate on it, and continue. Never auto-run `bmad-project-context` unattended.
- All other warnings: log to session and continue.

## Exit clause

Pre-flight is complete when all checks have been evaluated and the one-line summary is ready. Return to the caller's activation routing — Linus folds the summary into its greeting (or PULSE routing in headless); a standalone capability skill proceeds into its first stage.
