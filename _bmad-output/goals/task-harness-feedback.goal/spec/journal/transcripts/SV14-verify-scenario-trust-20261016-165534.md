# SV14 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier, spawned by the develop-spec orchestrator (batch SV11-SV15).

## Read
- journal/scenario/SV14.md, spec.md "Verification Intent", tasks.md T2.12 (SV14 line) and T2.13.
- packages/opencode/test/task/verify-spec-SV14.spec.ts (committed in 237e47bfa1).
- src/task/core/supervise/task.ts (watching `after streamIdle`, spendCap guard, `ended` guards), hooks.ts,
  sessions.ts imports, workers.ts sessionEvents.
- Cross-check grep of sessions.ts and hooks.ts: no let, loop, sleep, repeat, Schedule, Ref, Map or builderTurn.

## Gherkin step -> assertion
- Given the session watch and hook modules after phase 2 -> sessions.ts and hooks.ts whole, plus sessionEvents,
  toolEvents, statusEvent, of and TurnEvent from workers.ts; the extraction is asserted complete.
- When they are inspected / Then no Ref, no MutableHashMap and no polled loop -> the AST scan returns []; the planted
  negative control finds all 15 constructs (2 module-level mutables, 3 endless loops); the exports hold no
  builderTurn and no hook maps, take*, watch or unwatch.
- And stall, idle and the spend cap are delayed transitions and guards -> the real node tree: `after streamIdle`
  -> stalling in watching only; spendCap guard on turn.status; `ended` always rows capped, repeated, readied,
  nudgeLeft, unready; the guards and delay are machine implementations. Live on a SimulatedClock: the stall records
  only at 2000 ms of the supervisor's clock, never from 3 s of wall time; nudge and spend cap record with the clock still.

## Commands
- `bun test --timeout=30000 ./test/task/verify-spec-SV14.spec.ts` (packages/opencode): 6 pass, 0 fail, 80 expect, 17.4 s.
- `state.mjs <spec> verdict SV14 trusted --reason ...`: exit 0, trustLevel trusted.

## Outcome
Trusted. No gap. The scan of workers.ts covers the watch actor only, by the scenario's scope.
