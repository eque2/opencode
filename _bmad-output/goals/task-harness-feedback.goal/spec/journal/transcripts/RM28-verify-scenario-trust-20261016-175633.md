# RM28 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier (OpenCode), spawned by the develop-spec orchestrator. Batch RM25-RM29.

## Read
- Dispatch prompt; guardrails.md; semantic-verify-scenario/SKILL.md; `journal/scenario/RM28.md`.
- tasks.md T1.3 "Invalid Input" (config scan, RM28), T1.6 "Error Propagation — RM28"; CONTEXT SD-16.
- `packages/opencode/test/task/verify-spec-RM28.spec.ts`; `test/task/lib/machine.ts`.
- `src/task/engine-xstate/index.ts` 50-95 (`runPure`, `defect`, `initial`, `applyTo`, `apply`);
  `src/task/engine-xstate/machine.ts` 1286-1337 (`check`, `fromConfig`, `machine`).

## Gherkin step -> assertion
1. Given a generated machine whose guard names a state id that does not exist, reachable only after task.started ->
   `brokenAt(plan, "T1_4/building")`: the generated release-notes config with an `always` row guarded by
   `stateIn("#nowhere/at_all")`, built by the port's `createMachine` with the machine's own ACTIONS/GUARDS. Test 1:
   same first snapshot as the generated machine; every observed fact before T1.4's task.started folds to the same
   value and log, status active.
2. When task.started is applied -> test 2 (`task.started T1.1` on the copy broken at T1_1/building), test 3
   (observed facts step by step up to `task.started T1.4`).
3. Then apply dies with a defect that names the error -> test 2: the port's `transition` fails; `applyTo` throws
   "Child state node '#nowhere/at_all' does not exist on machine 'run'"; in an Effect `Cause.hasDies` true,
   `hasFails` false, squashed cause names the error; same after run.started. `apply` = `applyTo(machine(plan))`.
4. And apply never returns a snapshot whose status is error -> test 3: each returned snapshot non-error and equal to
   the port's; the walk ends "died on task.started T1.4"; on an error first snapshot `applyTo` dies for three facts
   with "the run machine has status error" and the named error; the real machine folds to active.
5. And the generator's config scan refuses any stateIn id that names no state -> test 4: `check` and `fromConfig`
   throw "a guard names the unknown state id <id>" for six copies (always row, unknown state, dotted id, and(),
   not() in or() of the outcome region, an obligation's event rows); test 5: 7 real plans pass and every stateIn
   id names a node.

## Commands
- `bun test --timeout=30000 ./test/task/verify-spec-RM28.spec.ts` (packages/opencode): 5 pass, 0 fail, 123 expect().
- `state.mjs <spec> verdict RM28 trusted --reason "..."` -> exit 0, `"trustLevel":"trusted"`.

## Outcome
Trusted. No gap. Observation: the error-output branch of `applyTo` (index.ts line 86) is not reached by this test,
because the port fails instead of returning an error snapshot after the first macrostep.
