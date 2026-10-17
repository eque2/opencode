# RM22 semantic verification — 2026-10-17

## Read
- The RM22 verifier prompt and recovery journal; develop-spec guardrails and semantic-verifier skill; goal.md ruling 7; spec.md, scenarios.gherkin, tasks.md, and T1.9/T1.10 journals.
- The committed RM22 test, loader helper, `TaskAlphabet.walkKey` and `alphabet`, and `TaskMachine.GUARDS` and outcome rows.
- The raw adapter `run.json`, `junit.xml`, and `run.log` for `20261017T113011Z-05ff6f`. No evidence or key file was read.

## Gherkin-to-assertion assessment
1. **Given a small plan:** `loadPlan` calls `Blend.load` and `TaskCommand.plan`. The two reduction tests load `example-cascade.spec` and `example-scenarios.spec`.
2. **When the canonical and full walks run with and without blocked rows:** each reduction test walks the checked real machine with both event selectors. It also walks a config copy with every `always` row targeting `blocked` removed. The port's `getAdjacencyMap` explores the transitions.
3. **Then both find the same set of stuck states:** the real walks both assert no stuck keys. The negative controls assert nonempty canonical stuck keys, equality of full sets after removing only `dead:`, and inclusion of each canonical raw key in the full set. Ruling 7 defines stuck-state equality by unit configuration. The `dead:` field still tracks the first-death state used by the actual `firstDead` guard. The cascade run found 27 versus 39 raw keys but 27 configurations in both; the scenarios run found 3 versus 3.
4. **And the stale loaded cascade walk finds none:** the opt-in test loads that plan, uses full facts plus eligible staleness and the stale key, then asserts `stuck=[]` and statuses `active/done`. Its recorded run reached 33,944 keys and 331,133 edges and passed. It was not rerun.
5. **And every guard context path belongs to the walk key:** one test asserts coverage of every named guard. Three tests wrap the real guards and record context reads across full-walk states, alphabet facts, staleness and stop facts. They assert each source-state read against that state's applicable key and aggregate reads against both key modes. Nonvacuity assertions cover log, stop, task attempts and kind. Actual context-reading guards `firstDead`, `stopped` and `underBudget` agree with the key source. This tests the reachable states of the loaded plans, not arbitrary future plans.

## Commands and outcome
- `git status --short`: unrelated changes were present; none was changed.
- `state.mjs ... query scenario/RM22`: initially `completed/suspect`.
- `git diff` on the test/key/guard files: empty. `git diff 20c6fb2897 HEAD` on those files and the loader helper: empty.
- `shasum -a 256 packages/opencode/test/task/verify-spec-RM22.spec.ts`: `537284f2d5b5dce7e617fd649c8244c006fe4b00886e301d774db18e28f9c7cb`, matching run.json before and after.
- The manifest and JUnit report seven passes, zero failures and zero skips; the adapter and Bun exited zero. The reporter decision is `handed-off`.
- One hookless verifier-runner call to `state.mjs ... verdict RM22 trusted --reason <step-by-step reasoning>` returned `trustLevel: trusted`.
- Subsequent `state.mjs ... query scenario/RM22` returned `state: completed`, `trustLevel: trusted`.
- No remaining RM22 semantic gap under owner ruling 7. No stale-walk rerun, source/test/protected-state edit, or commit.
