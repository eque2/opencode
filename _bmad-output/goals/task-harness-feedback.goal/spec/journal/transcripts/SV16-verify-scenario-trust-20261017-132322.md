# SV16 semantic verification

- Read: dispatch prompt, guardrails, skill, spec.md, scenarios.gherkin, tasks.md T2.4, journal/scenario/SV16.md, journal/task/T2.4.md, committed scenario test, Recorder implementation.
- Given live run; When facts and heartbeat: the test runs the real run supervisor and Recorder with scripted hanging turns. It logs the real status write and touch boundaries.
- Every committed step, final included: stored facts are folded into distinct projections. `classify` requires one write for each projection in order and a final done write.
- Each heartbeat stamp: every write reads status.json back. The test checks aliveAt against the write clock, prior write and fact time.
- Last consumed snapshot: touch writes must equal the immediately prior projected status with a newer aliveAt. A burst interleaves records and touches.
- No write after done: the test requests another touch and record, waits beyond a heartbeat, and compares the write count and disk content.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-SV16.spec.ts` from packages/opencode: 2 pass, 0 fail, 136 assertions, 29.51 s.
- CLI: `verdict SV16 trusted` succeeded. `query scenario/SV16` reports state completed and trustLevel trusted. Gap: none.
