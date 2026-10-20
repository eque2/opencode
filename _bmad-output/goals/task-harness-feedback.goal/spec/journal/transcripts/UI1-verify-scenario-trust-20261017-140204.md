# UI1 semantic verification

- Read: scenario, spec.md, tasks.md T4.2/T4.6, task journals, UI1 journal and test, store.ts, 3-board.tsx, state CLI query.
- Given: the test decodes eleven tasks whose tags cover waiting, active, trusted, dead, blocked and cancelled.
- When/Then: a real Board render asserts column headings, counts and IDs; `cardsIn` and `counts` agree. Active phases use DISPLAY only to choose their phase column.
- And STOPPED: Board and shared list assert dead, blocked, then the rest despite tree order.
- And selectors: counts and shortcut bar, focus, and next-running actor selection assert tag-driven outcomes. Renamed and contradictory state names check the classification boundary.
- And no lists: the TypeScript AST scan checks task-ui files and a negative control. The scan does not catch every possible object-based mapping, but inspected store and Board code use tags for classes and DISPLAY for presentation.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-UI1.spec.ts` in packages/opencode: 5 pass, 0 fail, 44 expect calls.
- Command: verification-runner wrapped `state.mjs ... verdict UI1 trusted --reason ...`: success, trustLevel trusted. Initial query state completed, trustLevel verified.
- Outcome: trusted; no material semantic gap.
