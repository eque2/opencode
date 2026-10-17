# UI5 semantic trust transcript

- Read the dispatch prompt, guardrails, scenario journal, CLI query, UI5 Gherkin, spec and tasks, test file, and task-ui wait render paths.
- Given: `statusOf` decodes T1.2 with T9 outside and T1.1 external; `loadPlan` and `TaskStatus.project` check a real subtree projection.
- When: `shown` renders Board, Peek, collapsed and expanded design components over `viewFor` and the real TUI renderer.
- Then: exact outside sentence and warning tone appear in the Board and Peek; each design renders the sentence or a collapsed form; seven bars show the outside-wait part.
- And: exact external sentence and muted tone appear in the Board and Peek; external-only views and bars assert no trust command.
- `bun test --timeout=30000 ./test/task/verify-spec-UI5.spec.ts` from `packages/opencode`: 4 pass, 0 fail, 102 assertions.
- `verification-runner.py -- node state.mjs ... verdict UI5 trusted --reason ...`: one successful verdict. Query: completed, trusted. No material gap.
