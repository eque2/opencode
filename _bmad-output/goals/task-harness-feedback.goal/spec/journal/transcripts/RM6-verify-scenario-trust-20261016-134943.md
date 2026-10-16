# RM6 verify-scenario-trust transcript

Role: fresh-context semantic verifier (eque2-verifier), batch RM2-RM6. No source or test file changed.

## What I read
- `state.mjs query scenario/RM6`: completed, trustLevel verified. tasks.md T1.6. journal/scenario/RM6.md.
- packages/opencode/test/task/verify-spec-RM6.spec.ts; src/task/engine-xstate/index.ts (`applyTo`, `apply`,
  `initial`); test/task/lib/machine.ts.

## Gherkin step -> assertion
- Given a snapshot of a running release-notes run: fold through `engine.initial`/`apply`; asserted status `active`,
  run `running`, T1.1-T1.3 trusted, T1.4 building, T1.5 and T1 waiting, S1 waiting.
- When a fact that matches no row is applied: 12 such facts (wrong state for the unit, or unknown ids T7, T7.c1,
  S99, T42, or outside.trusted naming a task).
- Then the identical snapshot is returned and the input is not mutated: `next === running`; full snapshot text
  unchanged; log length unchanged; fact unchanged; deep-frozen input folds every fact type with no write and equals
  an unfrozen twin.
- And a fact on an ended run returns that snapshot unchanged: five ended runs (cancel, run.ended done/failed,
  observed + stop, cascade settled), status `done`; 21 facts each return the identical snapshot; control: the port's
  raw `transition` does step a done snapshot.
- And a snapshot made by another machine makes apply die: cascade snapshot, second load of the same spec, a machine
  rebuilt from the plan's own config, a later cascade snapshot: each a die (no typed failure) naming "another plan's
  machine"; the plan's own snapshot is accepted.

## Commands and results
- `bun test --timeout=30000 ./test/task/verify-spec-RM6.spec.ts`: 3 pass, 0 fail, 211 expect(), 4.5 s.
- `state.mjs <spec> verdict RM6 trusted --reason ...` -> {"verdict":"trusted","trustLevel":"trusted"}.

## Outcome
Trusted. No gap.
