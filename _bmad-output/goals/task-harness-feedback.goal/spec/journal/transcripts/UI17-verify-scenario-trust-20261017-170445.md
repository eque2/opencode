# UI17 semantic verification

- Read: dispatch prompt, guardrails, skill, spec.md, scenarios.gherkin, tasks.md mapping, T4.8 journal, UI17 journal and test, LedgerView and Screen.
- Given: `refusal` runs the real task command and loader on a three-fault spec. The parsed status asserts `refused`, stopped/ended, no tasks, and exact R1/R3/R4 reason lines.
- When: `viewFor` drives the real view actor; `testRender` renders Ledger and three full-screen designs. The plugin also reads the written status file.
- Then Ledger: exact `run: refused`, three adjacent ordered rows, full lines at wide width, and error foreground for each line.
- Then full-screen: exact no-work sentence, all three full reason lines in order and error foreground in Board, Matrix and Gantt.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-UI17.spec.ts` in packages/opencode: 4 pass, 0 fail, 39 assertions.
- Verdict: one `state.mjs ... verdict UI17 trusted` through verification-runner; response trustLevel trusted. Query: state completed, trustLevel trusted. Gap: none.
