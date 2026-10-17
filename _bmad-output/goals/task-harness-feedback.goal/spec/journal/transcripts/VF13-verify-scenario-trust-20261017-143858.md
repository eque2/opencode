# VF13 semantic verification

- Read: dispatch prompt, guardrails, semantic skill, VF13 journal and state query, spec.md, scenarios.gherkin, tasks.md support lines, committed test, no-ensures fixture, required schema field and command refusal path. Serena was unavailable, so direct file reads showed the source.
- Given: the test enumerates seeded VERIFY.md files and asserts only T1.2's leaf file lacks `ensures`. The real loader yields only its R3 failure.
- When: two tests run the real `TaskCommand.run` on the spec and a nested task folder.
- Then: exact reply includes R3 for the leaf VERIFY.md and names the missing key. Status repeats the reason; no model turn, job or lease starts.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-VF13.spec.ts` from `packages/opencode`: 2 pass, 0 fail, 19 assertions.
- One privileged command: `verification-runner.py -- node state.mjs ... verdict VF13 trusted --reason ...`: trustLevel trusted. Query: state completed, trustLevel trusted. No gap.
