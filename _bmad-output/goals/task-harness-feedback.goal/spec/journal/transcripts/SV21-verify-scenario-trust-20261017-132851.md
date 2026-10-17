# SV21 semantic verification

Read the dispatch prompt, guardrails, semantic skill, spec.md, scenarios.gherkin, tasks.md mapping, T2.4 and T2.11 summaries, scenario test, and CLI query. The query returned state completed, trustLevel verified.

- Given done and cancelled runs: the first test resumes a stored unended T1.1 slice and records the real S7 verdict; the second starts and cancels a real job. Both assert terminal folds and stored facts.
- When scopes close: the tests await completion or interruption of the job fiber.
- Then writer before release: the release wrapper observes the real lease and polls the run supervisor's writer fiber. Both release calls have an ended writer and final on-disk state.
- And next command not busy: each test checks a busy reply while live and a successful new claim and start after termination.

`bun test --timeout=30000 ./test/task/verify-spec-SV21.spec.ts` in packages/opencode: 2 pass, 0 fail, 40 expect calls. One `verdict SV21 trusted` through verification-runner and the state CLI returned trustLevel trusted. No semantic gap found. No evidence or keys read; no test or source changed.
