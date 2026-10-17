# VF20 semantic trust transcript

- Read: guardrails, skill, spec.md, scenarios.gherkin, tasks.md T3.4, VF20 journal and test, command helper, machine fact helper, TaskEvents slicing, TaskCommand.run/folderTrust.
- Given: the seeded release-notes spec loads with T1.3 after T1.1. The whole plan folds the older facts to T1.1 trusted and the newer facts to T1.1 budget_exhausted. The durable event store returns two slices in that order.
- When: the real command runs on the T1.3 subtree. The plan has T1.1 as external, not an outside precondition.
- Then: the reply equals the counted header, exact R12 line naming both ids, and T1.1 hint. The test asserts no job, lease, new fact or worktree, and the status reason equals R12.
- Negative controls: reversing slice order starts a job and gives no R12; the exhausted slice alone refuses. These distinguish latest from historical or aggregate trust.
- Run: `bun test --timeout=30000 ./test/task/verify-spec-VF20.spec.ts` in packages/opencode: 3 pass, 0 fail, 50 assertions.
- Verdict: one `verification-runner.py -- node state.mjs ... verdict VF20 trusted` call succeeded. CLI query: state completed, trustLevel trusted. No material coverage gap.
