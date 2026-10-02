# Format 1 — one file per parent task

```
1-one-file-per-parent/
  T2-services.md      the parent, its six subtasks, the 26 scenarios they support, the gates, the policy (565 lines)
```

## Grammar

- YAML front matter is the parent task.
- Each `## T2.n — title` heading opens a subtask. Its first line carries bold labels — `After`, `Supports`,
  `Gates`, `Refs` — and a `Touches` list follows. Those are the machine fields.
- Inside a subtask, fixed `###` headings: `Goal`, `Approach`, `Preserve`, `Must not`, `Not in this task`,
  `Verify`.
- Under `Verify`, each list item starts with a case id in backticks (`T2.1.c4`) and a category in italics.
- `## Acceptance` holds the scenarios as fenced `gherkin` blocks; `## Gates` is a table with the commands;
  `## Verification policy` and `## References` close the file.
- Everything else is prose for the builder.

## Where verification lives

Next to the work, in each subtask's `### Verify`. The scenarios sit at the bottom of the same file.

## State

No state lives in these files: no status, no ticks, no counters. The engine keeps state elsewhere, keyed by the ids the files declare — `T2.1`, `T2.1.c4`, `S25`, `BUILD-2` — and by the content hash of the file version the state was produced against, so an edited task invalidates its old verdicts.

## Strengths

- One read gives an agent the whole phase, with no link-following.
- Closest to today's `tasks.md`, so migration is a mechanical rewrite.
- One diff reviews the whole phase.

## Weaknesses

- The file grows with the phase; this one is already 565 lines for six subtasks.
- Builder and verifier read the same text; nothing keeps the verifier's rubric apart.
- Bold labels and heading names are a fragile grammar: one renamed heading hides a field.
- A scenario that several phases support must be copied into each phase file, or the file stops being
  self-contained.
- Two people editing different subtasks still conflict in one file.
