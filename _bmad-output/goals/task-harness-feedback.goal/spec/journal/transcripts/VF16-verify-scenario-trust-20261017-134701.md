# VF16 semantic trust transcript

- Read: guardrails, spec.md, scenarios.gherkin, T3.10 task and scenario journals, verify-spec-VF16.spec.ts, and task-demo.sh.
- Given: test lines 68-70 assert the temporary demo folder is empty.
- When: lines 76-79 run the real seed script; `TASK_DEMO_NO_EXEC=1` exits after the seed commit and printed commands, before install and TUI launch.
- Then: lines 71-101 enumerate source examples, compare the exact destination folder set and every file's bytes, and verify a clean tracked seed commit. Lines 103-117 assert both printed live-check commands and load the copied folders.
- Additional guard: lines 122-134 assert that a non-demo folder is refused without deletion.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-VF16.spec.ts` from packages/opencode: 2 pass, 0 fail, 171 assertions.
- Command: `python3 .claude/skills/eque2-code-setup/scripts/verification-runner.py -- node .claude/skills/eque2-code-setup/scripts/state.mjs _bmad-output/goals/task-harness-feedback.goal/spec verdict VF16 trusted --reason ...`: accepted once.
- Query: state completed, trustLevel trusted. Gap: none.
