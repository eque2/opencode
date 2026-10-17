# VF22 semantic trust transcript

- Read: guardrails, skill, spec.md, scenarios.gherkin, tasks.md T1.2/T3.2, VF22 journal and test, command helper, TaskCommand.run, TaskMachine.machine source header.
- Given: three committed fixture folders derive from a real SPEC.md. The loader returns no failure and no task for bare, outside-only, and outside-plus-scenario shapes. The test asserts outside and scenario ids.
- When/Then: real `/task` returns exactly `Refused <path>. No work started.` and the one plain no-task line. Each case checks no job, lease, new fact, or worktree, plus refused status reason.
- Generator And: TaskCommand.plan has no tasks for each loaded shape, and TaskMachine.machine throws the named no-task defect. A task-bearing plan builds as negative control.
- Run: `bun test --timeout=30000 ./test/task/verify-spec-VF22.spec.ts` in packages/opencode: 7 pass, 0 fail, 53 assertions.
- Verdict: one `verification-runner.py -- node state.mjs ... verdict VF22 trusted` call succeeded. CLI query: state completed, trustLevel trusted. No material coverage gap.
