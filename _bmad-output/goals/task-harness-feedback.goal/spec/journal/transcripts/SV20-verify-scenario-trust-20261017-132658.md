# SV20 semantic verification

- Read: dispatch prompt, guardrails, skill, spec.md, scenarios.gherkin, tasks.md T2.5/T2.10/T2.11, their journals, SV20 journal and committed test.
- Given live release-notes run: the real command resumes a stored slice. The test asserts the directory lease, active run and T1.5 waiting only on untrusted T9.
- When /task trust T9: the test calls TaskCommand.run in the instance. It checks the command reply and directory aggregate.
- Once on run aggregate and ready: the test observes one outside.trusted T9. The fold before and after it proves readiness changes at that fact; the live supervisor later starts T1.5.
- No untrusted region: commands for a task, unknown id and duplicate T9 change the directory aggregate but leave the run trust list unchanged. T8 proves forwarding still works.
- Trust before start: the directory fact exists before a run aggregate; a new run places one trust directly after run.started. Folded snapshots prove T9 changes state.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-SV20.spec.ts` from packages/opencode: 3 pass, 0 fail, 38 assertions, 29.34 s.
- CLI: `verdict SV20 trusted` succeeded. `query scenario/SV20` reports state completed and trustLevel trusted. Gap: none.
