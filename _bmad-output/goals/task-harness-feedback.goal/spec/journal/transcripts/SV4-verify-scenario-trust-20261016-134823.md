# SV4 verify-scenario-trust transcript

## What I read
- journal/scenario/SV4.md, tasks.md T2.10 and T2.11, core/command.ts (`job`, the claim and the job start),
  core/supervise/run.ts (`cancel`, `untilClosed`, the timer regions), workers.ts `staleCheck` (checkout.withPermit),
  limits.ts (scripted cancelDeadline 1 s), the SV4 tests in supervise-run.test.ts.
- packages/opencode/test/task/verify-spec-SV4.spec.ts (committed; sha256 prefix 7cefced1b7c5fd0c).

## Gherkin steps and their assertions
- Given a live run whose supervisor checks the spec under the checkout lock: the lock is held from the claim on;
  staleCadence is `checking` just before the cancel; the T1.1 proof process and its child are alive; a T1.2 builder
  turn is in flight; the stored facts are exact.
- When the background job is cancelled: the real `registry.cancel(id)`.
- Then run.cancelled is in the store (after run.resumed) and in the status file (run.state cancelled).
- And the run scope closes only after the supervisor is final or stopped: removeRun happens; the last step is the
  lease release; every release after removeRun sees done or stopped; the supervisor is out of the system.
- And no session turn or proof process outlives the cancel deadline: each turn ended by cancel + 1 s with a session
  cancel sent; both proof pids are gone at that bound.

## Commands and results
- `bun test --timeout=30000 --reporter=junit ... ./test/task/verify-spec-SV4.spec.ts` (packages/opencode, HEAD
  f57285510d): exit 0, 1 pass, 0 fail, 19 expect(), 6 s.
- `state.mjs verdict SV4 trusted --reason ...`: trustLevel trusted.

## Outcome
Trusted. Residual observation: the force-stop at cancelDeadline is not exercised by any test I found.
