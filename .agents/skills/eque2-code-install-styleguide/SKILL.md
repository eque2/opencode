---
name: eque2-code-install-styleguide
description: Detects tech stack and installs coding standards plus review rules. Available on the dispatch menu as [IS] and invoked automatically by pre-flight and [CS] when standards are missing.
---

# Install Styleguide [IS]

## Overview

Detects the primary technology stack of the target repository and installs dual-purpose coding style guides. Detect-then-branch architecture: check the central `eque2/eque2-code` repository for existing guides; install from central or generate from scratch via web research; verify results. Produces `dev-standards.md` for agentic development and `review-rules.md` for code review, installed to `docs/CLAUDE/code-standards/<tech>.md` and `.github/review-rules/<tech>.md` respectively.

**Design rationale:** Centralised guides ensure consistency across projects when available; web-research generation keeps the workflow useful for new technologies. Generated guides are contributed back to the central repo, building the library over time.

## Activation modes

| Mode | Trigger | Behaviour |
|---|---|---|
| **Interactive** | User selects `[IS]` from dispatch, or Linus pre-flight bootstraps with no flag | Full user checkpoints at Stage 1. |
| **Headless** | `--headless` / `-H`, or auto-invoked by [CS] when [CS] itself is running headless | Auto-selects `[C] Continue` at Stage 1 checkpoint. No interactive prompts. |

## On Activation

Detect headless mode from args or caller context. Then:

- **Invoked via Linus / [CS] guard** (config already loaded this turn): load and execute `01-detect.md` directly. Pass headless mode through.
- **Invoked standalone** (`/eque2-code-install-styleguide` or `IS`): resolve customisation (`python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow`) and load `{project-root}/_bmad/config.yaml` (`eque2-code` section) for `{communication_language}`; greet briefly, then proceed. No pre-flight needed — this skill installs the standards that pre-flight checks for.

## Stages

| # | Stage | Purpose | Prompt |
|---|-------|---------|--------|
| 1 | detect | Detect tech stack, fetch manifest, user checkpoint | `01-detect.md` |
| 2a | install | Install from central repo (happy path) | `02a-install.md` |
| 2b | generate | Web research + generate + contribute back | `02b-generate.md` |
| 3 | verify | Structural validation, project-docs confirmation + git-tracking, report | `03-verify.md` |

## Flow

```
01-detect -> [manifest match?]
  YES -> 02a-install -> 03-verify
  NO  -> 02b-generate -> 03-verify
```

## Output

Two files per technology:
- `docs/CLAUDE/code-standards/<tech>.md` — Agentic development (positive patterns, 200-400 lines)
- `.github/review-rules/<tech>.md` — Code review (anti-patterns, 400-800 lines)

Plus, at verify (Stage 3): a confirmation that **project context** exists (a `bmad-project-context` block in `AGENTS.md`, or a legacy docs index) — with a strong recommendation to run `bmad-project-context` if it doesn't — and a `.gitignore` adjustment if either path would otherwise be excluded from version control. `[IS]` confirms context; it does not generate it.

## Configuration

Loads module configuration from `{project-root}/_bmad/config.yaml` (`eque2-code` section) and this skill's `customize.toml` via `resolve_customization.py` — see On Activation.

## Dependencies

- GitHub CLI (`gh`) authenticated with access to `eque2/eque2-code`
- Web browsing capability (for generate path)
