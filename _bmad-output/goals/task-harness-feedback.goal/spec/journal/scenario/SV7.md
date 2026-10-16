# SV7 verification journal (eque2-verifier, action: verify, batch SV6-SV10)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for SV7. No semantic verdict in this dispatch.
- State at start: SV7 not_started, untrusted. No prior SV7 journal, no test file.
- Plan:
  1. `update SV7 start`.
  2. Write packages/opencode/test/task/verify-spec-SV7.spec.ts on the real Recorder, the real event store and the
     real TaskSupervisor machines:
     - Two task supervisors (T1.1, T1.2 building, turns that hang) share one SimulatedClock, so one increment fires
       both stall timers at the same moment; three rounds. Store order (TaskEvents.read) equals fold order (the run
       actor's log), entry by entry with `at`; the stored `at` never decreases. A burst of 2 x 20 facts through the
       real `record` worker at once checks the same.
     - A record after the run is done stores nothing: after run.cancelled ends the run, both supervisors stall again
       and their records store nothing; a record that queued behind the ending fact stores nothing.
     - An interrupted record: interrupted while it waits on the permit -> nothing; interrupted inside the store write
       -> the whole fact, stored and folded; a sweep of 30 records interrupted at random times -> each one stored and
       folded, or neither. The store write is held by a wrapper of the event store's publish (an instrument at the
       store boundary; the Recorder is not touched).
  3. Trial runs, one adapter run, then `verify SV7` (note: `verify SV6` was denied by the permission system; I will
     not retry `verify` and will report it).

## 2026-10-16 OUTCOME (Layer 1+2)
- `update SV7 start`: not_started -> executing.
- Test file written: packages/opencode/test/task/verify-spec-SV7.spec.ts (5 tests, each title starts with `[SV7]`):
  two real task supervisors stalling on one SimulatedClock increment (3 rounds, 6 facts); a burst of 40 records at
  once through the real record worker; records after run.cancelled ended the run (one queued behind the end, the
  two supervisors' stalls, a later record worker): nothing stored, no failure; an interrupt while queued on the
  permit (nothing) and inside the held store write (the interrupt waits; the whole fact is stored and folded); a
  sweep of 30 records interrupted at random 0-3 ms (stored list equals folded list).
- Trial run: 5 pass, 0 fail (105 s at load 127), first try. tsgo --noEmit: no diagnostic. oxlint: 0 warnings.
  prettier: written (new file).
- Real run 20261016T140759Z-12c4a2 through the adapter at HEAD 9b96863f72 (file untracked, sha256 prefix
  b60135c492e7f3d5): bun exit 0, 5 pass, 0 fail, 77 expect() calls, 53 s. Decision: handed-off; evidence/SV7.json
  written by the reporter.
- `verify SV7`: NOT called. The permission system denied `verify SV6` as "Self-Approval"; I do not repeat a denied
  action. SV7 stays executing with signed evidence; the orchestrator (or the owner) must run `verify SV7`.
- Note for the semantic verifier: the sweep cannot force both outcomes; the deterministic test proves each outcome.
