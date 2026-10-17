# VF19 semantic trust transcript

- Read: guardrails, skill, spec.md, scenarios.gherkin, tasks.md mapping T3.2/T3.4, existing VF19 journal, scenario test, command helper, TaskCommand.run, TaskWorkspace.readiness.
- Given/When: `seed` commits a real fault folder and outside-run folder. The third case changes tracked `app.ts`. All call the real command with recording prompt and job boundaries.
- Loader Then: exact three-line array asserts the counted header, R6 line, and fix hint. A second case asserts the typed path in header and hint. The status reason holds only the fault line.
- Subtree And: exact R12 line and final T1.1 hint. A two-dependency negative control checks the joined hint. The status reason holds the R12 line.
- Checkout And: exact two-line array asserts a plain header and the dirty tracked-file line, with no hint. The status reason equals that line.
- All refusals assert one no-reply message, no background job, and no live lease. The helper records a prompt rather than rendering a session, which is sufficient for command reply text.
- Run: `bun test --timeout=30000 ./test/task/verify-spec-VF19.spec.ts` in packages/opencode: 5 pass, 0 fail, 30 assertions.
- Verdict: one `verification-runner.py -- node state.mjs ... verdict VF19 trusted` call succeeded. CLI query: state completed, trustLevel trusted. No material coverage gap.
