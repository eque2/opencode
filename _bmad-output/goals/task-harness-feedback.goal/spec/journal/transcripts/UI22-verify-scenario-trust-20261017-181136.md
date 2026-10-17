# UI22 independent semantic verification — 2026-10-17

## Read
- The dispatch prompt, guardrails, semantic verifier skill, prior UI22 journal, scenario CLI query, `spec.md`, `scenarios.gherkin`, tasks T4.4/T4.6 references, T4.4 journal and D18 defect.
- `packages/opencode/test/task/verify-spec-UI22.spec.ts`, `packages/tui/src/task-ui/designs/screen.tsx`, `shared.tsx`, `keymap.tsx` and the TUI plugin fixture.
- Commit `26603ccd79` changes the UI22 test. The previous semantic review rejected direct command invocation in a stub host.

## Gherkin coverage
1. Given 120 × 24, 13 scenarios and five stopped tasks: the engine folds release-notes facts, the status writer persists the result, and the task-ui parser reads it. The first test asserts S1–S13 and five exact stopped states and reasons (lines 186–202). The second test renders the mounted route at 120 × 24 (lines 221–228).
2. When PageDown and click: the test mounts `registerScreen`'s active Board route under `OpencodeKeymapProvider` and calls `registerOpencodeKeymap` (lines 116–162). The route registers `pagedown` and `pageup` commands that call `pageBy` on the rendered region (screen.tsx lines 251–288). Renderer `mockInput.pressKey` sends ESC [ 6 ~ and ESC [ 5 ~; the mouse presses a visible STOPPED line (test lines 239–267). No direct command invocation remains.
3. Then region, Peek and reachability: the test asserts region height at least eight, activity falls from more than one line at 80 rows to one at 24, the first page omits some entries, and paging brings all four STOPPED lines and S1–S13 into the region's own cells. It also asserts S13's blocked cause and positive scroll position (lines 210–253).
4. And click selection: the test returns the region to scrollTop zero, clicks the T1/T1.4 line and asserts that selection changes from T1.3 to T1, its first id (lines 255–267).
5. And breakpoint: the test asserts the pane at the right from 149 cells, then below the board at 148 and 120 cells. The 120 × 24 route test also checks its lower position (lines 268–273, 278–311).

## Commands and result
- `node .claude/skills/eque2-code-setup/scripts/state.mjs ... query scenario/UI22`: completed / verified before review.
- `git show --stat --oneline 26603ccd79 -- packages/opencode/test/task/verify-spec-UI22.spec.ts`: committed key-dispatch test replacement.
- `bun test --timeout=30000 ./test/task/verify-spec-UI22.spec.ts` from packages/opencode: 3 passed, 0 failed, 42 assertions.
- One `verdict UI22 trusted` through `verification-runner.py`: accepted, trustLevel trusted.
- Final CLI query: state completed, trustLevel trusted. `git diff --check`: passed.

## Outcome
- Trusted. D18 resolved. No remaining UI22 Gherkin gap was found. No source, test, evidence, key, or protected state file was read or edited outside the allowed CLI.
