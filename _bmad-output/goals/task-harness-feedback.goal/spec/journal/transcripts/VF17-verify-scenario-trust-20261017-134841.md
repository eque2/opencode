# VF17 semantic trust transcript

- Read: guardrails, spec.md, scenarios.gherkin, T3.9 and VF17 journals, verify-spec-VF17.spec.ts, lib/scripted.ts, task-harness/arms/{workspace,index,status}.ts, and cascade SPEC.md and VERIFY.md.
- Given: test lines 104-113 compare the run repository's committed tree to a real task-demo.sh seed minus the other example folders. The helper runs the current server with a scripted model and a fresh git repository.
- When: lib/scripted.ts lines 94-103 starts the server and sends the actual `/task` command through the client.
- T1.1: test lines 115-120 assert budget_exhausted, one attempt, no second builder attempt and one exhaustion entry; its loaded proof is only the always-failing gate.
- T1.2 and T1: lines 122-125 assert blocked with the exact cause and no T1.2 builder request. T1.3: lines 127-129 assert trusted task and obligation.
- Run end: lines 93-102 observe the live intermediate state while the independent builder is held; lines 131-143 assert budget_exhausted, exact reason order, and a run-end history entry after T1.3 trusted.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-VF17.spec.ts` from packages/opencode: 1 pass, 0 fail, 20 assertions, about 50 seconds.
- Command: `python3 .claude/skills/eque2-code-setup/scripts/verification-runner.py -- node .claude/skills/eque2-code-setup/scripts/state.mjs _bmad-output/goals/task-harness-feedback.goal/spec verdict VF17 trusted --reason ...`: accepted once.
- Query: state completed, trustLevel trusted. Gap: none.
