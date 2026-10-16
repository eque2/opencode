# RM2 verify-scenario-trust transcript

Role: fresh-context semantic verifier (eque2-verifier), batch RM2-RM6. No source or test file changed.

## What I read
- references/guardrails.md, semantic-verify-scenario/SKILL.md.
- `state.mjs query scenario/RM2`: completed, trustLevel verified.
- spec.md (scope, owner rulings), tasks.md T1.2 (Supports RM2), journal/scenario/RM2.md.
- packages/opencode/test/task/verify-spec-RM2.spec.ts, test/task/lib/machine.ts,
  src/task/engine-xstate/machine.ts (ACTIONS, GUARDS, config, check, fromConfig, machine).

## Gherkin step -> assertion
- Given a plan whose task ids give two equal explicit state ids: test 1 adds task `T1_1` beside `T1.1`
  (example-cascade plan from `Blend.load`); asserts `stateId("T1.1", s) === stateId("T1_1", s)` for six states.
  Test 2 adds task `T1.1.c1`; asserts the config's repeated ids are exactly `T1_1_c1/failed`, `T1_1_c1/trusted`.
- When the engine generates the run machine: `TaskMachine.machine(clash)` and `TaskEngineXState.initial(clash)`.
- Then the generation dies naming the repeated id: `defectOf` asserts a die and no typed failure; messages contain
  `duplicate unit T1_1: T1.1, T1_1` and `duplicate state id <first repeated id>`. Test 1 also proves the plain config
  silently keeps one region and the bare port accepts it, so the generator's check is the refusal; the clean plan
  still starts `active`.
- And every generated machine caps eventless iterations at 1000: every loadable blend plan (whole and per-task subtree,
  external regions included): config and built `options.maxIterations` = 1000. An unguarded eventless loop gives an
  `error` snapshot "more than 1000 microsteps"; control with 50 gives "more than 50 microsteps".
- And no delayed transition, invoked actor, spawned actor or custom action: config key scan (after, invoke, spawn,
  delay, delays, actors, src) empty; built nodes have no `after`/`invoke`, no `xstate.after` event; implementations
  are only `actions` and `guards`; every used action resolves to `xstate.assign` or an undelayed `xstate.raise`; no
  child actor in any snapshot along real folds. Positive controls prove the scanner flags each forbidden kind.

## Commands and results
- `bun test --timeout=30000 ./test/task/verify-spec-RM2.spec.ts` (packages/opencode): 4 pass, 0 fail, 520 expect(), 31.3 s.
- `state.mjs <spec> verdict RM2 trusted --reason ...` -> {"verdict":"trusted","trustLevel":"trusted"}.

## Outcome
Trusted. No gap.
