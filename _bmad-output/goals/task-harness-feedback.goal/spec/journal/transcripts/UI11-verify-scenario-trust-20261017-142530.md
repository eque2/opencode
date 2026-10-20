# UI11 semantic trust transcript

- Read the prompt, guardrails, UI11 journal, CLI query, Gherkin, tasks, test file and TUI `durationOf` source.
- Given: explicit-time facts fold through the real engine and status writer. Assertions check an active T1.2 with a start, ended T1.1 with both times, and unstarted T1.3.
- When: Board, Matrix, Gantt and HUD render through `viewFor` at two fresh live heartbeats; each view asserts live liveness.
- Then: T1.2 changes from 45s to 1h 4m. T1.1 remains 3m 12s. T1.3 has no duration and its columns stay blank.
- And: each task's Gantt right column, Matrix time column, Board card, HUD selected line and Peek heading are asserted at both reads.
- And: fixed literal forms are checked independently in `seen` against 45s, 3m 12s and 1h 4m.
- `bun test --timeout=30000 ./test/task/verify-spec-UI11.spec.ts` from `packages/opencode`: 2 pass, 0 fail, 82 assertions.
- One `verdict UI11 trusted` through `verification-runner.py`: query state completed, trustLevel trusted. No material gap.
