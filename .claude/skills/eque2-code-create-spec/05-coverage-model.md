Language: {communication_language}
Output Language: {document_output_language}
Output Location: {feature_artifacts}/{FEATURE-ID}/

# Stage 5 — Coverage Model

**Progress: 5 of 10** — Next: Gherkin scenarios

**Produces:** `coverage.md` — Scenario Category Map + Coverage Checklist + Epistemic Assumptions.

## Verdict First

Decide WHAT must be tested before deciding HOW. The Category Map is the contract Stage 6 must satisfy. Iron rule: everything implemented needs a scenario to test it.

## Critical rules

- MUST NOT write any Gherkin in this stage.
- MUST be declarative and domain-oriented (no implementation details).
- MUST surface unknowns explicitly as assumptions.
- MUST output a checklist Stage 6 can mechanically satisfy.

## Inputs

- `{spec_file}` — Verification Intent, Scope
- `{context_file}` — actors / roles, data entities, integrations, environments, non-functional expectations
- `references/coverage-categories.md` — mandatory baseline + optional categories with coverage obligations

## Construct the Scenario Category Map

For each category include: name, why it matters for THIS feature, coverage obligation (minimum scenario count), sources, notes / assumptions.

Mandatory baseline (always present):

1. Build & Quality Gates (produces BUILD-1..4)
2. Delivery & Environment Promotion
3. Core Business Outcomes (from Verification Intent)
4. Negative Paths & Error Handling
5. Permissions & Access Control (if roles exist)
6. Data Integrity & Consistency (if data created / changed)
7. Auditability & Supportability (if regulated)
8. Operational Monitoring & Alertability
9. Performance Expectations (if SLA / volume implied)
10. Backwards Compatibility & Change Safety (if existing users impacted)

Add optional categories from `references/coverage-categories.md` where applicable (i18n, payments, migration, accessibility, multi-tenant, disaster recovery, concurrency, caching, observability).

## Handle epistemic gaps

For unknown dependencies, write **Assumption Options** (2-3 common patterns) with coverage obligations per option. Tag affected coverage rows with assumption IDs (`A1`, `A2`, …). Stage 6 will tag scenarios derived from these as `@ASSUMPTION:A<n>.<letter>`.

## Coverage Checklist

Format Stage 6 reads mechanically:

| Category | Min scenarios | Must include | Notes / assumptions |
|---|---|---|---|

## Write `coverage.md`

From `assets/templates/coverage-template.md`. Include: System Boundary Statement, Scenario Category Map, Epistemic Assumptions, Coverage Checklist.

## Frontmatter

Update `{spec_file}`: `stepsCompleted: [1, 2, 3, 4, 5]`.

## Exit

Stage complete when `{coverage_file}` exists with all three components. Advance to `06-gherkin.md`.

## Interactive checkpoint

```
Stage 5 complete — coverage.md written.
[a] Advanced Elicitation / [c] Continue / [p] Party Mode
```

Default mode auto-continues.

## Failure modes

- **Blocker:** a mandatory baseline category cannot be assessed (e.g. Permissions when role model unknown). Surface an Assumption Option rather than skipping.
- **Surface:** more than 3 categories require assumptions — note in session log; may indicate the requirement isn't ready for spec.
