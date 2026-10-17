# VF14 semantic trust transcript

- Read: guardrails, spec.md, scenarios.gherkin, tasks.md support lines, scenario journal, verify-spec-VF14.spec.ts, test/task/lib/command.ts, core/command.ts; inspected the example-outside-run folder paths.
- Given: lines 51-54 check T1.2 `after: [T1.1]` in the real TASK.md and distinct task folders.
- When and Then: lines 57-66 call `Blend.load` on the copied folder and assert no failures and the exact task order.
- And: lines 68-96 establish no prior run, call real `TaskCommand.run`, assert the exact R12 refusal and no job, lease or run fact. Lines 101-114 establish the whole-spec control starts a job. The helper records the reply but does not mock the command, loader or trust walk.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-VF14.spec.ts` from packages/opencode: 2 pass, 0 fail, 20 assertions.
- Command: `python3 .claude/skills/eque2-code-setup/scripts/verification-runner.py -- node .claude/skills/eque2-code-setup/scripts/state.mjs _bmad-output/goals/task-harness-feedback.goal/spec verdict VF14 trusted --reason ...`: accepted once.
- Query: state completed, trustLevel trusted. Gap: none.
