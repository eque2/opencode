# VF12 semantic verification

- Read: dispatch prompt, guardrails, semantic skill, VF12 journal and state query, spec.md, scenarios.gherkin, tasks.md support lines, committed test, unknown-after fixture, loader R6 and command refusal path. Serena was unavailable, so direct file reads showed the source.
- Given: seeded TASK.md names T7 in `after`; the test enumerates task folders and reads SPEC.md to prove that no task or outside declaration defines T7.
- When: two tests run the real `TaskCommand.run` on the spec and nested task folder.
- Then: exact reply includes R6 on T1.1's TASK.md and names T7. Status repeats the reason; no model turn, job or lease starts.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-VF12.spec.ts` from `packages/opencode`: 2 pass, 0 fail, 20 assertions.
- One privileged command: `verification-runner.py -- node state.mjs ... verdict VF12 trusted --reason ...`: trustLevel trusted. Query: state completed, trustLevel trusted. No gap.
