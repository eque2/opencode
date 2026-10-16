# RM8c verification journal (eque2-verifier, action: verify, batch RM7, RM8a, RM8b, RM8c, RM9)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for RM8c only. No semantic verdict in this dispatch.
- State at start: RM8c not_started, untrusted, retryCount 0. No prior RM8c journal.
- No sibling verify spec covers RM8c. I write the registered file packages/opencode/test/task/verify-spec-RM8c.spec.ts.
- Known reading issue (journal/task/T1.7-verify.md): the facts of the Gherkin header's definition alone leave S2, S3,
  S4, S7 and S12 ready, so under D3 their fold is not done. The old runner (base 2c0214ab71 runner.ts `schedule`)
  proved every waiting scenario whose needs were trusted, so the stored slice of the observed run also holds those
  scenario facts. Plan: store the observed slice in that form (each scenario proved and verified once its needs are
  trusted, interleaved as the old runner did), assert that the header facts alone are not done and that only those
  five scenarios keep the run open, and assert the RM8c steps on the stored slice. Then run the real `/task` on the
  stored slice in a seeded git instance.
- Write only the test file; no source edit; commit nothing; never read evidence or key files.

## 2026-10-16 OUTCOME (test file written, Layer 1+2)
- Wrote packages/opencode/test/task/verify-spec-RM8c.spec.ts: 3 tests, each title starts with `[RM8c]`, no describe.
  Two pure tests (the stored slice and the header facts; the fold) and one instance test (real event store, real
  `/task`, job running, then a cancel and an interrupt).
- The stored slice: run.started { base } with no path, then the fixture's observed facts with, after each trust, the
  proof and the verdict of each scenario that the trust made provable (S2, S7 after T1.1; S3 after T1.2; S4, S12 after
  T1.3), as the old runner's `schedule` did; no run.ended.
- Test 1 pins the reading: without the scenario facts the slice equals the observed facts; the observed facts alone
  fold to a running run in which exactly S2, S3, S4, S7, S12 are pending and every other scenario is blocked; those
  five are the scenarios whose needs are all among T1.1-T1.3, and the stored slice proves exactly them.
- Test 2: the stored slice folds to status done with no stop; outcome budget_exhausted with the exact reason; last
  history entry run running -> budget_exhausted; T1.4 budget_exhausted; T1.5 and T1 blocked by { T1.4,
  budget_exhausted }; one fact less is not done; a failed S3 and a rejected S4 give the same outcome.
- Test 3: `sliceOf` gives new for the stored slice and resume for one fact less; `/task` replies with the header alone
  and appends { run.started, base, path: <spec> } exactly, with no run.resumed; two slices, the new one latest.
- Trial runs: 3 pass, 0 fail, 45 expect() calls, about 4-6.6 s (twice). tsgo clean (after a run.started type fix),
  oxlint 0 warnings, prettier clean (new file).
- `update RM8c start`: not_started -> executing.
- Real run 20261016T121456Z-5639a1 through the adapter at HEAD 62554af3aa (test file untracked, sha256 prefix
  d79e132f87f02f8b): bun exit 0, 3 pass, 0 fail, 0 skip, 45 expect() calls. Decision: handed-off, adapter exit 0.
- `verify RM8c --evidence=<spec>/evidence/RM8c.json`: structural pass; testInCommit false, as expected. State
  completed, trust untrusted -> verified.
- Gap for the semantic verifier (spec wording, not code): the Gherkin header's definition of "the observed facts"
  omits the scenario facts that the old runner stored. Under D3 the header facts alone do not fold to done, and the
  test asserts that. The test proves RM8c on the stored slice with those scenario facts (the reading that
  journal/task/T1.7-verify.md accepted). If the owner reads RM8c literally, RM8c conflicts with D3.
