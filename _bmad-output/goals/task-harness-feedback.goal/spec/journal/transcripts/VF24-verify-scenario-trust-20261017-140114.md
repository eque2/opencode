# VF24 semantic verification

- Read: dispatch, guardrails, spec.md, scenarios.gherkin, tasks.md T3.4, its journal, VF24 journal and test, command helper, state CLI query.
- Given: `given` commits a T1.2 folder rename, checks the old path is absent, and folds T1.1 to trusted in a whole-spec slice.
- When: `runT13` stores ordered slices and invokes the real `TaskCommand.run` on the T1.3 folder.
- Then: three order tests assert a job starts for the newer trusted deciding slice, including an older conflicting slice and a newer slice without T1.1.
- And: two refusal tests assert the exact single plain reason line, the unloadable path, no job, and no new fact when the unloadable slice is newer. Direct `folderTrust` assertions cover all orders.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-VF24.spec.ts` in packages/opencode: 6 pass, 0 fail, 96 expect calls.
- Command: verification-runner wrapped `state.mjs ... verdict VF24 trusted --reason ...`: success, trustLevel trusted. Initial query state completed, trustLevel verified.
- Outcome: trusted. No semantic gap found. The job registry records a start but does not execute the background job; this matches the scenario's run-start claim.
