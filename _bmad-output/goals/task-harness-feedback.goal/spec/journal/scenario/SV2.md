# SV2 verification journal (eque2-verifier, action: verify, batch SV1-SV5)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for SV2. No semantic verdict in this dispatch.
- State at start: SV2 not_started, untrusted. No prior SV2 journal, no test file.
- Plan:
  1. `update SV2 start`.
  2. Write packages/opencode/test/task/verify-spec-SV2.spec.ts. Given: the release-notes plan folded from a stored
     slice where T1.1 and T1.2 are trusted, S2 proved passed (verifying), S3 and S7 proved failed; so T1.3 is the one
     ready leaf and S2 the one verifying scenario. The real RunSupervisor is spawned in a real TaskHarness system with
     the real task and scenario supervisors, real workers, a real Recorder over the real event store, a scratch git
     repository and a scripted session boundary (the judge answers through the real hook routing).
  3. Assert: one task supervisor for T1.3 and one scenario supervisor for S2 and none for any other unit; each records
     its phase outcome (task.started, task.needs_human, scenario.verified) through the Recorder (stored, folded, and
     seen by the Recorder's record); each supervisor stops when its unit leaves the ready/active/verifying tags while
     the run goes on; the run machine has no invoke and spawns no child.
  4. Trial runs, one adapter run, `verify SV2`.

## 2026-10-16 OUTCOME (Layer 1+2)
- `update SV2 start`: not_started -> executing.
- Test file written: packages/opencode/test/task/verify-spec-SV2.spec.ts (5 tests, each title starts with `[SV2]`).
  Real RunSupervisor in a real TaskHarness system, real task and scenario supervisors and workers, real Recorder over
  the real event store, scratch git repository; the Recorder's `record` is wrapped only to list what it receives.
- One test fix during trials: the run machine has no `implementations.actors` key at all (read as none). I added a
  control: the same state-node walk finds the run supervisor's invokes.
- Trial runs: 5 pass, 0 fail (twice). tsgo clean for the file, oxlint 0 warnings, prettier clean (new file).
- Real run 20261016T122405Z-761ca2 through the adapter at HEAD 9ae952134b (file untracked, sha256 prefix 8ea8b61091ab24df):
  bun exit 0, 5 pass, 0 fail, 63 expect() calls, 15.5 s. Decision: handed-off.
- `verify SV2`: structural pass (testInCommit false). State completed, trust untrusted -> verified.
- Notes for the semantic verifier: the stops are shown in two runs, each isolated from the run's end (S2 stops while
  T1.3 builds; T1.3 stops while S2 waits for its judge). The builder's stream idle time is 120 s in this test so that
  a quiet turn does not stall during the test; the stall rule is SV10's.
