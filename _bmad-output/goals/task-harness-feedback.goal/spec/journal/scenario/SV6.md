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

## 2026-10-16 INTENT (re-run in OpenCode, after the denied `verify`)
- State at start: SV6 executing, untrusted (query). No `update start`.
- Plan: read the committed test (6841bc0e5d) and judge that it drives the real code for each Gherkin step; change it
  only if it fails or misses a step; one trial run, one fresh adapter run, then `verify SV6 --evidence=...`. If
  `verify` is denied, stop and report it.

## 2026-10-16 OUTCOME (re-run in OpenCode)
- Judged the committed test (6841bc0e5d, sha256 prefix 55ed302cea3261ce, unchanged): it drives the real
  TaskSupervisor, RunSupervisor and ScenarioSupervisor machines, the real workers (failing for real on a non-git
  directory or a failing claim), the real Recorder and the real event store. Every Gherkin step has an assertion. No
  change made.
- Trial: 3 pass, 0 fail (22 s, load 58).
- Adapter run 20261016T165016Z-18aba7 at HEAD 27365884c4: bun exit 0, 3 pass, 0 fail, 30 expect() calls.
  Decision: handed-off; the reporter wrote evidence/SV6.json.
- `verify SV6 --evidence=...`: exit 0; structural all true except testInCommit false (not checked for scenarios);
  trust untrusted -> verified. Query: state completed, trustLevel verified (awaiting the semantic verifier).

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context semantic verifier, batch SV6-SV10)
- Action: verify-scenario-trust (Layer 3) for SV6. One `verdict` call, for SV6 only.
- State at start (query): completed, trustLevel verified. No `update start` needed.
- Plan: read the Gherkin, the tasks that support SV6, the committed test file and the code it drives at the CURRENT
  HEAD (after 077320f8e4 and c8ffccfee1, defects D8 and D9); run the test file with plain `bun test` from
  packages/opencode; judge each Gherkin step against its assertion; call `verdict SV6 trusted|rejected`.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- Read: SV6 Gherkin, tasks T2.8/T2.9/T2.10 (Supports SV6), the test (unchanged since 6841bc0e5d), supervise/task.ts
  (FAILURE_LIMIT 3, retrying after 1 s, failing records `harness error: <error>`), supervise/scenario.ts,
  supervise/run.ts scenario batch region, test/task/lib/supervise.ts (only the session boundary is scripted).
- Trial at HEAD 5fb09be29c: `bun test --timeout=30000 ./test/task/verify-spec-SV6.spec.ts` -> 3 pass, 0 fail, 30
  expect() calls, 6.9 s (load 19).
- Each Gherkin step has a specific assertion on the real supervisors, workers, Recorder and event store.
- `verdict SV6 trusted`: exit 0, trustLevel trusted.

## 2026-10-17 INTENT (fresh Layer 1+2 hash refresh)
- Recheck completed SV6 after commit f422e0a91a replaced a global Error with the existing tagged WorkerError.
- Read the Gherkin and current test, confirm that the failure message and assertions remain intact, and check pinned oxlint and Prettier.
- Run a focused trial, one signed Bun JUnit adapter run, and `state.mjs verify SV6` for the new source hash.
- Do not edit the test, source, protected evidence, keys, or state by hand. Do not issue a semantic verdict or commit.

## 2026-10-17 OUTCOME (fresh Layer 1+2 hash refresh)
- Read the Gherkin, spec intent, T2.8/T2.9, previous SV6 journal, and the test. Commit f422e0a91a changed only the claim failure's error type to `TaskWorkers.WorkerError`; its message and the assertions remained intact.
- Root-pinned oxlint: 0 warnings, 0 errors. Root-pinned Prettier: clean.
- Focused trial: 3 pass, 0 fail, 30 assertions in 42.88 s.
- Signed adapter run 20261017T194637Z-ce07b0: Bun 3 pass, 0 fail, 30 assertions; adapter handed off exit 0.
- `state.mjs verify SV6` passed all structural checks for the new hash. It changed trust from trusted to verified. Query returned state completed and trustLevel verified; the separate reviewer must rejudge semantics.
- No test or source edits and no commit. No coverage gap found in the Layer 1+2 check.
