# RM22 semantic verification

- Read: guardrails, scenario Gherkin, spec.md, tasks.md, prior RM22 journal, committed `verify-spec-RM22.spec.ts`, `alphabet.ts`, the named guards in `machine.ts`, and the prior adapter run.json, JUnit and log. No evidence or keys read.
- Given a small plan / When the two walks run with and without blocked rows: two loaded examples and both real and row-removed configs execute through `getAdjacencyMap`.
- Then the same set of stuck states: gap. The real configs have empty stuck sets. The row-removed cascade yields 27 canonical and 39 full stuck keys. The test strips `dead:` and compares only unit configurations, then tests canonical raw keys as a subset. The first-death field is part of `walkKey` and feeds `firstDead`, so raw keyed stuck-state equality remains unproved.
- Stale walk: the unchanged prior full adapter run passed the opt-in test; it asserted no stuck keys and active/done statuses across 33,944 keys and 331,133 edges. No 99-minute repeat.
- Guard reads: wrappers cover all named guards in the generated machine. Tests compare per-source-state reads and aggregate paths with the main and stale key on three explored plans. Coverage is meaningful within those plans.
- Commands: `state.mjs ... query scenario/RM22` returned completed/verified. Short `bun test --timeout=30000 ./test/task/verify-spec-RM22.spec.ts` returned 6 pass, 1 opt-in skip, 0 fail. Prior full adapter metadata reported 7 pass, 0 skip. `state.mjs ... verdict RM22 rejected --reason ...` returned trustLevel suspect. Subsequent query returned state completed / trustLevel suspect.
- Outcome: rejected for the exact stuck-state equality gap. No test, source, state file or enforcement program changed directly.
