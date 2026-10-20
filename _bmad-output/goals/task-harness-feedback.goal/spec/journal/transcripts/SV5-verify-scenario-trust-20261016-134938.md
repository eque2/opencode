# SV5 verify-scenario-trust transcript

## What I read
- journal/scenario/SV5.md, tasks.md T2.4 and T2.10, core/supervise/run.ts (the heartbeat, wallClock and staleCadence
  regions), core/recorder.ts (`touch` is a sliding-queue offer), core/status.ts (`write` logs a failed write),
  workers.ts `staleCheck` (checkout.withPermit).
- packages/opencode/test/task/verify-spec-SV5.spec.ts (committed; sha256 prefix 873bdfd4cb189dc1).

## Gherkin steps and their assertions
- Given a live run whose stale check is held on the checkout lock: another fiber holds the lock; staleCadence is
  `checking` after 1 s; the run actor is active; only run.started is stored.
- When the clock advances by 5 seconds: `SimulatedClock.increment(5000)` on the real run supervisor.
- Then the status file is touched once with a newer heartbeat: exactly one write, the same status, a larger aliveAt,
  and the file holds it; the stale check still waits; no fact. +3 s nothing, +2 s one more touch.
- And a touch that fails is logged and records no fact: (a) the real write fails (status.json is a directory),
  "the status write failed" is logged, no fact, the heartbeat goes on, the next touch writes; (b) a failing touch
  worker (stand-in, because the real touch cannot fail) runs the supervisor's onError 3 times, each logged, no fact,
  the run stays active.
- And the run wall clock records run.ended in state failed when it expires: 1 s short nothing; at expiry run.ended
  {state failed, reason "wall clock: the run took over 30 min"}; the run actor is failed and done; the file says
  failed; the supervisor closes.

## Commands and results
- `bun test --timeout=30000 --reporter=junit ... ./test/task/verify-spec-SV5.spec.ts` (packages/opencode, HEAD
  f57285510d): exit 0, 4 pass, 0 fail, 40 expect(), 4 s.
- `state.mjs verdict SV5 trusted --reason ...`: trustLevel trusted.

## Outcome
Trusted. The stand-in hides no behaviour under test. No gap.
