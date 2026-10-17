# SV19 semantic verification

- Read: dispatch prompt, guardrails, skill, spec.md, scenarios.gherkin, tasks.md T2.13/T4.13, their journals, SV19 journal, committed test, state audit and spine AD-17.
- Given phase-2 end and goal end: the test archives the last phase-2 commit and copies the current tree. It runs the audit in each copy and dumps the audit's own entries and findings.
- When compared with the spine: the test parses and pins the eight AD-17 rows. It checks FactSchema's two separate literal schemas and the conditional mergeRetry row.
- Phase-2 harness result: exact key set and count match the final harness keys; no harness entry is interim or without a reason. The audit passes on that tree.
- Current whole-tree result: exact key set and count match the final spine list; findings match; all reasons exist; no interim marker or former interim key remains. The audit passes.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-SV19.spec.ts` from packages/opencode: 3 pass, 0 fail, 38 assertions, 11.06 s.
- CLI: `verdict SV19 trusted` succeeded. `query scenario/SV19` reports state completed and trustLevel trusted. Gap: none.
