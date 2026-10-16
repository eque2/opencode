# SV5 verification journal (eque2-verifier, action: verify, batch SV1-SV5)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for SV5. No semantic verdict in this dispatch.
- State at start: SV5 not_started, untrusted. No prior SV5 journal, no test file.
- Plan:
  1. `update SV5 start`.
  2. Write packages/opencode/test/task/verify-spec-SV5.spec.ts: the real RunSupervisor machine as a root actor on a
     SimulatedClock (the only way to advance its timers by exactly 5 s), with the real touch, stale-check and record
     workers, a real Recorder whose status writer writes status.json for real (the write is wrapped only to count),
     the real event store, and the T1.5 subtree plan of release-notes (a live run with no unit to supervise, so the
     only writes are the run's own). The checkout lock is held from the start, so the real stale check waits on it.
  3. Assert: +5 s gives exactly one more write, the same snapshot with a newer aliveAt, in the file too, while the stale
     check still waits; a touch whose write fails (status.json made a directory) is logged and records no fact, and the
     heartbeat goes on; a touch worker that fails is logged by the supervisor and records no fact; the run wall clock
     records run.ended failed when it expires, while the stale check still waits.
  4. Trial runs, one adapter run, `verify SV5`.

## 2026-10-16 OUTCOME (Layer 1+2)
- `update SV5 start`: not_started -> executing.
- Test file written: packages/opencode/test/task/verify-spec-SV5.spec.ts (4 tests, each title starts with `[SV5]`).
  The real RunSupervisor machine on a SimulatedClock, the real touch, stale-check and record workers, a real Recorder
  writing status.json (the write wrapped only to count), the real event store, the T1.5 subtree plan.
- Test fixes during trials: (1) the cadence follow-up uses +3 s (nothing) then +2 s (one touch), because the
  heartbeat re-arms when its touch ends, which can be at the increment's end; (2) after run.ended is stored the test
  waits for the run actor's fold, because the Recorder stores first and sends second.
- Trial runs: 4 pass, 0 fail (twice). tsgo clean for the file, oxlint 0 warnings, prettier clean (new file).
- Real run 20261016T123421Z-b9eb50 through the adapter at HEAD 1c0823d35a (file untracked, sha256 prefix
  873bdfd4cb189dc1): bun exit 0, 4 pass, 0 fail, 40 expect() calls, 5.3 s. Decision: handed-off.
- `verify SV5`: structural pass (testInCommit false). State completed, trust untrusted -> verified.
- Notes for the semantic verifier: "a touch that fails" is covered two ways: the real write of a touch fails
  (status.json made a directory; TaskStatus.write logs it) and a touch worker that fails (a stand-in, since the real
  touch, a queue offer, cannot fail; the run supervisor logs it). Neither records a fact; the heartbeat goes on.
