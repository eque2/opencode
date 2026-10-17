# SV23 semantic verification

Read the dispatch prompt, guardrails, semantic skill, spec.md, scenarios.gherkin, tasks.md mapping, T2.8 summary, scenario test, and CLI query. The query returned state completed, trustLevel verified.

- Given: a real run and task supervisor prompt T1.1; a bus tool-part update moves its turn from watching to tool. Silent T1.2 remains a control.
- When: the SimulatedClock moves 10 seconds beyond the 2-second idle bound; T1.2 records a stall.
- Then: T1.1 has no stall fact, no cancel, and no repeated prompt; its turn stays in tool.
- And: the completed tool update restores watching. At 1.9 seconds there is no stall; at 2.1 seconds one exact stall fact appears, then the turn cancels and continues.

`bun test --timeout=30000 ./test/task/verify-spec-SV23.spec.ts` in packages/opencode: 1 pass, 0 fail, 12 expect calls. One `verdict SV23 trusted` through verification-runner and the state CLI returned trustLevel trusted. No semantic gap found. No evidence or keys read; no test or source changed.
