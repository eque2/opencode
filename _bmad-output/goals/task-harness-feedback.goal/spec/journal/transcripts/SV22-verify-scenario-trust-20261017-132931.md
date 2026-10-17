# SV22 semantic verification

Read the dispatch prompt, guardrails, semantic skill, spec.md, scenarios.gherkin, tasks.md mapping, T2.8 summary, scenario test, and CLI query. The query returned state completed, trustLevel verified.

- Given: loaded plan asserts T1.1 and T1.2 have no dependencies; the real run supervisor spawns both building task supervisors and prompts their separate sessions.
- When: SimulatedClock moves 30 seconds, T1.2's turn ends and is nudged, then the clock moves to T1.1's 60-second deadline.
- Then: exact stored task.failed for T1.1 with wall-clock reason, actor fold, dependent block, and sole T1.1 cancellation are asserted.
- And: T1.2 stays building, owns a live supervisor, receives no cancel or failure through 89 seconds, and fails only at its 90-second deadline.

`bun test --timeout=30000 ./test/task/verify-spec-SV22.spec.ts` in packages/opencode: 1 pass, 0 fail, 23 expect calls. One `verdict SV22 trusted` through verification-runner and the state CLI returned trustLevel trusted. No semantic gap found. No evidence or keys read; no test or source changed.
