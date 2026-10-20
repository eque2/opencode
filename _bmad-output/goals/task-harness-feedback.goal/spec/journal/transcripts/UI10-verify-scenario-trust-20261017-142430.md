# UI10 semantic trust transcript

- Read the prompt, guardrails, UI10 journal, CLI query, Gherkin, tasks, test file and `shared.tsx` scenario entries and region rendering.
- Given: real folded facts, status writer and TUI decoder produce 13 scenarios with fixed titles, S4 rejected and S13 parked on T8; the test asserts these values.
- When: seven expanded design components render at 120x40 through `viewFor`; the test scrolls the shared region's own box.
- Then: fixed glyphs, ids and titles, state labels and S1-S13 order are asserted for each region. The heading fixes 13 and the trusted count.
- And: S4's indented reason appears immediately under its entry in each region; the live and ended checks retain it.
- And: S13 reads its wait while live and `not run` after ended tags in each region, with its title still present.
- `bun test --timeout=30000 ./test/task/verify-spec-UI10.spec.ts` from `packages/opencode`: 3 pass, 0 fail, 398 assertions.
- One `verdict UI10 trusted` through `verification-runner.py`: query state completed, trustLevel trusted. No material gap.
