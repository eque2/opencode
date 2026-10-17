# SV25 semantic verification

Read the dispatch prompt, guardrails, semantic skill, spec.md, scenarios.gherkin, tasks.md mapping, T2.10/T2.11 summaries, scenario test, and CLI query. The query returned state completed, trustLevel verified.

- Given: the prior real stored slice ends cancelled and has a saved fold. The real command starts a new job; a narrow event-store wrapper gates its run.started publication. The supervisor remains starting and the store remains unchanged.
- When: the job status becomes cancelled and its fiber is interrupted. A finalizer-read signal proves cancellation reached the job while the start remains held. No cancel fact reaches the old slice.
- Then: opening the gate yields a new run.started before exactly one run.cancelled. Slices and latest-run selection distinguish the two runs.
- And: the previous fact prefix is unchanged; its fold's status, value, context, and view equal the saved pre-cancel snapshot.

`bun test --timeout=30000 ./test/task/verify-spec-SV25.spec.ts` in packages/opencode: 1 pass, 0 fail, 25 expect calls. One `verdict SV25 trusted` through verification-runner and the state CLI returned trustLevel trusted. No semantic gap found. No evidence or keys read; no test or source changed.
