# `.catches.json` schema

Per-feature record of auto-applied findings from Party Mode, Edge-case Hunter, Adversarial Review, and the Fresh-context Checklist. Stage 10 reads this file to emit the "Catches Surfaced" section in the completion output.

## Versioned envelope

```json
{
  "schema_version": "1",
  "entries": [ <entry>, <entry>, ... ]
}
```

- `schema_version` — string. Current: `"1"`. Bump when the entry shape changes incompatibly.
- `entries` — append-only list of entry objects, in chronological order.

## Entry shape

Every entry MUST include:

| Field | Type | Required | Notes |
|---|---|---|---|
| `skill` | string | yes | The skill that produced the catch (e.g. `bmad-party-mode`, `bmad-review`, `fresh-context-checklist`). |
| `stage` | integer | yes | The Create-Spec stage that auto-invoked the skill (6, 7, or 8). |
| `rationale` | string | recommended | One-line explanation of why the catch was applied. |

Stage-specific arrays (any subset, depending on what the skill did):

| Field | Type | Used by |
|---|---|---|
| `added_scenarios` | array of strings (scenario IDs) | Stage 6 Party Mode, Stage 7 Edge-case Hunter |
| `modified_coverage_categories` | array of strings | Stage 6 Party Mode |
| `added_test_cases` | array of `{task, category, case}` objects | Stage 7 Edge-case Hunter |
| `applied` | array of `{file, severity, summary}` objects | Stage 8 Adversarial Review, Stage 8 Checklist |

Unknown fields are preserved verbatim — entries are append-only and the appender does not strip data it does not recognise.

## Example

```json
{
  "schema_version": "1",
  "entries": [
    {
      "skill": "bmad-party-mode",
      "stage": 6,
      "added_scenarios": ["S5", "S6"],
      "modified_coverage_categories": ["Permissions"],
      "rationale": "Party Mode flagged missing admin-impersonation paths."
    },
    {
      "skill": "bmad-review",
      "stage": 7,
      "added_test_cases": [
        {"task": "T2.3", "category": "Concurrency", "case": "Two writers race on the same key."}
      ],
      "added_scenarios": [],
      "rationale": "Walking the 10-category framework surfaced concurrency gap."
    }
  ]
}
```

## How `cs-append-catches.py` uses it

- If `.catches.json` does not exist: create with `schema_version: "1"` and a single-element `entries` list.
- If it exists and parses: validate `schema_version == "1"`, then append the new entry to `entries`.
- If parse fails or `schema_version` does not match: rotate the broken file to `.catches.json.broken-<unix-ts>` and start fresh with the incoming entry. The output signals `status: "rotated"` so the caller can log it.

## Migration path

When `schema_version` bumps to `"2"`:

1. Ship a one-shot migration step in the appender — read v1, transform entries, write v2.
2. Bump the constant in `cs-append-catches.py` and update this doc.
3. Keep the rotation fallback — any unreadable older file still rotates rather than silently dropping data.
