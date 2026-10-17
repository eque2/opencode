# UI2 independent semantic verification — 2026-10-17

## Read
- The dispatch prompt, guardrails, semantic-verify-scenario skill, UI2 journal, state query, spec.md, scenarios.gherkin, tasks.md T4.1/T4.3, their task journals and D15 in defects.md.
- The committed f0027830d7 test diff and `packages/opencode/test/task/verify-spec-UI2.spec.ts`.
- The real TUI source: `index.tsx`, `view.ts`, `actor.ts`, `machine.ts`, `peek.tsx`, `watch.tsx` under `packages/tui/src/task-ui/`.

## Gherkin step and assertion
1. Given the plugin started for a session: `loadPlugin` calls `TaskUi.tui` on the `ses_root` route. The test asserts the initial Ledger, owned root, status, selection and captured actor snapshot (lines 266–276). The scoped spy captures the one actor passed to `viewOf` and forwards the original call (lines 212–227).
2. When keys switch design, select, expand, watch and press esc once: real keymap input drives rendered bar, route and toast assertions (lines 278–312). The captured actor's snapshot asserts design 7, chosen T1.3, collapsed expansion, watch on, target `ses_harness_0` and armed stop key together (lines 283–316). `index.tsx` binds key commands to that view; `watch.tsx` sends target and stop events through it.
3. Then one view machine owns those values: the captured plugin snapshot proves the actual connection. The separate machine test asserts its parallel regions, combined context and the view's selectors (lines 439–486). `viewOf` forwards every write to the actor and reads `fromActor` snapshots; the constructor count checks supplement the behavioral assertions (lines 507–523).
4. And the stop key disarms after 5 seconds: the real plugin snapshot is disarmed after 5.3 s, and the next esc warns without abort (lines 317–330). The SimulatedClock pins armed at 4,999 ms and disarmed at 5,000 ms with no stop event (lines 488–498).
5. And the four reads follow delayed transitions: the plugin's mounted Peek and watch readers produce SDK requests, status and proof changes alongside that captured actor's ticks (lines 349–392). The separate actor checks `after` delay names, exact 1,000/2,000/1,500/500 ms boundaries and read counts (lines 525–610). Source inspection confirms the installed readers depend on `view.ticks()` and the feed is the machine's invoked read.
6. And invalid status text keeps the last good status: the plugin's captured actor stores `{` as text while its view still shows T1.3 proving (lines 332–342). The separate actor checks three malformed shapes, the next good status and a deleted file (lines 612–640).

## Commands and outcome
- `state.mjs <spec> query scenario/UI2`: before the review, completed / verified.
- `git status --short` and `git show f0027830d7 -- packages/opencode/test/task/verify-spec-UI2.spec.ts`: scoped spy and mounted-reader test were the committed repair. Unrelated working-tree files were not touched.
- From `packages/opencode`, `bun test --timeout=30000 ./test/task/verify-spec-UI2.spec.ts`: 5 pass, 0 fail, 110 assertions, 22.79 s.
- One verifier-role call through `verification-runner.py -- node state.mjs <spec> verdict UI2 trusted --reason ...`: accepted, trustLevel trusted. The following query returned state completed and trustLevel trusted.
- D15 closed: the repaired test ties real plugin keys and mounted readers to the same captured actor. No remaining semantic gap for UI2. No test or source file changed; no commit.
