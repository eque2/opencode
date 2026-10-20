# SV24 semantic verification

Read the dispatch prompt, guardrails, semantic skill, spec.md, scenarios.gherkin, tasks.md mapping, T2.7/T2.8/T2.10 summaries, scenario test, and CLI query. The query returned state completed, trustLevel verified.

- Given: real worktree and stored facts name the existing T1.2 builder session. The fold is unended and building; the pre-resume tool call reports no owner.
- When: real /task on the same path records run.resumed as the first new fact, without another run.started. The new supervisor prompts the reused session.
- Then: the wrapper records real claim, index lookup, and prompt in exact order. The prompt sees the live new owner.
- And: real task_ready returns valid and records one task.ready with the committed worktree head and file; the fold still names the stored session.

`bun test --timeout=30000 ./test/task/verify-spec-SV24.spec.ts` in packages/opencode: 1 pass, 0 fail, 20 expect calls. One `verdict SV24 trusted` through verification-runner and the state CLI returned trustLevel trusted. No semantic gap found. No evidence or keys read; no test or source changed.
