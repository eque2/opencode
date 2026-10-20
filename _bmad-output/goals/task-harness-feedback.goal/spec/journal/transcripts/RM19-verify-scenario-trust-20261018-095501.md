# RM19 verify-scenario-trust transcript (2026-10-18, after commit 6c46ed46f0)

Role: fresh-context Layer 3 reviewer, spawned by the orchestrator. No source, test or state file edited. No evidence or
key file read. Nothing committed.

## What I read

- The dispatch prompt `journal/prompts/scenario-RM19-verify-scenario-trust.md`.
- `references/guardrails.md` and `semantic-verify-scenario/SKILL.md` of the develop-spec skill.
- `journal/scenario/RM19.md` (earlier verify and trust entries; the 2026-10-18 re-verify).
- `query scenario/RM19` at the start: state completed, trustLevel verified.
- The Gherkin (`scenarios.gherkin`, and the definitions entry): still "within 60 seconds".
- `goal.md` owner rulings 4 and 8; `spec.md` "Owner rulings"; `tasks.md` T1.9 and T1.10 (Supports RM19).
- `git show 9a1039d1f8` (records ruling 8) and `git show 6c46ed46f0` (the test change).
- `packages/opencode/test/task/verify-spec-RM19.spec.ts` (171 lines).
- The code it drives: `src/task/engine-xstate/alphabet.ts` (`alphabet`, `walkKey`), `machine.ts` (`config`,
  `mapStates`, `check`, `totality`, `fromConfig`, `machine`), `index.ts` (`initial`), and the helper
  `test/task/lib/machine.ts` (`loadPlan` through `Blend.load` and `TaskCommand.plan`; `outcome`, `unitState` read the
  snapshot value only).

## Diff check (6c46ed46f0)

Only three things changed: `WITHIN_MS` 60_000 -> 180_000 (with a comment that cites ruling 8), the walk test title
('owner rulings 4 and 8 ... within 180 seconds'), and the walk test's own timeout 150_000 -> 300_000. `LIMIT` 5_000,
every `expect`, the walk, the stuck detector and the negative control are unchanged. `git diff --quiet HEAD` is clean
for the test file, `src/task` and `test/task/lib`.

## Gherkin steps and their assertions

| Step | Assertion |
| --- | --- |
| Given the release-notes plan and the engine's progress alphabet | `loadPlan("release-notes.spec")` (real loader); task ids `T1..T1.5` and 13 scenarios asserted; events from production `TaskAlphabet.alphabet`; key from production `TaskAlphabet.walkKey`; machine from production `TaskMachine.machine(plan)`. Test 1 asserts `TaskMachine.check(plan, built)` returns `built` (ruling 4b) and `initial(plan).status` is `active`. |
| When every state reachable with the canonical interleaving is walked within 60 seconds (180 s, ruling 8) | Port `getAdjacencyMap` from `TaskEngineXState.initial(plan)`, events = the facts of the first unit in document order (ruling 4a), `stopWhen` done, `limit` 5_000 (the port fails past it); `expect(elapsed).toBeLessThan(180_000)`; `expect(edges).toBeLessThan(LIMIT)`. |
| Then no state that is not done lacks an event that changes its key | `expect(stuck).toEqual([])`; stuck = a non-done state with no transition to another key. Negative control: intact `example-cascade.spec` has 0 stuck; a copy without the `blocked` rows has stuck states, among them `T1.2:waiting`. |
| And every visited snapshot has status active or done | `expect(statuses).toEqual(["active", "done"])` (exact set; an `error` snapshot fails it). |

Non-vacuity: more than 100 keys (338); done outcomes exactly `budget_exhausted`, `done`, `failed`, `needs_human`; every
visited state with T1.1-T1.3 trusted and T1.4 budget exhausted has T1.5 and T1 `blocked`.

## Commands and results

1. `query scenario/RM19`: completed, verified. Exit 0.
2. `bun test --timeout=30000 ./test/task/verify-spec-RM19.spec.ts` in `packages/opencode` (load about 47 -> 63, a
   full suite ran at the same time): 3 pass, 0 fail, 26 expect(); walk 338 keys, 746 edges, 54 563 ms; file 71.86 s.
3. `python3 .agents/skills/eque2-code-setup/scripts/verification-runner.py -- node .claude/skills/eque2-code-setup/scripts/state.mjs <SPEC_FOLDER> verdict RM19 trusted --reason "..."`:
   exit 0; response `"verdict":"trusted"`, `"trustLevel":"trusted"`.
4. `query scenario/RM19`: state completed, trustLevel trusted.

## Outcome

Trusted. No gap. The 180 s bound is owner ruling 8; the deterministic edge guard (`LIMIT`) is unchanged. Note: the
walk took 54.6 s at load about 50, so the old 60 s bound had almost no margin on this host.
