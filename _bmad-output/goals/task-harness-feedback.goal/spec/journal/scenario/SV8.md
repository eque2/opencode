# SV8 verification journal (eque2-verifier, action: verify, batch SV6-SV10)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for SV8. No semantic verdict in this dispatch.
- State at start: SV8 not_started, untrusted. No prior SV8 journal, no test file.
- Plan:
  1. `update SV8 start`.
  2. Write packages/opencode/test/task/verify-spec-SV8.spec.ts through the real `/task` command (TaskCommand.run),
     the real TaskHarness root, the real event store and a seeded git instance (lib/command `seed`), with the
     project's background-job registry helper (lib/command `backgroundOf`):
     - Given: a real live run of release-notes, started by `/task task-formats/blend/release-notes.spec` with the
       registry in "run" mode; builder prompts never end, so the run stays live and quiet.
     - When `/task` runs for another valid spec (example-scenarios), for a task folder of it, and for the same spec:
       each answer is exactly the one busy line (EXPERIENCE "Busy reply" text, written out in the test) naming the
       live run's spec and path; no job starts, no fact is stored for the other spec, the lease is unchanged and
       status.json still shows the live release-notes run.
     - A claim whose background job does not start (start dies; a job of that id already running) is released, so
       the next `/task` is not busy and starts its job.
  3. Trial runs, one adapter run. `verify SV8` is not called: the permission system denied `verify SV6`.

## 2026-10-16 OUTCOME (Layer 1+2)
- `update SV8 start`: not_started -> executing.
- Test file written: packages/opencode/test/task/verify-spec-SV8.spec.ts (2 tests, each title starts with `[SV8]`).
  A real live release-notes run started by `/task` (registry "run" mode; builder prompts never end): two task.started,
  running(live) true, the lease {runID, spec, path} held, status.json written. `/task` for example-scenarios, for its
  task folder T1-slugs.task and for release-notes each answers exactly the busy line (one line, no newline); no job
  starts, no fact for the other spec, the lease and status.json stay the live run's, the live run stores no new run
  fact. After a cancel the directory is free. Second test: start dies -> /task fails, lease free; "already going on"
  -> lease free; the next /task claims and starts its job.
- Trial run: 2 pass, 0 fail (4.9 s at load 43), first try. tsgo: no diagnostic. oxlint: 0 warnings. prettier: clean.
- Real run 20261016T141222Z-b0c9a2 through the adapter at HEAD f78d4d5720 (file untracked, sha256 prefix
  99627b7b8efe2291): bun exit 0, 2 pass, 0 fail, 44 expect() calls, 9 s. Decision: handed-off; evidence/SV8.json
  written by the reporter.
- `verify SV8`: NOT called (the permission system denied `verify SV6` as "Self-Approval"). SV8 stays executing with
  signed evidence; the orchestrator (or the owner) must run `verify SV8`.
