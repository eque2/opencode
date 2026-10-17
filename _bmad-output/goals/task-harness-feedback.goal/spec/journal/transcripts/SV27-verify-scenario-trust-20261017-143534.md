# SV27 semantic verification

- Read: dispatch prompt, guardrails, semantic skill, SV27 journal, state query, spec.md, scenarios.gherkin, tasks.md support lines, committed test and job finalizer. Serena was unavailable, so direct file reads showed the code.
- Given: real `/task` resumes seeded facts. The test asserts two tasks building, their active actors and turns, and an S2 verifying actor and judge turn.
- When: the test closes the job-owned scope without cancellation and asserts the registry still says running.
- Then no stop or summary: compare pre/post facts; assert no cancelled, failed, verified or other failure facts, no summary, no extra turns and free lease.
- Then worker interruption: unchanged unit phases and attempts, no harness-error fact or further turn show no worker failure count.
- Then resume: a subsequent real `/task` on the same path records `run.resumed` first, one slice, no new `run.started`, and reused builder sessions.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-SV27.spec.ts` from `packages/opencode`: 1 pass, 0 fail, 32 assertions.
- One privileged command: `verification-runner.py -- node state.mjs ... verdict SV27 trusted --reason ...`: trustLevel trusted. Query: state completed, trustLevel trusted. No gap.
