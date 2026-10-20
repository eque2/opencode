# UI15 semantic verification transcript — 2026-10-17

## Read
- `spec/journal/prompts/scenario-UI15-verify-scenario-trust.md`, `spec/journal/scenario/UI15.md`, the guardrails and semantic verifier skill.
- `spec/scenarios.gherkin` UI15, `spec/spec.md` verification intent, and `spec/tasks.md` T4.12.
- `packages/opencode/test/task/verify-spec-UI15.spec.ts`, `packages/tui/test/task-ui/prompt-render.tsx`, the production `Prompt`, `task-ui/usage.ts`, and the sidebar Context panel.
- Code navigation used file reads and text search because Serena tools were unavailable in this session.

## Gherkin assessment
1. **Given a /task root with spent child sessions:** The test supplies SDK-shaped root, builder and verifier sessions. The assertions check 1,402,331 tokens and $2.31; large cache counts and foreign sessions do not enter the sum.
2. **When the footer, sidebar and task-ui render:** The provider-backed helper mounts the real `Prompt`; the test captures its character frames at 100, 50 and 35 cells. The built-in sidebar panel, task-ui designs, and live plugin also render.
3. **Then each shows the sum live:** Footer and sidebar assertions check the first sum and its $3.31 update. Prompt frames check the visible update. Task-ui plugin assertions check the changed Dock and HUD after SDK session reads.
4. **Quiet and unrelated sessions:** Empty prompt frames, sidebar and task-ui assertions show no run usage before child tokens. The ordinary session keeps its existing figure. Another root's harness child contributes nothing.
5. **Free and narrow:** A free child with 11 tokens shows `$0.00`. Rendered frames first lose the root's own figure at 50 cells and then the word `tokens` at 35 cells. Direct footer checks cover the later cost-only fallback.
6. **Closing summary:** The real run supervisor emits one root-session summary. Its total matches the footer text for the same children.

## Commands and outcome
- `state.mjs <spec> query scenario/UI15`: completed / verified before review.
- `bun test --timeout=30000 ./test/task/verify-spec-UI15.spec.ts` from `packages/opencode`: 5 pass, 0 fail, 55 assertions, 23.00 s.
- `verification-runner.py -- node state.mjs <spec> verdict UI15 trusted --reason ...`: one verdict call; CLI returned `trustLevel: trusted`.
- `state.mjs <spec> query scenario/UI15`: `state: completed`, `trustLevel: trusted`.
- No material assertion gap remains. D17's missing real prompt render is closed. No source, test or state file was edited.
