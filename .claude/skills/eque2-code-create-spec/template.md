---
title: "{FEATURE-TITLE}"
specSlug: "{FEATURE-ID}"
stepsCompleted: [1]
coverage_validated: false
edge_cases_researched: false
status: in-progress
created: "{DATE}"
mode: "{MODE}"
ticket_url: "{TICKET_URL}"
---

# Feature: {FEATURE-TITLE}

## Problem Statement

{What problem does this feature solve? Who is affected? Pulled from the Jira ticket in Jira mode; elicited from the user in spec mode.}

## Scope

**Exhaustive by default.** Everything the ticket / user prose implies is IN scope. Do not volunteer exclusions to keep the spec small — a smaller-looking spec that silently drops work is the failure mode this rule exists to prevent.

### In Scope
{Bulleted list of what this feature includes. Specific behaviours, files, integrations. When in doubt: include, not exclude.}

### Out of Scope
{**EMPTY by default.** Only populated when the workflow was HALTED and the user explicitly approved carving something out — typically because of a hard external blocker (unavailable test environment, missing credentials, embargoed dependency, contradiction with a resolved decision on record). Each entry MUST name the blocker and cite the halt.

Absent a recorded halt-and-approve, this section stays empty. "Feels adjacent", "seems like scope creep", "we can do this later", "nice to have" are NOT acceptable reasons.}

## Verification Intent

{How will we know this feature is complete and correct? What evidence is required?

This is the seed for the Feature Behaviour scenarios (S1, S2, ...) generated in Stage 6. Be specific about observable outcomes — what state changes, what user-visible behaviours, what system effects.}

## Source

### Jira mode
- **Ticket:** {TICKET-KEY} — {ticket title}
- **URL:** {ticket URL}
- **Acceptance Criteria:** see `jira/ticket.md`
- **Related tickets:** see `jira/related-tickets.json`

### Spec mode
- **Input:** user prose, captured during Stage 2 elicitation
- **Verification Intent:** as stated above

## Linked Artifacts

| Artifact | Path | Stage produced |
|----------|------|----------------|
| Technical context | `context.md` | 3 (refined by 4) |
| Coverage model | `coverage.md` | 5 |
| Gherkin scenarios | `scenarios.gherkin` | 6 (refined by Party Mode auto-invocation) |
| Implementation tasks | `tasks.md` | 7 (refined by edge-case-hunter auto-invocation) |
| Metadata | `metadata.json` | 10 |
| State snapshots | `state/` | 10 |

## Notes

{Any cross-stage notes the dev agent or future-Linus should see at the top of the spec.}
