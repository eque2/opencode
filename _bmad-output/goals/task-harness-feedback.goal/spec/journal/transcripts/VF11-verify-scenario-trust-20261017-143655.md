# VF11 semantic verification

- Read: dispatch prompt, guardrails, semantic skill, VF11 journal and state query, spec.md, scenarios.gherkin, tasks.md support lines, committed test, self-after fixture, loader R7 and command refusal path. Serena was unavailable, so direct file reads showed the source.
- Given: the test reads the seeded TASK.md files and asserts that T1.1 is after itself. The real loader yields one R7 cycle failure.
- When: two tests run the real `TaskCommand.run` on the spec and nested task folder.
- Then: exact reply includes the R7 path and `T1.1 → T1.1`; status contains the same reason. No model turn, job or lease starts.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-VF11.spec.ts` from `packages/opencode`: 2 pass, 0 fail, 18 assertions.
- One privileged command: `verification-runner.py -- node state.mjs ... verdict VF11 trusted --reason ...`: trustLevel trusted. Query: state completed, trustLevel trusted. No gap.
