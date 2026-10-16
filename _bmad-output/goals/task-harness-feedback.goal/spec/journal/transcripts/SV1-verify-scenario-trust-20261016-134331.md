# SV1 verify-scenario-trust transcript

## What I read
- The dispatch prompt, references/guardrails.md, semantic-verify-scenario/SKILL.md.
- journal/scenario/SV1.md (the writer's verify entries), spec.md, tasks.md T2.10-T2.13, spine AD-17.
- packages/opencode/test/task/verify-spec-SV1.spec.ts (committed; sha256 prefix f9ae7f1d4d6896cb).
- Source: core/harness.ts, core/supervise/run.ts; a grep of src/task for Ref, MutableHashMap, FiberMap,
  while (true), setInterval, Schedule.spaced, Effect.repeat, new Map/Set, module `let`, and the runner names.

## Gherkin steps and their assertions
- Given the harness source after phase 2: `core/runner.ts` absent; no import of a runner; the scan file list holds
  the phase-2 modules.
- When it is inspected: a TypeScript-AST scan of every .ts file under src/task; a negative control on a planted
  source asserts each detector fires.
- Then no polled loop / tick counter: `polls` equals the two AD-17 entries; no module-level let/var; no let outside
  a function.
- Stale cadence counter: STALE_EVERY absent; the run supervisor config has `after: { stale: "checking" }`, 1000 ms.
- Failure map: `cells` is empty (no Ref, MutableHashMap, HashMap, Map, Set).
- Failure limit: MAX_FAILURES absent; each FAILURE_LIMIT use is in `guards` over `context.*failures + 1 <`.
  Accepted reading: T2.12 names MAX_FAILURES, SV6 needs a 3-failure rule, and xstate holds it.
- Stopping flag, children list, worker FiberMap: `heldNames`, `fiberCollections`, `forksKept` empty; fork sites pinned.
- Judged-state list: no state-name list outside the AD-17 entries.
- Process-wide run registry: only the two WeakMap<Plan> memos at module level; only their own `set` writes.
- And a live run is found through the actor system by its run id: the real `/task` command and BackgroundJob
  registry; `system.get(run:<id>)` is Some with `context.run.id` equal; `task:<id>:T1.1` found; a second harness
  root does not see it; after cancel the system holds neither.

## Commands and results
- `state.mjs query scenario/SV1`: completed, verified.
- `bun test --timeout=30000 --reporter=junit ... ./test/task/verify-spec-SV1.spec.ts` (packages/opencode,
  HEAD f57285510d): exit 0, 8 pass, 0 fail, 43 expect(), 8 s.
- `state.mjs verdict SV1 trusted --reason ...`: trustLevel trusted.

## Outcome
Trusted. No gap.
