---
name: eque2-code-develop-spec
description: Implement a spec end-to-end via an autonomous build-verify loop. Use when the user selects [DS], says 'develop spec', 'run DS', or 'execute spec'.
---

# Develop Spec

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


Orchestrates the full implementation lifecycle for a buildable spec. Queries the state CLI (`state.mjs`) for the next recommended action, spawns fresh-context Task subagents for each unit of work (build, review, verify, check), and repeats until all tasks and scenarios are complete or the iteration cap is reached. The result is a fully implemented, reviewed, and verified feature branch ready for PR.

Act as Linus. Drive to completion without human intervention.

**Design rationale:** Fresh-context subagents prevent accumulated context drift, eliminate confirmation bias (the verifier never remembers building the code), provide clean retry semantics, and bound resource usage. The only coordination between iterations is the state CLI's signed plaintext state files — never ad-hoc local JSON.

## Conventions

- Bare paths (e.g. `references/state-cli-reference.md`) resolve from this workflow's root.
- `{skill-root}` resolves to this workflow's installed directory (where `customize.toml` lives).
- `{project-root}`-prefixed paths resolve from the project working directory.
- `{workflow.<name>}` references this skill's own customisation, resolved from `customize.toml` (see On Activation). It resolves identically whether this skill is invoked directly or dispatched by Linus.
- `{STATE_CLI}` resolves to `{skills-root}/eque2-code-setup/scripts/state.mjs` — the bundled, dependency-free state CLI. Invoke it as `node {STATE_CLI} $SPEC_FOLDER <verb> ...` (plain `node`, not `npx tsx` — there is no `state.ts` source or MCP server in an installed target repo, only this compiled `.mjs`).

## On Activation

1. **Bootstrap (standalone or dispatched).** This skill is self-sufficient. Unless the activation context already carries resolved config and a passing pre-flight (i.e. Linus just ran them this turn):
   - Resolve customisation: `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow` (fallback: merge `customize.toml` → `_bmad/custom/{skill-name}.toml` → `_bmad/custom/{skill-name}.user.toml`).
   - Load `{project-root}/_bmad/config.yaml` (`eque2-code` section); resolve `{communication_language}` and `{feature_artifacts}`. Confirm `{feature_artifacts}` is set.
   - Run shared pre-flight: `python3 {skills-root}/eque2-code-setup/scripts/preflight-check.py {project-root} --project-docs-glob '{workflow.project_docs_glob}'` (see `eque2-code-setup/references/pre-flight-checks.md`). [DS] needs the keyring blocker to pass; halt on that, surface warnings. If `project_docs` is failing, apply the **Project Documentation Gate** — [DS] builds against architecture, so strongly recommend running `bmad-project-context` first and offer to launch it before implementing.

2. Read `references/guardrails.md` in full. The integrity rules there — no evidence forging, no direct state-file edits, no reading signing-key material (`state/integrity-key.json`, `.signer-key`, legacy `.evidence-key`) — bind *you*, the orchestrator, directly. Not just the subagents you spawn. Internalise them before doing anything else.

3. Parse arguments:
   ```
   DS <spec-slug-or-path> [--parallel] [--mode=autonomous|supervised]
   ```
   - `spec-slug` resolves to `{feature_artifacts}/<spec-slug>/`; a full path is also accepted.
   - `--parallel` enables parallel execution of independent tasks.
   - `--mode`: `autonomous` (default) or `supervised` (shows each recommendation before spawning).
   - No argument → prompt for the spec slug.

4. Resolve `SPEC_FOLDER` to an absolute path. Store it.

5. Route to `01-setup.md`.

## Stages

| # | Stage | Purpose | Prompt |
|---|-------|---------|--------|
| 1 | Setup | Validate spec, initialise state, offer worktree | `references/setup.md` |
| 2 | Execute | Orchestrator loop: query state, spawn subagents, check outcomes, repeat | `references/execute.md` |
| 3 | Review | Failure review: assess recoverability, reset or document blocker | `references/review.md` |
| 4 | Complete | Exit handling: done, stalled, blocked, or max iterations | `references/complete.md` |

## Sub-workflows

Dispatched from Stage 2 based on the `action` field returned by `node {STATE_CLI} $SPEC_FOLDER next`:

| Action | Sub-workflow | Description |
|--------|-------------|-------------|
| `build` | `build-task/SKILL.md` | Implement a subtask using TDD |
| `review` | `review-task/SKILL.md` | Adversarial code review of the parent task |
| `verify` | `verify-scenario/SKILL.md` | Locate/write test, run it via vitest reporter, record result |
| `check` | *(inline)* | Run build check |
| `verify-scenario-trust` | `semantic-verify-scenario/SKILL.md` | Semantic trust verification for a passed scenario |

`figma-compliance-review/SKILL.md` is dispatched from within `review-task` when the spec references Figma data — it is not a direct `next`-recommended action.

## Critical rules (NO EXCEPTIONS)

- **Read and obey `references/guardrails.md`** — evidence-integrity and state-access rules that bind the orchestrator and every subagent.
- **NEVER** edit `state.md` or any state file directly. All state changes go through the state CLI (`node {STATE_CLI} $SPEC_FOLDER <verb> ...`).
- **ALWAYS** call `node {STATE_CLI} $SPEC_FOLDER next` before deciding what to do next.
- **ALWAYS** call `node {STATE_CLI} $SPEC_FOLDER update ...` after completing work (this happens inside each subagent).
- **ALWAYS** respect the max iterations cap. Default: 100.
- **A non-zero exit code is a HARD ERROR** — every CLI call prints one JSON object to stdout and exits 0 on success; a non-zero exit with a stderr message means stop immediately, never retry blindly.

## References

- `references/state-cli-reference.md` — state CLI verb reference and usage
- `references/autonomous-rules.md` — self-help protocol and stuck-running recovery
- `references/quality-checks.md` — lint/typecheck discovery and caching
- `references/subagent-prompt.md` — Task subagent prompt template
- `references/guardrails.md` — hard limits and integrity rules for the orchestrator and every subagent
- `references/circuit-breaker.md` — background task polling and kill protocol

## Completion outcomes

- **Done**: All tasks and verifications complete. Feature ready for PR.
- **Stalled**: A blocker failed (max attempts reached), blocking downstream work. Manual intervention required.
- **Blocked**: All remaining work is blocked. No recommendation available.
- **Max Iterations**: Reached iteration cap. Pausing for review.
