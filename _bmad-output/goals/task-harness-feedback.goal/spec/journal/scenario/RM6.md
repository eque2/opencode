# RM6 verification journal (eque2-verifier, action: verify, batch RM2-RM6)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario RM6. No semantic verdict in this dispatch.
- State at start: RM6 not_started, untrusted, retryCount 0. No prior RM6 journal. The test file does not exist.
- Plan: write packages/opencode/test/task/verify-spec-RM6.spec.ts against the real engine and the release-notes plan:
  facts that match no row return the identical snapshot and leave the input (and the fact) unchanged; every stored
  fact type on runs that ended in each way returns the snapshot unchanged (with the port's raw `transition` as a
  control); snapshots of another plan's machine, of a second load of the same spec and of a rebuilt machine make
  `apply` die. Then `update RM6 start`, one adapter run, `verify RM6`.
- I write only the scenario test file. No source edits, no commits, no evidence or key reads.

## 2026-10-16 OUTCOME (test written, Layer 1+2)
- `update RM6 start`: not_started -> executing.
- Wrote packages/opencode/test/task/verify-spec-RM6.spec.ts (3 tests, titles start with `[RM6]`). It drives the real
  loader and the engine's `initial`, `apply`, `view`, `unitState` and `ended` on the release-notes and cascade plans.
- First trial: the observed release-notes facts alone do not end the run (scenarios S1-S3 still wait for proofs), so
  I replaced that case with the observed facts plus a stop, and added a cascade run that settles by itself.
- Trial: 3 pass, 211 expect() calls, about 4 s. tsgo: no error in this file. oxlint 0, prettier clean.
- Real run 20261016T123631Z-f586e1 at HEAD 1c0823d35a (sha256 prefix ff81d8441aeb3579): bun exit 0, 3 pass,
  handed-off, adapter exit 0. `verify RM6`: structural pass; state completed, trust untrusted -> verified.
- No code defect found.

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context semantic verifier, batch RM2-RM6)
- Action: verify-scenario-trust (Layer 3). State at start: RM6 completed, trustLevel verified.
- Plan: read the RM6 Gherkin, tasks.md T1.6, the test file and `applyTo` in index.ts; map each step to an assertion;
  run the file myself; then call `verdict RM6` exactly once. No source or test edits.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- My own bare run: verify-spec-RM6.spec.ts -> 3 pass, 0 fail, 211 expect(), 4.5 s.
- Each Gherkin step has a real assertion on the real loader and engine (map in the transcript); controls prove the
  ended-run guard is the engine's, not the port's.
- `verdict RM6 trusted` -> {"verdict":"trusted","trustLevel":"trusted"}. No gap.
