# UI22 independent semantic review

- Read: dispatch prompt, guardrails, scenario query, scenario journal, `scenarios.gherkin`, `spec.md`, T4.4 journal, scenario test and `screen.tsx`.
- Given: test lines 183–199 fold real facts, write and decode the status, then assert 13 scenarios and five stopped tasks.
- When: test lines 241–268 call the stub host's `screen.press("pagedown")` and use `mockMouse.pressDown`. The click uses the renderer, but the key press bypasses real key event dispatch. The stub looks up the command and calls `run()` itself.
- Then: lines 207–254 assert the region height, Peek reduction, all STOPPED lines and all 13 scenarios in the scroll box. These assertions prove the scrolling command's result, not the real keymap reachability.
- And click: lines 256–268 assert the first task T1 is selected.
- And layout: lines 279–311 assert the pane beside the Board at 149 and below it at 148 and 120 cells.
- Run: `bun test --timeout=30000 ./test/task/verify-spec-UI22.spec.ts` from `packages/opencode`: 3 pass, 0 fail, 42 assertions.
- Verdict: `verdict UI22 rejected` succeeded. CLI trustLevel: `suspect`; prior queried state: `completed`.
- Gap: real pagedown delivery through the active host keymap and route remains unproved.
