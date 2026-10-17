# UI23 independent semantic review

- Read: dispatch prompt, guardrails, scenario query, scenario journal, `scenarios.gherkin`, `spec.md`, T4.11 journal and scenario test.
- Given: `liveRun` resumes real stored facts through `/task`; lines 350–355 remove the root session while the run remains live. The second case uses the product's normal delete path.
- When: lines 356–358 cancel the job; lines 321–324 assert the last run fact is `run.cancelled`.
- Then log: lines 202–210 and 359–364 assert one closing-summary failure with `NotFound` from the runtime logger.
- Then closure: lines 310–329 assert the supervisor's `closed` snapshot, the ended background job and the absent directory lease.
- And next command: lines 297–303 and 334–343 show a busy control first, then a git-readiness refusal after release.
- Run: `bun test --timeout=30000 ./test/task/verify-spec-UI23.spec.ts` from `packages/opencode`: 2 pass, 0 fail, 37 assertions.
- Verdict: `verdict UI23 trusted` succeeded. CLI trustLevel: `trusted`; prior queried state: `completed`.
- Gap: the second deletion case does not assert the failed say. The first case covers the specified failure path.
