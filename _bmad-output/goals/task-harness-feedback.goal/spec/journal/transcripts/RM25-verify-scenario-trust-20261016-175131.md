# RM25 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier (OpenCode), spawned by the develop-spec orchestrator. Batch RM25-RM29.

## Read
- Dispatch prompt `journal/prompts/scenario-RM25-RM29-verify-scenario-trust.md`; `references/guardrails.md`;
  `semantic-verify-scenario/SKILL.md`; `journal/scenario/RM25.md` (Layer 1+2 history).
- spec.md, tasks.md (T1.5 "Boundary — RM25", T1.7).
- `packages/opencode/test/task/verify-spec-RM25.spec.ts`; helper `test/task/lib/machine.ts` (`loadPlan`, `pass`,
  `fail`: real `Blend.load` + `TaskCommand.plan`, plain result builders, no mock).
- `src/task/engine-xstate/machine.ts` 300-430 (`timed`, `spansAfter`, `ACTIONS.enter`, `ACTIONS.begin`).

## Gherkin step -> assertion
1. Given the loaded example-cascade plan and facts with fixed times -> test 1: `loadPlan("example-cascade.spec")`,
   `plan.tasks` ids/after/children, `plan.budget("T1.1") === 1`, no time or span on any unit of `engine.initial`.
   Facts use `at(n) = base + n*1000`.
2. When T1.1 builds and fails its proof, and T1.3 builds and is trusted -> `fold(plan, [...untilTrusted,
   failedProof])` through `TaskEngineXState.initial/apply`; asserts T1.1 `budget_exhausted`, T1.3 `trusted`.
3. Then T1.1 start at task.started, end at failing proof, spans waiting, building, proving, zero-length
   budget_exhausted -> test 2: `toEqual` with startedAt 2000, endedAt 8000 and the four spans; last span
   from === to === failedProof.at.
4. And the blocked T1.2 has an end time and no start time -> test 3: state `blocked`, `blockedBy` T1.1
   budget_exhausted, endedAt 8000, `"startedAt" in slot` false; parent T1 the same.
5. And a stale obligation on the trusted T1.3 clears its end time and starts its clock again -> test 4: on the active
   snapshot (T1.3 trusted, T1.1 still proving) `obligation.stale T1.3.c1 @7500` -> T1.3 `proving`, `"endedAt" in
   slot` false, startedAt 7500, trusted span closed, new open proving span; a later T1.1 failure leaves T1.3's clock.
- "Only from machine actions": test 5 (shift by 5 000 000 shifts every value; repeat fold equal), test 6
  (`TaskStatus.project` copies values), test 7 (real `TaskRecorder` live actor writes the same values to status.json).

## Commands
- `bun test --timeout=30000 ./test/task/verify-spec-RM25.spec.ts` (packages/opencode): 7 pass, 0 fail, 84 expect().
- First `verdict` attempt hit a zsh parse error (a stray `)`); the command never ran (query confirmed trustLevel
  still verified). Corrected call: `state.mjs <spec> verdict RM25 trusted --reason "..."` -> exit 0,
  `"trustLevel":"trusted"`.

## Outcome
Trusted. No gap.
