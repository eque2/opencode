# SV7 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier (semantic trust), batch SV6-SV10, OpenCode runtime.

## Read
- Dispatch prompt; guardrails.md; semantic-verify-scenario/SKILL.md; journal/scenario/SV7.md; tasks.md T2.4.
- Test `packages/opencode/test/task/verify-spec-SV7.spec.ts` (unchanged since 6841bc0e5d).
- Code: `src/task/core/recorder.ts`, `src/task/core/events.ts` (`read` by durable seq), `supervise/task.ts`,
  `test/task/lib/supervise.ts`.

## Gherkin step -> assertion
- Given two supervisors that record facts at the same moment -> test 1: real TaskSupervisor machines of T1.1 and
  T1.2 on one SimulatedClock; one 2 s increment fires both stall timers (3 rounds, 6 stalls). Test 2: 40 record-worker
  calls at once.
- When the Recorder stores and folds them -> the real TaskRecorder, real event store, real run actor.
- Then store order equals fold order and recorded times never decrease -> `sameOrder`: stored (durable seq) vs the
  run actor's log since the slice, unit, reason and `at` in order; `nonDecreasing` on stored `at`; counts 6 and 40,
  unique reasons in the burst.
- And a record after the run is done stores nothing -> test 3: run.cancelled makes the snapshot `done` (run
  `cancelled`); the stall queued behind it, both supervisors' later stalls and a later task.failed succeed but store
  nothing; the log is unchanged.
- And an interrupted record leaves either the whole fact or nothing -> test 4: interrupt on the permit -> nothing
  stored or folded; interrupt in the held store write -> the interrupt waits, the whole fact is stored and folded.
  Test 5: 30 random interrupts, stored list equals folded list.

## Gaps
- None against the Gherkin. The random sweep cannot force both outcomes; test 4 covers each deterministically.

## Commands
- `state.mjs <spec> query scenario/SV7` -> completed, verified.
- `bun test --timeout=30000 ./test/task/verify-spec-SV7.spec.ts` (packages/opencode) -> 5 pass, 0 fail, 11.6 s.
- `state.mjs <spec> verdict SV7 trusted --reason ...` -> exit 0, trustLevel trusted.

## Outcome
Trusted.
