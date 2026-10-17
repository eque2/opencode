# VF21 semantic trust transcript

- Read: guardrails, skill, spec.md, scenarios.gherkin, tasks.md T3.4, VF21 journal and test, command and machine helpers, TaskEvents, TaskCommand.run/folderTrust.
- Given/When/Then: a real `/task trust T1.1` writes `outside.trusted` to the directory aggregate. The run aggregate stays empty. The real T1.3 subtree command returns the exact R12 refusal, starts no job, holds no lease, and records the status reason. A second case includes an untrusted stored slice after typed trust.
- Cancelled And: two real stored-slice variants fold an older T1.1 to trusted and a newer T1.1 to cancelled. Both refuse with R12 and no job. The older trusted slice alone starts a job.
- Legacy And: a stored run.started without path and a trusted T1.1 starts the subtree job with no R12. The no-path untrusted control refuses. The test asserts the stored path is absent.
- The command uses the real loader, event store, machine and harness. The job boundary only records starts.
- Run: `bun test --timeout=30000 ./test/task/verify-spec-VF21.spec.ts` in packages/opencode: 7 pass, 0 fail, 68 assertions.
- Verdict: one `verification-runner.py -- node state.mjs ... verdict VF21 trusted` call succeeded. CLI query: state completed, trustLevel trusted. No material coverage gap.
