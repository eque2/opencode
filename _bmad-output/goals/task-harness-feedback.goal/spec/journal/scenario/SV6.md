# SV6 verification journal (eque2-verifier, action: verify, batch SV6-SV10)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for SV6. No semantic verdict in this dispatch.
- State at start: SV6 not_started, untrusted. No prior SV6 journal, no test file.
- Plan:
  1. `update SV6 start`.
  2. Write packages/opencode/test/task/verify-spec-SV6.spec.ts with no worker stand-in: the real workers fail for a
     real reason (the root checkout is not a git repository), on a SimulatedClock so each 1 s retry is moved on
     exactly.
     - The real TaskSupervisor for the ready leaf T1.1 of release-notes: the real `begin` worker fails (git worktree
       prune fails); after failures 1 and 2 nothing is stored and the supervisor retries; after failure 3 it records
       task.failed with "harness error: <the git error>", and the run actor folds T1.1 to failed.
     - The real RunSupervisor on example-scenarios with T1.1 and T1 trusted, so S1 is ready: the real batch worker
       (scenarioProof) fails three times; then scenario.proved S1 failed with "harness error: <the git error>".
     - The real ScenarioSupervisor for a verifying scenario whose judge worker fails three times (the harness claim
       fails): scenario.verified rejected with "harness error: ...", its scenario fact.
  3. Trial runs, one adapter run, `verify SV6`.

## 2026-10-16 OUTCOME (Layer 1+2)
- `update SV6 start`: not_started -> executing.
- Test file written: packages/opencode/test/task/verify-spec-SV6.spec.ts (3 tests, each title starts with `[SV6]`).
  No worker stand-in: the root checkout is a directory with no git repository, so the real `begin` worker fails on
  `git worktree prune` and the real batch worker fails on `git rev-parse` of the base head; the judge test fails the
  harness `session.claim` input, so the real judge worker fails before its prompt. SimulatedClock for the 1 s retries.
- Test fix during trials: (1) the task supervisor reaches `quiet` after the record worker ends, which is after the fact
  is stored, so the test waits for `quiet` (it read the snapshot too early at load 133).
- Trial runs: 2 pass 1 fail (the read above), then 3 pass 0 fail (85 s at load 140). tsgo --noEmit: no diagnostic.
  oxlint --deny-warnings: 0 warnings. prettier: written (new file).
- Real run 20261016T135318Z-a1730b through the adapter (now at spec/journal/adapter/, the coordinator's instruction) at
  HEAD 2e6ff969e3 (file untracked, sha256 prefix 55ed302cea3261ce): bun exit 0, 3 pass, 0 fail, 30 expect() calls,
  66 s. Decision: handed-off. The reporter wrote evidence/SV6.json.
- `verify SV6 --evidence=...`: DENIED by the Claude Code permission system (auto mode classifier, reason
  "Self-Approval"). I did not retry it and used no other route. SV6 stays executing with signed evidence written;
  the orchestrator (or the owner) must run `verify SV6`.
