# UI19 semantic verification

- Read: dispatch prompt, guardrails, skill, spec.md, scenarios.gherkin, tasks.md mapping, T4.8 and UI19 journals, UI19 test, Ledger, Screen, Ticker, store and reasonLine source.
- Given: loaded plan and fact fold produce a done run tagged ended with exactly `not run: S13 waits on T8`; S13 waits on T8. The preceding status remains active.
- When/Then tone: captured Ledger and full-screen header spans contain that line in theme.textMuted and differ from error and warning.
- Then notification: endNotice returns none; wired registerTicker sends no host notice and no toast with the not-run line. Clean-done and stopped controls do notify.
- Then stopped tone: a projected stopped-tag run has multiple reasons; both Ledger and header show the reason in theme.error.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-UI19.spec.ts` in packages/opencode: 4 pass, 0 fail, 32 assertions.
- Verdict: one `state.mjs ... verdict UI19 trusted` through verification-runner; response trustLevel trusted. Query: state completed, trustLevel trusted. Gap: none.
