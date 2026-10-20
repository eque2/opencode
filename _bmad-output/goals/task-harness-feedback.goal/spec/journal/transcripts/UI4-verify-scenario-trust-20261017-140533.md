# UI4 semantic verification

- Read: scenario, spec.md, tasks.md T4.7, task journal, UI4 journal and test, state CLI query.
- Given/When: decoded statuses with spans render through the real GanttView over a real taskView actor; the test reads full lanes and captured colours.
- Then: full lane strings distinguish midpoint inclusion at 30.4 and 30.6 seconds, a brief span with no midpoint, blank cells before and after spans, and a task with no spans.
- And open spans: live draws through now; still draws through the heartbeat; ended draws through endedAt. The axis and lane strings are asserted.
- And final states: zero-length finals draw one cell. The blocked lane has exactly one █ and its colour equals the warning theme.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-UI4.spec.ts` in packages/opencode: 3 pass, 0 fail, 31 expect calls.
- Command: verification-runner wrapped `state.mjs ... verdict UI4 trusted --reason ...`: success, trustLevel trusted. Initial query state completed, trustLevel verified.
- Outcome: trusted; no semantic gap.
