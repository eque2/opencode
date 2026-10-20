# SV4 verification journal (eque2-verifier, action: verify, batch SV1-SV5)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for SV4. No semantic verdict in this dispatch.
- State at start: SV4 not_started, untrusted. No prior SV4 journal, no test file.
- Plan:
  1. `update SV4 start`.
  2. Write packages/opencode/test/task/verify-spec-SV4.spec.ts on the real `/task` command and the real core
     BackgroundJob registry in a seeded git instance with scripted limits (cancelDeadline 1 s). Given: a resumed slice
     in which T1.1 is proving a committed test that never ends (a real `bun test` process and a child in its group),
     T1.2 begins and its builder turn runs, and the checkout lock is held from the claim on, so the run supervisor's
     stale check waits on it (staleCadence `checking`).
  3. When `registry.cancel(<runID>)`: assert run.cancelled in the store and in status.json; the last lease release
     (the run scope's first finalizer, so its last step) sees the run supervisor done or stopped, after removeRun;
     every builder turn ended and its session cancel was sent, and both proof processes are gone, within the cancel
     deadline of the cancel (measured).
  4. Trial runs, one adapter run, `verify SV4`.

## 2026-10-16 OUTCOME (Layer 1+2)
- `update SV4 start`: not_started -> executing.
- Test file written: packages/opencode/test/task/verify-spec-SV4.spec.ts (1 test, title starts with `[SV4]`).
  Real `/task`, real core BackgroundJob registry and its `cancel`, real supervisors, workers, Recorder and proof
  process; the harness root is wrapped only to hold the checkout lock from the claim on and to note the supervisor's
  status at each release and removal.
- Measured in a trial (timing log removed before the real run): the cancel returned 101 ms after it started; the
  builder turn ended and its session cancel was sent at 95 ms; both proof processes were gone at 103 ms; the order
  was release:active (the supervisor's own release, UI24), removeRun:done, release:done.
- The bound in the test is the literal one: every turn ended and both processes gone by cancel + cancelDeadline (1 s).
- Trial runs: 1 pass, 0 fail (three times). tsgo clean for the file, oxlint 0 warnings, prettier clean (new file).
- Real run 20261016T123030Z-9f0892 through the adapter at HEAD ca3b28b82d (file untracked, sha256 prefix
  7cefced1b7c5fd0c): bun exit 0, 1 pass, 0 fail, 19 expect() calls, 4.8 s. Decision: handed-off.
- `verify SV4`: structural pass (testInCommit false). State completed, trust untrusted -> verified.

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context reviewer, batch SV1-SV5)
- Action: Layer 3 semantic trust for SV4. State at start: completed, trust verified.
- Plan: read the test file, tasks T2.10/T2.11, the cancel finalizer; judge each Gherkin step, including the writer's
  note that the test does not exercise a cancel that reaches its deadline; run the test myself; call `verdict SV4`
  exactly once. I change no source or test file. I commit nothing.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- My own run at HEAD f57285510d (file committed, sha256 prefix 7cefced1b7c5fd0c): exit 0, 1 pass, 0 fail, 19 expect(), 6 s.
- I checked command.ts: it calls `harness.claim` directly and passes the wrapper into the job, so the lock hold and
  the release and removeRun notes are real. The wrapper changes nothing else.
- Each Gherkin step has a real assertion. The stale check in the Given can never finish by itself.
- Observation (not a Gherkin gap): the branch where the cancel finalizer reaches cancelDeadline and force-stops the
  supervisor is not exercised here or in supervise-run.test.ts. The Gherkin accepts "final or stopped".
- Verdict: `verdict SV4 trusted` -> state completed, trustLevel trusted.
