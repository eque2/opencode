# RM27 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier (OpenCode), spawned by the develop-spec orchestrator. Batch RM25-RM29.

## Read
- Dispatch prompt; guardrails.md; semantic-verify-scenario/SKILL.md; `journal/scenario/RM27.md`.
- tasks.md T1.4 "State Transitions — RM27"; CONTEXT SD-18 (outcome rule order).
- `packages/opencode/test/task/verify-spec-RM27.spec.ts`; `test/task/lib/machine.ts` (`facts`, `fail`).
- `src/task/engine-xstate/machine.ts` 255-300 (`settleReason`).

## Gherkin step -> assertion
1. Given T1.1 budget exhausted, T1.4 blocked by T1.1, an independent T1.2 building, and S1 waiting -> test 1 (plan
   from a temp spec folder via `Blend.load` + `TaskCommand.plan`, failures []); test 2: `states(before)` toEqual
   run running, T1 blocked, T1.1 budget_exhausted, T1.2 building, T1.4 blocked, S1 waiting; attempts 3;
   `blockedBy(T1.4)` = T1.1 budget_exhausted; `waitingOn(S1)` = [T1.2]; not ended, no stop.
2. When run.cancelled is applied with the reason "user stop" -> `engine.apply(plan, before, f.cancelled("user stop"))`.
3. Then the run outcome is budget exhausted -> test 3: status done, ended, `view.run.state` budget_exhausted,
   `stopOf` cancelled "user stop", run history entry running -> budget_exhausted at the stop time, projection
   `{state: budget_exhausted, tags: [ended, stopped]}`.
4. And the run reason holds the T1.1 line, then "T1.4 blocked by T1.1", then "user stop" -> test 4: exact reason
   `T1.1 budget exhausted\nT1 blocked by T1.1\nT1.4 blocked by T1.1\nuser stop`, index order checks, "user stop"
   last, projection reason equal.
5. And T1.2 and S1 are cancelled, and T1.1 stays budget exhausted -> test 5: states after, reasons "user stop",
   T1.1 view equal to before, the stop's history entries only for T1.2 and S1, none for T1.1.
- Contrast: test 6, a stop with no dead task ends cancelled.

## Commands
- `bun test --timeout=30000 ./test/task/verify-spec-RM27.spec.ts` (packages/opencode): 6 pass, 0 fail, 36 expect().
- `state.mjs <spec> verdict RM27 trusted --reason "..."` -> exit 0, `"trustLevel":"trusted"`.

## Outcome
Trusted. No gap. Note: the reason also holds "T1 blocked by T1.1" (the parent that rule R2 requires) between the
Gherkin's lines; SD-18 asks for one line per blocked task, so this is correct.
