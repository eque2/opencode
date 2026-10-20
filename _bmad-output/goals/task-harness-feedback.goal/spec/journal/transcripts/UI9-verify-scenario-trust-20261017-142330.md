# UI9 semantic trust transcript

- Read the prompt, guardrails, UI9 journal, CLI query, Gherkin, tasks, test file, `shared.tsx` STOPPED grouping and `peek.tsx` heading.
- Given: the release-notes fact sequence uses the real engine and status writer. Assertions fix the budget-exhausted and failed reasons, three blocked causes and stopped tags.
- When: all seven expanded design components render over `viewFor` and the real TUI renderer.
- Then: each design's shared scroll region has `STOPPED 5` and four fixed reason/cause lines in dead-then-blocked order, with valid width cuts.
- And: the selected failed reason joins to the full text across wrapped Peek lines without ellipsis; a selected blocked cause uses the warning tone.
- And: collapsed Ledger, Dock, HUD and bars have glyph/id and count, but no failure reason, cause, BUILDER or STOPPED section.
- `bun test --timeout=30000 ./test/task/verify-spec-UI9.spec.ts` from `packages/opencode`: 4 pass, 0 fail, 204 assertions.
- One `verdict UI9 trusted` through `verification-runner.py`: query state completed, trustLevel trusted. No material gap.
