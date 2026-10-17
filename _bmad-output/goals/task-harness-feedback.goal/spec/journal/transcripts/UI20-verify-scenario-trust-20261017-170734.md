# UI20 semantic verification

- Read: dispatch prompt, guardrails, skill, spec.md, scenarios.gherkin, tasks.md mapping, T4.11 and UI20 journals, UI20 test, TaskSummary and TaskWorkers summary source.
- Given: fact lists restore final snapshots through the real Recorder. Assertions distinguish cancel without dead work, cancel after dead work, dead without stop, all-trusted tasks with rejected S4, parked S13, and the T1.2 subtree.
- When: each case calls the real TaskWorkers.summary; only the `say` boundary captures its message.
- Then outcome: exact first lines assert `cancelled: user stop`, two `budget exhausted` variants, `failed: acceptance not proved`, and `done · 1 scenario not run`.
- Then subtree: exact subject contains T1.2 id/title, `from spec`, and the loaded spec title.
- Then warning: failed and clean spec.checked facts assert warned true and the warning line before the task table; the no-failure control omits it.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-UI20.spec.ts` in packages/opencode: 6 pass, 0 fail, 45 assertions.
- Verdict: one `state.mjs ... verdict UI20 trusted` through verification-runner; response trustLevel trusted. Query: state completed, trustLevel trusted. Gap: none.
