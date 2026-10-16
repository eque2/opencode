# RM8a verification journal (eque2-verifier, action: verify, batch RM7, RM8a, RM8b, RM8c, RM9)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for RM8a only. No semantic verdict in this dispatch.
- State at start: RM8a not_started, untrusted, retryCount 0. No prior RM8a journal.
- No sibling verify spec covers RM8a. engine-xstate.test.ts and core-command.test.ts hold RM8a unit tests, but they
  are not scenario files; I write the registered file packages/opencode/test/task/verify-spec-RM8a.spec.ts.
- Plan: store two whole-spec slices in the old form (base 2c0214ab71 wrote 16 fact types; run.started without a path)
  through the real event store; the latest ends with run.ended done. Fold them through the engine API, check the
  slice choice (`TaskCommand.sliceOf`), then run the real `/task` (`TaskCommand.run` through test/task/lib/command.ts)
  in a seeded git instance and read the stored facts back. I used the scenario file itself for one design probe of
  the folds (console output only; replaced by the test).
- Write only the test file; no source edit; commit nothing; never read evidence or key files.

## 2026-10-16 OUTCOME (test file written, Layer 1+2)
- Wrote packages/opencode/test/task/verify-spec-RM8a.spec.ts: 4 tests, each title starts with `[RM8a]`, no describe.
  Three pure tests (store shape and decode; every fact moves the snapshot; run.ended as a stop) and one instance test
  (real event store, real `/task`, `jobs.mode = "run"`, then a cancel and an interrupt to clean up).
- The stored aggregate holds two old-form slices: an earlier slice stopped by the user (T1.2 needs_human, T1.3 failed,
  run.cancelled) and the latest slice ending with run.ended done. Together: the 16 fact types of the base 2c0214ab71
  FactSchema. No fact has a path.
- A design probe (inside the scenario file, replaced) showed every fact moves an active snapshot, and that a run.ended
  done on the latest slice gives stop { state: done }, outcome done, every unfinished unit cancelled.
- Contrast assertions: the same slice without its run.ended resumes as a whole-spec slice (`sliceOf` resume), and a
  run.ended failed gives outcome failed with the stop's reason.
- Trial runs: 4 pass, 0 fail, 141 expect() calls, about 3.5-4 s (twice). tsgo clean (after a readonly-type fix and a
  `lastOf` helper for oxlint consistent-return), oxlint 0 warnings, prettier clean (new file).
- `update RM8a start`: not_started -> executing (before the rate-limit pause; not repeated after it).
- Real run 20261016T120955Z-23bebd through the adapter at HEAD 62554af3aa (test file untracked, sha256 prefix
  da3d615d2032831a): bun exit 0, 4 pass, 0 fail, 0 skip, 141 expect() calls. Decision: handed-off, adapter exit 0.
- `verify RM8a --evidence=<spec>/evidence/RM8a.json`: structural pass; testInCommit false, as expected. State
  completed, trust untrusted -> verified.
- No gap found in the code for RM8a.
