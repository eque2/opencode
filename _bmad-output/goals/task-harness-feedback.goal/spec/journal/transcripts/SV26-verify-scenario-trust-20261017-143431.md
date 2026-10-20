# SV26 semantic verification

- Read: dispatch prompt, guardrails, semantic skill, SV26 journal, state query, spec.md, scenarios.gherkin, tasks.md support lines, committed test, and current run supervisor, Recorder and command paths. Serena was unavailable, so file reads and text search identified the source paths.
- Given/When: tests inject an error in a task supervisor, run supervisor, and run actor. They drive real harness, Recorder and supervisor paths.
- Then unit error: exact `task.failed` reason for T1.1 and T1.2, one spawn each, no worker start, failed fold and released lease.
- Then run errors: job fiber completes for the run supervisor; logs, stable empty store and released lease are asserted. The run actor case awaits `RunSupervisor.supervise`, asserts an error snapshot, a rejected record, stable facts, log and release.
- Then corrupt slice: persisted facts resume under the healthy plan; a duplicate-id plan makes fold fail. `TaskCommand.sliceOf` selects `new`, logs the defect, and `headerParts` names the new run. A real `/task` cannot load that corrupt plan, so this last step uses the command seam.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-SV26.spec.ts` from `packages/opencode`: 4 pass, 0 fail, 49 assertions.
- One privileged command: `verification-runner.py -- node state.mjs ... verdict SV26 trusted --reason ...`: trustLevel trusted. Query: state completed, trustLevel trusted.
