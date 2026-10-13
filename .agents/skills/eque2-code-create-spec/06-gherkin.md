Language: {communication_language}
Output Language: {document_output_language}
Output Location: {feature_artifacts}/{FEATURE-ID}/

# Stage 6 — Gherkin scenarios

**Progress: 6 of 10** — Next: Tasks + per-task tests

**Produces:** `scenarios.gherkin` satisfying the Coverage Checklist from Stage 5.

## Verdict First

This stage SATISFIES the coverage contract from Stage 5. It does NOT decide coverage. Stage 5 decided what categories must be tested; Stage 6 writes scenarios to satisfy them.

## Hard dependency

STOP if `{coverage_file}` does not contain all three components (Category Map, Coverage Checklist, Epistemic Assumptions). Re-run Stage 5.

## Style rules

Load Gherkin style rules from `{project-root}/_bmad/eque2-code/docs/gherkin.md` if present. Fallback principles:

- Declarative ONLY (WHAT not HOW)
- Business language ONLY (no UI / technical jargon)
- One behaviour per scenario
- 3-7 steps per scenario (max 10)

## Generate scenarios for EVERY category

- **Build Verification:** BUILD-1 (typecheck), BUILD-2 (lint), BUILD-3 (build), BUILD-4 (unit tests). Always present.
- **BUILD-5:** Figma compliance — present only if `{feature_root}/figma/` exists or spec references Figma assets.
- **Feature Behaviour:** S1, S2, … derived from Verification Intent and the Coverage Checklist's Core Business Outcomes row.
- **Delivery, Operational Monitoring, Performance, Backwards Compatibility** — as defined by coverage model.

## Scenario id grammar

Every scenario id MUST match the one shared grammar: `[A-Z]+-?\d+(?:-[A-Z]+)*(?:\.\d+)?[a-z]?` — an uppercase letter prefix, an optional hyphen, digits, optional `-UPPER` segments, an optional `.digits` suffix, and an optional lowercase letter. Examples: `S1`, `S14b`, `AU3`, `MG12b`, `DELIVERY-2`, `BUILD-1`, `C3.1`, `C4-RESET.1`. Any prefix is allowed; `delivery-2`, `S_1`, and `FEATURE` (no digits) are not.

Write the id as the first token after `Scenario:` (e.g. `Scenario: DELIVERY-2 — a log entry arrives`). In this repo, the shipped schema `{skills-root}/eque2-code-setup/schemas/actor-definitions.v1.schema.json` carries the grammar as the `pattern` of a scenario id. That schema is generated from the grammar's single source in the eque2-code module (the `SCENARIO_ID_SOURCE` constant), and the same source is built into the scenario reporter and `state.mjs`. The reporter routes evidence with it, `state.mjs init` refuses ids outside it, and `cs-generate-definitions.py` / `cs-readiness-check.py` read it from the shipped schema, so an id that breaks it fails here, at spec time — not after the build.

## Assumption tagging

Tag assumption-based scenarios with `@ASSUMPTION:<id>` (e.g. `@ASSUMPTION:A1.b`) and reference the Assumption Option from `coverage.md`.

## Mechanical coverage validation (run before exiting the stage)

For each row in the Coverage Checklist:

- Minimum scenario count met
- Required types (happy / error / edge) present
- Assumption scenarios tagged

If any gap: write the missing scenarios before exiting the stage.

## Write `scenarios.gherkin`

From `assets/templates/scenarios-template.gherkin`.

## Frontmatter

Update `{spec_file}`: `stepsCompleted: [1, 2, 3, 4, 5, 6]`, `coverage_validated: true`.

## Auto-invocation — Party Mode (default mode, after writing scenarios)

Suppressed when `--no-party`, `--yolo`, or `--interactive`.

```
SKILL: bmad-party-mode
PROMPT: Review the spec content of feature {FEATURE-ID}: spec.md, context.md,
        coverage.md, scenarios.gherkin. Find gaps, missed perspectives,
        additional scenarios worth including. Findings auto-applied. Focus on
        adding what's missing, not rewriting what's there.
```

On findings:

- Apply each suggested addition / change to the affected file(s).
- If scenarios changed: re-run mechanical coverage validation. If categories now have minimum-count gaps, write the missing scenarios. Set `coverage_validated: false`, then re-validate and set `true` once satisfied.
- Re-emit affected files. Append "Party Mode findings applied" + summary to session log.

## Catches surfaced

If Party Mode added scenarios or modified coverage, record them via `cs-append-catches.py`. Do NOT hand-roll the JSON-append — the script enforces the schema and handles concurrent / corrupt-file edge cases.

```
uv run scripts/cs-append-catches.py {feature_root} --skill bmad-party-mode --stage 6 --entry '{"added_scenarios": ["S5", "S6"], "modified_coverage_categories": ["Permissions"], "rationale": "<one-line>"}'
```

The script writes to `{feature_root}/.catches.json` using the versioned envelope documented in `references/catches-schema.md`. Stage 10 reads the file to emit the "Catches Surfaced" section.

Skip this step entirely when Party Mode applied no changes — a clean run produces no entry.

## Exit

Stage complete when `{scenarios_file}` exists, mechanical coverage validates, and (default mode) Party Mode findings are applied. Advance to `07-tasks.md`.

## Interactive checkpoint

```
Stage 6 complete — scenarios.gherkin written.
[a] Advanced Elicitation / [c] Continue / [p] Party Mode
```

Default mode auto-continues (after auto-invocation).

## Failure modes

- **Retry candidate:** Party Mode times out / stalls. Kill, log as "Party Mode skipped (timeout)", continue. Do not block the workflow on an optional review.
- **Surface:** Party Mode's findings would invalidate Stage 5 coverage (e.g. requires a new category) — apply, set `coverage_validated: false`, regenerate coverage row, re-validate.
