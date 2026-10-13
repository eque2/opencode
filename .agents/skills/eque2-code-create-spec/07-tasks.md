Language: {communication_language}
Output Language: {document_output_language}
Output Location: {feature_artifacts}/{FEATURE-ID}/

# Stage 7 — Tasks + per-task tests

**Progress: 7 of 10** — Next: Review and validate readiness

**Produces:** `tasks.md` — dependency-ordered phases of tasks, every task linking to scenarios and carrying a test specification.

## Verdict First

Scenarios drive task design. Each task supports one or more scenarios. Tests must be exhaustive across the relevant edge-case categories. Output is the dev agent's master implementation guide.

## Inputs

- `{scenarios_file}` — scenarios to support
- `{context_file}` — UPDATE/NEW files, coding-standards constraints, resolved `{TEST_DIR}`
- `references/edge-case-categories.md` — 10-category framework for test design

## Generate tasks — required fields

Each task MUST include:

| Field | Content |
|---|---|
| **Task ID** | `T1`, `T1.1` for subtasks |
| **Action** | Concrete verb + target ("Add idempotency guard to webhook handler") |
| **File** | Exact path. Tag UPDATE or NEW |
| **Depends On** | Comma-separated task IDs that must finish first, or `—` for a leaf with no deps. **Mandatory on every task** — this is what populates `dependsOn` in `definitions.json` so the engine can sequence phases. Without it the dependency graph is flat and the state CLI's `next` verb (`node {skills-root}/eque2-code-setup/scripts/state.mjs $SPEC_FOLDER next`) cannot order the work. |
| **Tests** | **ONE line:** `{TEST_DIR}/verify-{FEATURE-ID}-{scenario-id}.spec.ts` optionally followed by a single test-name pattern, or the literal sentinel `(full suite)` to run the whole file. `{FEATURE-ID}` is the feature slug: it must be non-empty and use only `A-Z a-z 0-9 _ . -` (no spaces or other characters), or the reporter cannot route the file. `{scenario-id}` is the scenario's own id exactly as declared (any id in the shared grammar — see `06-gherkin.md` § Scenario id grammar, e.g. `DELIVERY-2`); the reporter routes evidence by it, and `state.mjs init` refuses a testFile whose name routes to a different id. **Never** put markdown (`**`, headers) on this line and **never** merge the `Test Cases` list into it — that produces a malformed pattern like `(full suite)**Test Cases:**` that the verifier cannot grep. |
| **Test Cases** | Explicit list spanning relevant edge-case categories — a **separate** section/block, kept off the single-line `Tests` field above. |
| **Supports** | Scenario IDs this task enables (e.g. `Supports: S1, S3, BUILD-4, DELIVERY-2`) |
| **Notes** | Implementation details, applicable coding standards from Stage 3 |

## Edge-case test design — the 10 categories

For every task touching SDK / framework / library code, walk the 10 categories in `references/edge-case-categories.md`:

Happy Path, Invalid Input, Boundary, Empty / Null / Undefined, Error Propagation, Concurrency, State Transitions, Resource Limits, Security Boundaries, Timing.

For each category: does it apply? If yes, what's the specific test? Don't say "test error handling" — name the specific case.

Research-driven discovery:

1. Read official documentation for the relevant SDK / library
2. Identify error conditions, limits, boundary behaviours
3. Document specific test cases per discovered edge case
4. Cite source for non-obvious cases (URL in task Notes)

## Phase ordering

Group tasks into dependency-ordered phases:

- Phase 1: foundations (types, schemas, constants)
- Phase 2: services / repositories
- Phase 3: endpoints / UI / handlers
- Phase 4+: integration, migration, cleanup

Within a phase, order subtasks by dependency. **Phase IDs are STRINGS in metadata** (`"1"`, not `1`).

## Inline coding-standards constraints

For each task, check the constraints captured by Stage 3 keyed by phase. Inline applicable ones into the task's Notes (e.g. "Coding standard COD-014 requires structured logging for all webhook outcomes").

## Write `tasks.md`

From `assets/templates/tasks-template.md`.

## Frontmatter

Update `{spec_file}`: `stepsCompleted: [1, 2, 3, 4, 5, 6, 7]`, `edge_cases_researched: true`.

## Auto-invocation — Edge-case Hunter (default mode, after writing tasks)

Suppressed when `--no-edge-cases`, `--yolo`, or `--interactive`.

```
SKILL: bmad-review (lenses=edge-case-hunter)
PROMPT: Method-driven branch/boundary walk over tasks.md and scenarios.gherkin
        for feature {FEATURE-ID}. Surface uncovered edge cases — paths that
        should exist as test cases but don't. Findings auto-applied to
        tasks.md (and scenarios.gherkin if a missing scenario is identified).
```

On findings:

- For each missing test case, add it to the relevant task's Test Cases section
- For each missing scenario, add it to `scenarios.gherkin`, update `coverage.md` if a new category was implied, regenerate task supports as needed
- Re-emit affected files. Append "edge-case-hunter findings applied" + summary to session log.

## Catches surfaced

If Edge-case Hunter added test cases or scenarios, record via `cs-append-catches.py`. Do NOT hand-roll the JSON-append.

```
uv run scripts/cs-append-catches.py {feature_root} --skill bmad-review --stage 7 --entry '{"added_test_cases": [{"task": "T2.3", "category": "Concurrency", "case": "..."}], "added_scenarios": [...], "rationale": "<one-line>"}'
```

The script writes the versioned envelope at `{feature_root}/.catches.json`. See `references/catches-schema.md`. Skip when Edge-case Hunter applied no changes.

## Exit

Stage complete when `{tasks_file}` exists, every task has Depends On + Supports + Tests + Test Cases (Tests on a single markdown-free line), and (default mode) edge-case-hunter findings are applied. Advance to `08-review.md`.

## Interactive checkpoint

```
Stage 7 complete — tasks.md written.
[a] Advanced Elicitation / [c] Continue / [e] Edge-case Hunter / [p] Party Mode
```

Default mode auto-continues (after auto-invocation).

## Failure modes

- **Retry candidate:** edge-case-hunter times out / stalls. Kill, log as "edge-case-hunter skipped (timeout)", continue. Stage 8's adversarial review + checklist will partially compensate.
- **Surface:** edge-case-hunter findings introduce scenarios that violate Stage 5's coverage contract — apply, regenerate coverage row, re-validate.
