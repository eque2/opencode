# UI6 semantic trust transcript

- Read the prompt, guardrails, UI6 journal, CLI query, Gherkin, tasks, test file, command helper, command `leftOut`, TUI `task-header.tsx` and route wiring.
- Given: `loadPlan` and committed `seed` use the release-notes spec; the title is asserted against a fixed literal.
- When: `runTaskInputs` invokes real `TaskCommand.run` for whole and subtree paths; the recording Ops captures the first input, while the job registry records starts.
- Then: the first part's exact text and metadata are asserted. The TUI `MessageBody` is rendered from metadata with muted and bold span assertions; altered text with the same metadata confirms the source.
- And subtree: exact task id, title, spec title and styles are checked. Empty title fallback and projected status fields are checked. Two runs with separate metadata check older-header isolation.
- Gap: `leftOut` expected ids come from `TaskCommand.leftOut(plan)`, the same function used in the production header. Only nonempty and absence of S3 are independent. An incomplete list passes. The recording Ops does not prove `SessionPrompt` stores metadata.
- `bun test --timeout=30000 ./test/task/verify-spec-UI6.spec.ts` from `packages/opencode`: 4 pass, 0 fail, 61 assertions.
- One `verdict UI6 rejected` through `verification-runner.py`: trustLevel suspect. Query: state completed, trustLevel suspect.
