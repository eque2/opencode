# SV9 verification journal (eque2-verifier, action: verify, batch SV6-SV10)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for SV9. No semantic verdict in this dispatch.
- State at start: SV9 not_started, untrusted. No prior SV9 journal, no test file.
- Plan:
  1. `update SV9 start`.
  2. Write packages/opencode/test/task/verify-spec-SV9.spec.ts: real `/task` runs in a seeded git instance (the
     real command, harness root, Recorder, run, task and scenario supervisors, workers, proofs and merges), with a
     scripted session side that acts through the real hook routing (`TaskHooks.sendReady`, `sendVerdicts`,
     `repetitionStop` on `harness.hooks`). Every fact a run stores came from a supervisor, so the test replays the
     stored facts through the pure fold and checks each one against `TaskAlphabet.alphabet` of the snapshot just
     before it, or the exception list of the Gherkin. Reading: a fact is "in the alphabet for that state" when the
     alphabet of that snapshot holds a fact of the same type for the same unit (the alphabet's payloads are
     abstract by design). An external trust is checked against the start-up step (the alphabet keys it on an empty
     log; a real run records it straight after run.started).
     - example-scenarios, happy path with stray hooks: task leaf ready/building/proving/verifying, parent
       ready/verifying, scenario ready/verifying.
     - example-cascade: nudges, the unready proof, a repetition, a gate that fails, a budget exhausted, blocked units.
     - release-notes subtree T1.5: external trusts at start-up, a forwarded outside trust, spec checks, a cancel.
  3. Trial runs, one adapter run. `verify SV9` is not called: the permission system denied `verify SV6`.

## 2026-10-16 OUTCOME (Layer 1+2)
- `update SV9 start`: not_started -> executing.
- Test file written: packages/opencode/test/task/verify-spec-SV9.spec.ts (4 tests, each title starts with `[SV9]`):
  three real `/task` runs (example-scenarios happy path with stray hooks, run done; example-cascade with two nudges,
  an unready proof, a repetition, a budget exhausted and two blocked units; release-notes T1.5 subtree with two
  external trusts at start-up, a forwarded T9 trust, ignored trusts of T1.4 and T1.5, two spec checks and a cancel),
  and a negative control of the replay check (out-of-state facts and a late external trust are NOT ALLOWED).
  Covered unit kinds and states: leaf ready/building/proving/verifying, parent ready/verifying, scenario
  ready/verifying, outside waiting, external waiting (start-up). No fact was NOT ALLOWED.
- Test fixes during trials: (1) the label of the run unit before run.started is `run:waiting` (an expected-value fix
  of a label, not of a check); (2) oxlint consistent-return: explicit `return yield* Effect.void`.
- Trial runs: 2 pass 1 fail (the label), then 3 pass, then 4 pass (twice; 14-69 s). tsgo: no diagnostic for the
  file (it reports an error in another verifier's verify-spec-SV16.spec.ts, not mine). oxlint: 0 warnings.
- Real run 20261016T142643Z-b5750a through the adapter at HEAD ab738d620f (file untracked, sha256 prefix
  7f67ba750b0a6bd1): bun exit 0, 4 pass, 0 fail, 24 expect() calls, 32 s. Decision: handed-off; evidence/SV9.json
  written by the reporter.
- `verify SV9`: NOT called (the permission system denied `verify SV6` as "Self-Approval"). SV9 stays executing with
  signed evidence; the orchestrator (or the owner) must run `verify SV9`.
- Finding for the owner (wording, not a code defect): the alphabet keys an external region's trust on an empty log
  ("the start-up step"), but a real run records it straight after its own run.started (log length 1). The test
  accepts an external trust only in that start-up step and only when the empty-log alphabet holds it; the negative
  control shows a later external trust is refused. The Gherkin's exception list does not name it.
