---
name: figma-compliance-review
description: Autonomous Figma-to-implementation compliance review with three-layer verification and auto-fix. Dispatched from review-task when the spec references Figma data.
---

# Figma Compliance Review

Perform autonomous visual compliance review of implemented components against Figma design data using a three-layer verification approach: (1) screenshot comparison for visual gut-check, (2) structural/positional verification against Figma's node tree, (3) property-level CSS measurement. Identifies discrepancies at all layers, auto-fixes them using design tokens, and verifies fixes through re-measurement.

Figma is the absolute source of truth. If implementation doesn't match, the implementation is wrong.

## Conventions

- Bare paths resolve from this workflow's root.
- `{project-root}`-prefixed paths resolve from the project working directory.

## Input parameters

Received from `review-task`:

- `spec_folder` — absolute path to the feature folder
- `task_id` — task identifier that was just reviewed
- `task_description` — brief description of what was implemented
- `files_changed` — list of files modified during build
- `slug` — URL-safe feature name

## Critical rules

1. **Figma is source of truth** — expected values from `node-data.json`, never from implementation code.
2. **Structural before properties** — fix layout before individual CSS properties.
3. **Screenshots are mandatory** — capture implementation screenshot; reference Figma screenshot path.
4. **Token discipline** — never use inline literal values; always use or create design tokens.
5. **Bounded fix cycles** — maximum 2 fix-measure cycles.
6. **No user interaction** — always headless.

## Stages

| # | Stage | Purpose |
|---|-------|---------|
| 1 | Context | Parse inputs, load Figma data, build element mapping | `01-context.md` |
| 2 | Measure | Three-layer verification (screenshot, structural, properties) | `02-measure.md` |
| 3 | Fix | Fix structural then property discrepancies, re-measure | `03-fix.md` |
| 4 | Report | Write journal entry, output exit status | `04-report.md` |

If Stage 2 finds zero discrepancies, skip Stage 3 and proceed directly to Stage 4.

## Shared reference

Load `{project-root}/_bmad/eque2-code/data/figma-standards.md` during Stage 1 for:
- Section 1: Token System (locations, dedup rules, placement)
- Section 2: CSS Architecture (Figma-to-CSS mappings)
- Section 3: Measurement Tolerances
- Section 4: Structural Verification Standards
- Section 5: Screenshot Comparison Standards

## Exit states

- `FIGMA_REVIEW_COMPLETE` — all discrepancies fixed or documented
- `FIGMA_REVIEW_COMPLETE -- WARNING: {n} structural discrepancy(ies) remain unfixed`
- `FIGMA_REVIEW_FAILED: {reason}` — critical failure (no Figma data, app not reachable)

The exit status string is returned to `review-task`.
