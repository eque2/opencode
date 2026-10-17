# UI24 independent semantic review

- Read: dispatch prompt, guardrails, scenario query, scenario journal, `scenarios.gherkin`, `spec.md`, T2.10/T2.11/T4.11 journals, scenario test, supervisor source and SV21 test.
- Given: lines 218–250 use a real permission request to hold the root turn while the run continues.
- When: lines 250–263 fold stored facts and assert a final `done` run.
- Then lease order: lines 264–278 wait for the free lease, then read a done status file, a running job, no summary and a pending permission request. The file read happens too late to establish write-before-release. A fast write after release could pass. SV21 separately observes a writer-ended state at release, but this scenario does not do so during its pending summary.
- And next command: lines 280–287 assert the second `/task` reaches git readiness instead of the busy refusal.
- And summary: lines 289–323 assert one summary after the reply, or one failure log when the root is deleted.
- Run: `bun test --timeout=30000 ./test/task/verify-spec-UI24.spec.ts` from `packages/opencode`: 2 pass, 0 fail, 37 assertions.
- Verdict: `verdict UI24 rejected` succeeded. CLI trustLevel: `suspect`; prior queried state: `completed`.
- Gap: observe the done status and ended writer at the release boundary in this permission-wait run.
