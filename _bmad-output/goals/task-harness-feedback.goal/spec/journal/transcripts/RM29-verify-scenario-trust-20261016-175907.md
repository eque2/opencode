# RM29 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier (OpenCode), spawned by the develop-spec orchestrator. Batch RM25-RM29.

## Read
- Dispatch prompt; guardrails.md; semantic-verify-scenario/SKILL.md; `journal/scenario/RM29.md` (INTENT only).
- Adapter run record `journal/adapter/runs/RM29/20261016T145852Z-d44dfa/run.json` (bun exit 0, 7 pass, hash
  be2acea5... equals `shasum -a 256` of the committed test file). No evidence or key file read.
- tasks.md T1.3 "Invalid Input / Happy Path / Boundary — RM29", T1.10 "Happy Path — RM29".
- `packages/opencode/test/task/verify-spec-RM29.spec.ts`; `test/task/lib/machine.ts`.
- `src/task/engine-xstate/machine.ts` 1150-1316 (`evaluate`, `firstRow`, `causeOf`, `totality`, `check`).
- `ls task-formats/blend/*.spec` (10 folders; 5 load).

## Gherkin step -> assertion
1. Given a copy of the release-notes config with the row that blocks T1.5 on T1.4 budget exhausted removed ->
   test 1: `withoutGap` removes exactly 1 row; the removed row targets `blocked` with action
   `block {unit T1.5, from waiting, id T1.4, state budget_exhausted}`.
2. When the generator's totality check scans the copy -> `TaskMachine.check(plan, copy)`, `fromConfig(plan, copy)`.
3. Then it fails with an error naming T1.5, waiting and T1.4 budget exhausted -> both throw
   "totality: T1.5 waiting has no row for T1.4 budget_exhausted"; the message contains each part; the original
   config passes. Test 2: without the check the copy strands T1.5 waiting on the ended T1.4.
4. And the scan of every real plan passes -> test 3: the five loadable folders, whole and per task subtree; `check`
   and `machine(plan)` pass; the plain-data oracle `coverage` finds a blocked row per task dependency x blocking
   state, the ready row on all trusted, and the parked row for an outside need; the oracle flags the gap copy.
   Test 4: real folds block T1.5 by T1.4 for needs_human, budget_exhausted, failed and blocked.
5. And no non-final state lacks a way out except a wait on an untrusted outside or external region, and the outcome
   can settle once every region is final -> test 5: the scan refuses a state with no rows, missing settle rows in
   run running and run waiting, and a scenario without its parked row; no real plan has a non-final node without
   rows. Test 6: seeded walks (6 plans x 12 seeds, up to 400 steps): never all regions final while active, all final
   when done, each standstill is a transitive wait on an untrusted outside/external region, outcomes include done,
   failed, cancelled and a dead state; the check flags the gap copy's stuck T1.5. Test 7: T1.5 waits on T9 (and on
   external T1.3, T1.4 in its subtree) until outside.trusted moves it to ready.

## Commands
- `bun test --timeout=30000 ./test/task/verify-spec-RM29.spec.ts` (packages/opencode): 7 pass, 0 fail, 921 expect().
- `state.mjs <spec> verdict RM29 trusted --reason "..."` -> exit 0, `"trustLevel":"trusted"`.

## Outcome
Trusted. No gap. Note: the Layer 1+2 dispatch left no OUTCOME entry and no verify transcript for RM29; the adapter
run record and the state (completed, verified) show the structural pass. This dispatch added an OUTCOME entry.
