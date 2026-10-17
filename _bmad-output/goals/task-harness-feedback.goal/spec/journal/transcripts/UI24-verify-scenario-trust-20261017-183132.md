# UI24 independent semantic verification

## Read
- The UI24 dispatch prompt, guardrails, semantic verifier skill, UI24 journal, spec.md, scenarios.gherkin, tasks.md, and D19 entry in defects.md.
- The committed `packages/opencode/test/task/verify-spec-UI24.spec.ts`, `TaskHarness.make`, `LayerNode.compile`, `TaskCommand.job/run`, `RunSupervisor.finish/machine`, `TaskRecorder.make`, `TaskStatus.project/write`, `TaskWorkers.summary`, and `SessionPrompt.command/taskOps`.

## Gherkin coverage
1. Given a root turn waits on a permission prompt: lines 266–296 start a real SessionPrompt turn, wait for the real Permission request, and assert the session stays busy. Lines 329 and 324–328 show that the permission and job remain pending with no summary.
2. When the run actor reaches done: lines 227–264 prepare a nonfinal stored slice. Lines 270–272 let the real judge trust S4. Lines 298–311 wait for the stored final fold and assert done; the release observer also reads the real run supervisor context.
3. Then the writer writes done before lease release, and the summary follows: lines 132–167 replace only the harness service's release method with an observer around the real TaskHarness.make service. At the first release call, it records the live lease, the supervisor context's actual Recorder writer fiber, and the decoded status file before forwarding. Lines 312–329 assert `{ lease: "held", writer: "ended", state: "done" }`, ended tags, an ongoing job, no summary and a pending permission request. A release before the writer completes would show a running writer or missing/non-done file at this boundary. The fresh test directory has no prior done status; no second command starts before the observation.
4. And the next `/task` is not busy: lines 331–338 invoke SessionPrompt.command again. Its result is a later git refusal with the untracked filename, rather than the busy line. `TaskCommand.run` checks live before git readiness.
5. And one summary follows the turn, or its failure is logged if the root goes away: lines 340–373 remove the root in the second case, reply to permission, await closure, and assert either one parent-linked assistant summary or one matching closing-summary failure log. The background job remains running during the wait.

## Commands and outcome
- `node .claude/skills/eque2-code-setup/scripts/state.mjs _bmad-output/goals/task-harness-feedback.goal/spec query scenario/UI24` → completed / verified before review.
- `bun test --timeout=30000 ./test/task/verify-spec-UI24.spec.ts` from `packages/opencode` → 2 pass, 0 fail, 39 assertions, 20.67 s.
- `python3 .claude/skills/eque2-code-setup/scripts/verification-runner.py -- node .claude/skills/eque2-code-setup/scripts/state.mjs _bmad-output/goals/task-harness-feedback.goal/spec verdict UI24 trusted --reason <step-specific reasoning>` → one accepted verdict, trustLevel trusted.
- Subsequent CLI query → state completed, trustLevel trusted.

D19 resolved. No semantic coverage gap remains. No evidence or key files were read; no source, test or state files were edited; no commit was made.
