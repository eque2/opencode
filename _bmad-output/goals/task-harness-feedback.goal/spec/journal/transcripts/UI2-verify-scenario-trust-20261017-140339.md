# UI2 semantic verification

- Read: scenario, spec.md, tasks.md T4.1/T4.3, task journals, UI2 journal and test, index.tsx, view.ts, actor.ts, state CLI query.
- Given/When: the real plugin starts on ses_root; simulated key chords switch design, select, expand, watch and press esc. Screen and SDK effects are asserted.
- Then: a *separate* `machineOver` actor receives synthetic events and its snapshot holds design, chosen task, expansion, watch target and stopKey. The test never reads the plugin actor's snapshot after real keys. A constructor text count cannot prove their connection.
- Disarm: the separate actor is armed at 4,999 ms and disarmed at 5,000 ms. The plugin's real-time second esc after 5.3 s warns again; this behavior passes.
- Cadences: delays and `after` rows are asserted, and separate `liveSessions`/`liveTail` readers are exercised on that actor. Their plugin installation and read path are not directly asserted.
- Invalid text: both plugin screen and separate actor retain the last good status. Gone file clears it.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-UI2.spec.ts` in packages/opencode: 4 pass, 0 fail, 81 expect calls.
- Command: verification-runner wrapped `state.mjs ... verdict UI2 rejected --reason ...`: success, trustLevel suspect. Initial query state completed, trustLevel verified.
- Outcome: rejected. D15 records the missing plugin-to-actor and reader linkage. No test or source edit.
