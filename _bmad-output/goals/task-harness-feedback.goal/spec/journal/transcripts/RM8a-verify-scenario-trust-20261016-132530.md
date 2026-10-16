# RM8a verify-scenario-trust transcript

Fresh-context Layer 3 reviewer (eque2-verifier), batch RM7, RM8a, RM8b, RM8c, RM9.

## Read
- spec.md, scenarios.gherkin (RM8a), tasks.md (T1.6, T1.7, T1.11, T2.11 rows).
- journal/scenario/RM8a.md (Layer 1+2 record).
- packages/opencode/test/task/verify-spec-RM8a.spec.ts (committed b9553cc37d; not changed since).
- packages/opencode/test/task/lib/command.ts, lib/supervise.ts (`eventually`), lib/machine.ts.
- `git show 2c0214ab71:packages/opencode/src/task/core/events.ts`: the old FactSchema has 16 fact types; run.started
  and run.resumed carry `base` (optional) and no `path`.

## Gherkin step -> assertion
| Step | Assertion |
|---|---|
| Given a stored old slice, run.started without a path, run.ended done | Stored fact types equal the 16 old types; no fact has `path`; slices = [earlier, latest]; latest starts `{ run.started, base }` and ends `{ run.ended, state: done }`. |
| When folded through the new machine and /task runs on the whole spec | Each fact applied one at a time (`engine.apply`) and by `TaskEvents.fold`; the real `TaskCommand.run` in a seeded git instance with the real event store. |
| Then every stored fact decodes and folds | Each fact decodes to itself with the current `FactSchema`; the real store reads back exactly the stored list; each apply meets an active snapshot and returns a new snapshot (no unmatched fact); both slices end; the harness fold equals the step fold. |
| and the stored run.ended folds as a stop with its own state | Before: running, no stop. After: `stopOf` = `{ state: done }`, run done, last history run running -> done, tasks and unfinished scenarios cancelled, S2 stays trusted. Contrast: run.ended failed -> stop and run failed with the reason. |
| And /task records run.started for a new slice, because the old slice ended | `sliceOf` = new; without run.ended `sliceOf` = resume (causal contrast); /task reply is the header alone; the first appended fact is `{ run.started, path: spec, base: branch }`; no run.resumed; old facts unchanged; 3 slices, the new one latest. |

## Commands
- `node state.mjs <spec> query scenario/RM8a` -> completed, trust verified.
- `bun test --timeout=30000 ./test/task/verify-spec-RM8a.spec.ts` (packages/opencode) -> 4 pass, 0 fail, 141 expect() calls, 7.7 s.
- `node state.mjs <spec> verdict RM8a trusted --reason ...` -> `{"verdict":"trusted","trustLevel":"trusted"}`.

## Outcome
Trusted. No gap.
