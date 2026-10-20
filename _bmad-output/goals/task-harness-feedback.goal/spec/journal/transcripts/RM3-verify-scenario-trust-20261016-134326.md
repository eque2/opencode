# RM3 verify-scenario-trust transcript

Role: fresh-context semantic verifier (eque2-verifier), batch RM2-RM6. No source or test file changed.

## What I read
- `state.mjs query scenario/RM3`: completed, trustLevel verified. tasks.md T1.6. journal/scenario/RM3.md.
- packages/opencode/test/task/verify-spec-RM3.spec.ts; src/task/engine-xstate/index.ts;
  the old module `git show b517ebb3f3^:packages/opencode/src/task/engine-xstate/index.ts` (old names and
  `XStateEngine: Engine = { name: "xstate", initial, apply }` over `State`).

## Gherkin step -> assertion
- Given the engine module / When exports and definitions are inspected: runtime exports of index.ts, machine.ts,
  alphabet.ts, core/events.ts; comment-stripped source; engine file set pinned to those four files.
- Then no obligation, task, scenario or run machine beside the generated machine: no export of the four names; no
  exported value is a machine; exactly one `createMachine` call (fromConfig, called by `machine(plan)`), no `setup`;
  the four names are not identifiers anywhere in `src`; snapshots belong to `machine(plan)` and hold no child actor.
- And no stepTask, stepRun, cancel, staleAlone or follows code: none is an identifier in the engine module; all but
  `cancel` are absent from all of `src` (`cancel` stays as job code outside the engine module). Scanner control proves
  it finds the old shapes and ignores comments and longer names.
- And XStateEngine keeps its name and initial and apply over an opaque snapshot: keys `apply, initial, name`;
  `name === "xstate"`; arities 1 and 3; source types over `RunSnapshot = SnapshotFrom<RunMachine>`; no function takes
  `State`; the runtime snapshot has no `run/tasks/obligations/scenarios/history` field; read through `view`/selectors.

## Commands and results
- `bun test --timeout=30000 ./test/task/verify-spec-RM3.spec.ts`: 4 pass, 0 fail, 99 expect(), 5.5 s.
- `grep -rn -w cancel src/task/engine-xstate src/task/core/events.ts`: one comment line only.
- `state.mjs <spec> verdict RM3 trusted --reason ...` -> {"verdict":"trusted","trustLevel":"trusted"}.

## Outcome
Trusted. No gap.
