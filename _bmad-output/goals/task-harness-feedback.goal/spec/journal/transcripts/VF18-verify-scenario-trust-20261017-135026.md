# VF18 semantic trust transcript

- Read: guardrails, spec.md, scenarios.gherkin, T3.9 and VF18 journals, verify-spec-VF18.spec.ts, lib/scripted.ts, proof/index.ts, task-harness/arms/{workspace,index,status}.ts, example-scenarios SPEC.md, T1.1 VERIFY.md and acceptance/S1.md.
- Given: test lines 96-104 compare the run repository's committed tree to a real task-demo.sh seed minus unrelated examples; the helper serves the current tree with a scripted model.
- When: lib/scripted.ts lines 94-103 send the real `/task` command through the client.
- T1.1 and parent: lines 106-117 assert the leaf and tagged obligation trusted, parent and review obligation trusted, a reviewer request for T1.e1, and the parent trust after the leaf.
- S1: lines 73-87 make a real tagged test. Lines 119-132 assert a passing line in the scenario proof log, pending before trusted history, a verifier request judging S1 after proof, and trusted status. `TaskProof.proveScenario` uses the title tag to select passing tests.
- Run: lines 134-136 assert done after S1 trust.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-VF18.spec.ts` from packages/opencode: 1 pass, 0 fail, 19 assertions, about 48 seconds.
- Command: `python3 .claude/skills/eque2-code-setup/scripts/verification-runner.py -- node .claude/skills/eque2-code-setup/scripts/state.mjs _bmad-output/goals/task-harness-feedback.goal/spec verdict VF18 trusted --reason ...`: accepted once.
- Query: state completed, trustLevel trusted. Gap: none.
