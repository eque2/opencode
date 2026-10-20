# UI21 semantic verification

- Read: dispatch prompt, guardrails, skill, spec.md, scenarios.gherkin, tasks.md mapping, UI21 journal and test, UI source, watch, Peek and shared-region source.
- Given: loaded plans and real fact folds project/write/decode W (idle wait on outside T9), X (exactly two stopped tasks; T1.5 cancelled without start), Z (zero stopped), and C (no scenarios). These conditions cannot occur in one run status.
- When/Then counts: seven real design surfaces render `4/6 trusted · 2 stopped` with theme.error on the stopped span; each clean render has `6/6 trusted` and no stopped text.
- Then watch: chooseWatch and WatchBand assert the full T9 outside sentence and trust command.
- Then Peek: its direct render and Board details render the exact no-builder-session sentence for unstarted T1.5.
- Then scenarios: expanded Board and Ledger render `SCENARIOS none in this run`; a populated run renders its count instead.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-UI21.spec.ts` in packages/opencode: 5 pass, 0 fail, 42 assertions.
- Verdict: one `state.mjs ... verdict UI21 trusted` through verification-runner; response trustLevel trusted. Query: state completed, trustLevel trusted. Gap: none.
