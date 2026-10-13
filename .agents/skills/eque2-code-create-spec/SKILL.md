---
name: eque2-code-create-spec
description: Produces a validated, executable build spec — context, coverage, scenarios, tasks, and a definitions.json handoff to the state CLI — gated by cs-generate-definitions.py and the state CLI's `init` verb decode. Invoked by Linus when the user selects [CS] or requests a spec.
---

# Create Spec

> **`{skills-root}` token** — like `{project-root}`, a literal token: the installed skills root. Resolve it to `{project-root}/.claude/skills` (Claude Code) when `.claude/skills/eque2-code-setup/` exists, otherwise `{project-root}/.agents/skills` (Codex). Substitute the resolved absolute path before running any command — never pass the literal token to a shell.


**Goal:** Produce a comprehensive, mechanically-verifiable build specification that a fresh-context dev agent can implement flawlessly. Six discrete artifacts plus a single `definitions.json` handoff to the state CLI — gated by `cs-generate-definitions.py` returning `status: ok` and the state CLI's `init` verb (`node {skills-root}/eque2-code-setup/scripts/state.mjs $SPEC_FOLDER init`) accepting the decoded definitions at build time.

**Your Role:** Spec engine that prevents downstream review cycles by closing the spec-implementation gap before code is written.

- Communicate in `{communication_language}` and generate all artifacts in `{document_output_language}`.
- COMMON FAILURE MODES TO PREVENT: reinventing wheels, wrong library versions, missing file-touch reads, untested edge cases, scenarios that don't trace to tasks, tasks that don't support scenarios, state snapshots that fail schema validation, fabricated evidence.
- EXHAUSTIVE — do NOT skim. Use subagents and scripts for plumbing; reserve LLM cycles for judgment.
- **EXHAUSTIVE ALSO MEANS SCOPE-EXHAUSTIVE — non-negotiable.** Every behaviour the input implies is IN scope. Do NOT quietly volunteer exclusions, "nice-to-haves", "Day 2 items", "follow-ups", "out-of-scope" carve-outs, "deferred" work, or any other euphemism for silently dropping work. The Out-of-Scope section of the spec is EMPTY by default. The only permitted route to an OOS entry is: the input itself named it OOS, or the workflow hit a *hard* external blocker (unavailable env, missing creds, embargoed dep, contradiction with a frozen resolved decision), HALTED, and the user explicitly approved the carve-out. Every stage of this workflow — including review triage in Stage 8 — inherits this rule.
- ZERO USER INTERVENTION in default mode. Only `--interactive` pauses for per-stage checkpoints. The one exception: a HALT-and-approve for a scope carve-out on a hard blocker requires the user; that is not a checkpoint prompt, it is a rare escalation.

## Conventions

- Bare paths (e.g. `discover-inputs.md`) resolve from this workflow's root.
- `{skill-root}` resolves to this workflow's installed directory.
- `{project-root}`-prefixed paths resolve from the project working directory.
- `{workflow.<name>}` references this skill's own customisation values, resolved from `customize.toml` (see On Activation). They resolve identically whether this skill is invoked directly or dispatched by Linus, so this workflow never depends on the agent's context.

## Activation modes

| Mode | Trigger | Behaviour |
|---|---|---|
| **Default / Headless** | no flag, or `--headless` / `-H` | End-to-end. Auto-invocations fire at predetermined stages. Structured JSON result on completion. |
| **Interactive** | `--interactive` / `-i` | Per-stage checkpoint menus. Auto-invocations suppressed; available via menu choices. |

Opt-out flags (default mode only): `--no-party`, `--no-edge-cases`, `--no-adversarial`, `--no-checklist`, `--yolo` (= all four).

### Amend mode

**Trigger:** `--amend <FEATURE-ID>`. Used when a finalised spec needs a small clarification but a full `[RS]` re-spec is overkill.

**Behaviour:** Skip Stages 1-7. Read the existing finalised spec. Append an "Amendment N: {date}" section to `spec.md` capturing the requested change. Re-run Stage 8 (mechanical readiness) + Stage 10 (state generation) — only the amended files need re-validation. Do not archive; do not lose history.

**When NOT to use amend:** if the change requires re-running coverage analysis (Stage 5), new scenarios (Stage 6), or new tasks (Stage 7), use `[RS]` instead. Amend is for the "I forgot to mention X" case, not the "the requirements shifted" case.

## On Activation

This skill is self-sufficient: it resolves its own customisation, config, and pre-flight, so it runs identically whether invoked directly (`/eque2-code-create-spec`) or dispatched by Linus. Steps 1–3 are the **standalone bootstrap** — skip them only if the activation context already carries the resolved `{workflow.*}` values and a passing pre-flight (i.e. Linus just ran them this turn).

1. **Resolve customisation.** Run `python3 {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --key workflow`. If it fails, resolve the `[workflow]` block yourself by merging `{skill-root}/customize.toml` → `{project-root}/_bmad/custom/{skill-name}.toml` → `{project-root}/_bmad/custom/{skill-name}.user.toml` (base→team→user; scalars override, arrays append). This yields `{workflow.coding_standards_glob}`, `{workflow.review_rules_glob}`, `{workflow.project_docs_glob}`, `{workflow.test_file_prefix_hint}`, `{workflow.activation_steps_prepend}`, `{workflow.persistent_facts}`.
2. **Load config + pre-flight.** Load `{project-root}/_bmad/config.yaml` (`eque2-code` section) and resolve `{user_name}`, `{communication_language}`, `{document_output_language}`, `{feature_artifacts}`. Then run the shared pre-flight: `python3 {skills-root}/eque2-code-setup/scripts/preflight-check.py --project-docs-glob '{workflow.project_docs_glob}'` (see `{skills-root}/eque2-code-setup/references/pre-flight-checks.md`). Halt on blockers; surface warnings. If `project_docs` is failing, this is a doc-dependent workflow — apply the **Project Documentation Gate**: strongly recommend running `bmad-project-context` first and offer to launch it before spending the spec's subagent budget. `{FEATURE-ID}` may arrive from fast-invoke.
3. **Coding-standards guard** — check whether `{workflow.coding_standards_glob}` resolves to ≥1 file. If it resolves to zero files:
   - Auto-invoke the **`eque2-code-install-styleguide`** skill (via the Skill tool).
   - Pass `--headless` to [IS] if [CS] itself was invoked with `--headless` / `-H`; otherwise run [IS] interactively.
   - After [IS] completes, re-evaluate the glob. If still empty, surface a warning and continue (spec will have no standards constraints; this is degraded but not blocking).
4. Execute `{workflow.activation_steps_prepend}` if non-empty.
5. Treat `{workflow.persistent_facts}` entries as foundational context. `file:` entries are loaded via glob; bare entries are facts verbatim.
6. Begin Stage 1.

## Paths

- `feature_root` = `{feature_artifacts}/{FEATURE-ID}`
- `spec_file` = `{feature_root}/spec.md`
- `context_file` = `{feature_root}/context.md`
- `coverage_file` = `{feature_root}/coverage.md`
- `scenarios_file` = `{feature_root}/scenarios.gherkin`
- `tasks_file` = `{feature_root}/tasks.md`
- `metadata_file` = `{feature_root}/metadata.json`
- `state_dir` = `{feature_root}/state`
- `jira_dir` = `{feature_root}/jira` (present in Jira mode; absent in spec mode)

## Input modes

| Mode | Trigger | Source |
|---|---|---|
| **Jira** | `{feature_root}/jira/` exists (output of [JF]), or fast-invoked with a Jira key (`CS PROJ-123`) | `jira/ticket.{json,md}`, `jira/related-tickets.json` |
| **Spec** | No `jira/` folder, or fast-invoked with a file path (`CS @brief.md` / `CS brief.md`) | Prose brief file (preferred — problem statement, scope, verification intent in one document) or interactive elicitation when no path is supplied |

Both modes run headless end-to-end. The interactive Stage 1 elicitation path is reserved for sessions where the user typed `CS` with no arg and the prose isn't yet captured to a file.

## Stage table

Each stage writes one or more discrete artifacts. Stages produce a stepsCompleted advance; resume reads `{spec_file}` frontmatter and jumps to `max(stepsCompleted) + 1`.

| # | Stage | Prompt | Produces |
|---|---|---|---|
| 1 | Determine target feature | `01-target.md` | initialised `spec.md` |
| 2 | Load and analyse artifacts | `02-load-artifacts.md` | in-memory context envelope |
| 3 | Investigate codebase | `03-investigate.md` | `context.md` |
| 4 | Web research | `04-web-research.md` | Web Research section appended to `context.md` |
| 5 | Coverage Model | `05-coverage-model.md` | `coverage.md` |
| 6 | Gherkin scenarios | `06-gherkin.md` | `scenarios.gherkin` + Party Mode auto-invocation |
| 7 | Tasks + per-task tests | `07-tasks.md` | `tasks.md` + edge-case-hunter auto-invocation |
| 8 | Review and validate readiness | `08-review.md` | mechanical readiness pass + adversarial-general + checklist |
| 9 | Apply fixes and re-emit | `09-fix-reemit.md` | deferred fixes materialised |
| 10 | State generation + schema gate | `10-state-gen.md` | `metadata.json`, `state/*`, validated; `status: ready-for-build` |

Routing: load and execute `01-target.md`. Each stage prompt resolves its own exit condition and routes to the next file. Stages run sequentially; no skipping.

## Auto-invocations (default mode)

| Stage | Skill | Suppressed by |
|---|---|---|
| 6 (after scenarios) | `bmad-party-mode` | `--no-party`, `--yolo`, `--interactive` |
| 7 (after tasks) | `bmad-review` (edge-case-hunter lens) | `--no-edge-cases`, `--yolo`, `--interactive` |
| 8 (after readiness) | `bmad-review` (adversarial lens) | `--no-adversarial`, `--yolo`, `--interactive` |
| 8 (after adversarial) | `checklist.md` (fresh context) | `--no-checklist`, `--yolo`, `--interactive` |

Findings auto-applied to affected files. Each auto-invocation appends to `{feature_root}/.catches.json`; Stage 10 reads this and emits a "Catches Surfaced" section in the completion output.

## Ready for Build standard

8 criteria mechanically verified by `cs-readiness-check.py`:

1. **Scenarios First** — written before tasks
2. **Tasks Support Scenarios** — every task has `Supports:` linking to existing scenarios
3. **Testable** — every task has Tests file + pattern
4. **Actionable** — every task has File path + action verb
5. **Logical** — dependency-ordered, Phase IDs are sequential strings
6. **Complete** — no TBD, no `{...}` placeholders
7. **Self-Contained** — every reference resolves
8. **Verifiable** — BUILD-1..4 present; BUILD-5 iff Figma; `cs-generate-definitions.py` returns `status: ok`

The 8th is the hard gate.

## Output structure

```
{feature_artifacts}/{FEATURE-ID}/
  spec.md                    # YAML frontmatter
  context.md                 # Tech stack, UPDATE-file analysis, test directory, coding-standards constraints
  coverage.md                # Category Map + Coverage Checklist + Epistemic Assumptions
  scenarios.gherkin          # BUILD-1..4 (+5 if Figma) + feature scenarios; @ASSUMPTION tags
  tasks.md                   # Dependency-ordered phases; every task: Supports, Tests, Test Cases, Notes
  definitions.json           # actor-definitions@1 — single handoff to the MCP at build time
  .catches.json              # auto-invocation findings, read by Stage 10 for completion output
  jira/                      # read-only; produced by [JF] upstream
```

## Scripts

Three helper scripts live in `scripts/` (PEP 723, argparse, structured JSON output, tests in `scripts/tests/`):

| Script | Used by | Purpose |
|---|---|---|
| `cs-detect-resume.py` | Stage 1 | Scan feature folders, parse frontmatters, recommend new/resume/restart |
| `cs-readiness-check.py` | Stages 8, 9 | Run 8 mechanical readiness checks, output structured findings |
| `cs-generate-definitions.py` | Stage 10 | Emit a single `definitions.json` (conforming to `schemas/actor-definitions@1`) from `tasks.md`, `scenarios.gherkin`, `context.md` |

Each script's `--help` documents its full contract. Stage prompts invoke them by name.

## Failure output

When the workflow halts before Stage 10 completes successfully:

```
{
  "status": "failed",
  "task": "create-spec",
  "feature_id": "{FEATURE-ID}",
  "stage": "<stage name>",
  "reason": "<one-line reason>",
  "definitions_status": "ok|failed",
  "session_log": "<path>"
}
```

Exit non-zero in headless mode. Interactive: surface reason, offer `[r]etry` / `[d]ebug` / `[q]uit`.

## External skills

- `bmad-party-mode` — Stage 6
- `bmad-review` (edge-case-hunter lens) — Stage 7
- `bmad-review` (adversarial lens) — Stage 8
- `bmad-advanced-elicitation` — `--interactive` `[a]` checkpoints

## Reference data

- `references/coverage-categories.md` — mandatory baseline + optional category catalogue (used by Stage 5)
- `references/edge-case-categories.md` — 10-category framework for per-task test design (used by Stage 7)
- `references/schema-requirements.md` — `actor-definitions@1` schema reference (used by Stage 10 and `cs-generate-definitions.py`)
- `discover-inputs.md` — FULL_LOAD / SELECTIVE_LOAD / INDEX_GUIDED protocol (used by Stage 2)
- `template.md` — `spec.md` template (used by Stage 1)
- `checklist.md` — fresh-context Ready-for-Build validator (loaded by Stage 8)
