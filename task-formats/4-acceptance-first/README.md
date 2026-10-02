# Format 4 — acceptance first

```
4-acceptance-first/
  outcomes/S3.md … S59.md     one file per scenario: the Gherkin, what it needs, how it is proved
  work/T2.md                  the parent work package
  work/T2.1.md … T2.6.md      thin work packages: goal, changes, rules, unit cases
  gates.md · policy.md · refs.md
```

## The inversion

In the other formats a task says which scenarios it supports. Here the outcome says which work it needs
(`needs:`), and work packages do not list outcomes at all. Each edge is declared once, on the outcome side, so
the two directions cannot disagree — the drift that broke `definitions.json` in the source
(T2.2 lost S57 and S59; T2.6 lost S58).

The engine derives the rest:

- `moves(T2.2)` = every outcome whose `needs` names T2.2;
- an outcome is ready to judge when all of its `needs` are trusted;
- a work package matters while any outcome it moves is unproved.

## Grammar

- `outcomes/<id>.md`: YAML front matter (`outcome`, `tags`, `category`, `needs`, `proof`, optional
  `environment`), then one fenced `gherkin` block. Prose after it is guidance for the verifier.
- `work/<id>.md`: YAML front matter (`work`, `parent`, `after`, `touches`, `gates`, `refs`), then `Goal`,
  `Approach`, rules, `Change detail`, `Unit cases`, `Weak proofs to reject`.

## Where verification lives

Two levels, kept apart. Outcomes are the primary verification and live on their own. Unit cases stay with the
work because they belong to exactly one task.

## State

No state lives in these files: no status, no ticks, no counters. The engine keeps state elsewhere, keyed by the ids the files declare — `T2.1`, `T2.1.c4`, `S25`, `BUILD-2` — and by the content hash of the file version the state was produced against, so an edited task invalidates its old verdicts.

## Strengths

- Traceability is native: open an outcome and see every task it waits for, across phases (S18 waits on
  T1.5, T2.2, T3.2 and T4.1).
- Many-to-many is handled once, without copies.
- Planning can start from outcomes and add work until each one is covered.

## Weaknesses

- A builder must follow links to learn which outcomes its work feeds (the engine can render that view).
- Outcomes that span phases (S57 needs T1.2, T2.2 and T3.2) make "is T2 done?" a computed answer rather than a
  file you can read.
- Two kinds of verification (unit cases and outcomes) to explain to every new contributor.
