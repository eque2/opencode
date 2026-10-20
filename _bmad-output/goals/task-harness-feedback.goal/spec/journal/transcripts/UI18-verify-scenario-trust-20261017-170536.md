# UI18 semantic verification

- Read: dispatch prompt, guardrails, skill, spec.md, scenarios.gherkin, tasks.md mapping, T4.8 and UI18 journals, UI18 test, Matrix and Ticker source, blocked display references.
- Given: observed facts use the real engine, status projection and writer, then the task-ui decoder. Assertions confirm blocked T1/T1.5 and S1, their cause and tags.
- When/Then glyph and tone: all seven real designs render `⊖ T1.5` and `⊖ S1`; captured spans assert theme.warning. The blocked display entry and waiting's distinct glyph are asserted.
- Matrix: its rendered legend equals the full expected line ending `⊖ blocked`.
- Ticker: before/after statuses differ at the final proof; assertions confirm a gained blocked tag, exact reason-bearing warning toasts, and their delivery by registerTicker through the host.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-UI18.spec.ts` in packages/opencode: 4 pass, 0 fail, 58 assertions.
- Verdict: one `state.mjs ... verdict UI18 trusted` through verification-runner; response trustLevel trusted. Query: state completed, trustLevel trusted. Gap: none.
