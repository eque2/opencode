# VF7 verification journal (eque2-verifier, action: verify, batch VF6-VF10)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario VF7. No semantic verdict in this dispatch.
- State at start: VF7 not_started, untrusted, retryCount 0. No prior VF7 journal.
- Read: tasks.md T3.4 (VF7 cases), journal/task/T3.4.md, core/command.ts (`run`, `job` externals),
  core/supervise/run.ts (`startRun`, `applyTrusts`, `untrustedOutside`, the `run.trust` action), core/harness.ts
  (`trust`, `claim`, `spawnRun`), test/task/lib/supervise.ts, the SV20 cases of supervise-run.test.ts.
- No sibling verify spec covers VF7, so write packages/opencode/test/task/verify-spec-VF7.spec.ts, each title with
  `[VF7]`. Plan:
  1. Real command, real job (job registry in "run" mode): a stored whole-spec slice with T1.1 trusted; `/task` on the
     T1.3 folder starts; the new slice is run.started then outside.trusted T1.1; the fold of that slice through the
     T1.3 plan has the external region T1.1 trusted.
  2. `/task trust T1.1` through the real command while that run is live: the directory aggregate gets the fact, the
     run slice gets no new outside.trusted T1.1; `/task trust T9` is the positive control (it moves the outside
     region T9 in the same run).
  3. A real run supervisor spawned in the real harness with the external region T1.1 left untrusted: `/task trust T1.1`
     through the real command leaves it untrusted and records nothing, while `/task trust T9` moves T9.
  4. With no trusted slice, `/task trust T1.1` then `/task` on the T1.3 folder is still refused (R12).
- Never read or write evidence or key files; never edit the reporter, the state CLI or any source file; commit nothing.

## 2026-10-16 OUTCOME (test file written)
- Wrote packages/opencode/test/task/verify-spec-VF7.spec.ts (4 tests, each title starts with `[VF7]`, no describe).
- Test 1: Given — a stored whole-spec slice whose fold has T1.1 trusted. When — the real `TaskCommand.run` on the
  T1.3 folder, the job registry in "run" mode (the real job, Recorder and run supervisor). Then — the run header,
  one job, the lease on the T1.3 path; the new slice is `run.started` (path T1.3 folder) then `outside.trusted T1.1`;
  the old slice is unchanged; the fold through the T1.3 plan has T1.1 untrusted after the first fact and trusted after
  the second.
- Test 2: during that live run, `/task trust T9`, `T1.1`, `T8` through the real command: the directory aggregate holds
  all three; the run slice holds T1.1 once (the start-up trust), then T9 and T8 only.
- Test 3: a real run supervisor spawned in the real harness with the directory lease, whose external region T1.1 was
  not trusted at the start: `/task trust T9`, `T1.1`, `T8` through the real command move T9 and T8, leave T1.1
  untrusted (recorder snapshot and the fold of the stored facts), record no fact naming T1.1, and T1.3 is not ready.
- Test 4: `/task trust T1.1` with no trusted slice, then `/task` on the T1.3 folder: still refused with the R12 line.
- Trial 1: 2 pass, 2 fail — both TEST faults. (a) Test 1's wait matched the OLD stored slice before the new
  `run.started` landed; fixed by waiting for the new slice's path. (b) Test 3 sent the trusts as soon as `run.started`
  was stored: T8 (sent last) was recorded but T9 (sent first) never was. Fixed by waiting until the supervisor is in
  `running` and holds the run's snapshot (`context.latest`) before the trusts.
- OBSERVATION (not a VF7 failure; for the orchestrator): a trust forwarded in the start-up window is lost. In
  core/supervise/run.ts the `trusting` state computes the trust worker's ids on entry and then sets `pending: []` on
  done, so a `run.trust` that arrives while `trusting` runs is dropped; and in `running` the `trust` action returns
  when `context.latest` is still none. The trust stays in the directory aggregate (a later run reads it), but the live
  run never records it. Seen once in trial 1 of test 3 (T9 lost, T8 recorded). Not changed (verify dispatch).
- Trial 2 and 3: 4 pass, 0 fail, 33 expect() calls. tsgo clean for the file; oxlint 0 warnings; prettier --write
  once (new file).

## 2026-10-16 OUTCOME (Layer 1+2)
- `update VF7 start`: not_started -> executing.
- Real run 20261016T124621Z-6d56b2 through the adapter at HEAD f57285510d (test file untracked, sha256 prefix
  4847161a7109a820): bun exit 0, 4 pass, 0 fail, 0 skip, 33 expect() calls, 5.7 s. Decision: handed-off, exit 0.
- `verify VF7 --evidence=<spec>/evidence/VF7.json`: structural pass (testInCommit false, as expected). State
  completed, trust untrusted -> verified ("awaiting semantic verifier").
- Run artefacts: scratchpad/adapter/runs/VF7/20261016T124621Z-6d56b2/.
- No gap found in the code for VF7's steps. One observation recorded above (the start-up trust race, SV20 area).

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context reviewer)
- Action: Layer 3 semantic trust for VF7. State at start: completed, trust verified (structural pass).
- Read: VF7 Gherkin, tasks.md T3.4 (VF7 cases), the earlier VF7 journal (it reports a start-up trust drop in
  core/supervise/run.ts, the `trusting` state; the orchestrator fixes it separately).
- Plan: read verify-spec-VF7.spec.ts and the code it drives (command `trust` branch, harness `trust`, run supervisor
  `trusting`/`running`); map each Gherkin step to an assertion; judge whether any assertion depends on the defect or
  hides it with a wait; run the file once with plain `bun test`; call `verdict VF7` exactly once.
- Do not change any source or test file; do not read evidence or key files; commit nothing.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- Own runs: `bun test --timeout=30000 ./test/task/verify-spec-VF7.spec.ts` in packages/opencode: 4 pass, 0 fail,
  33 expect() calls, exit 0, at 6d3f86d553 (120 s) and again at 2e6ff969e3 (121 s), which holds the trust-drop fix
  109948a797. The test file and test/task/lib are unchanged since af2bdf043e.
- Step map: Given -> stored whole-spec slice, fold T1.1 trusted. When -> real command, real job ("run" mode).
  Then -> header, one job, lease path T1.3; new slice [run.started T1.3, outside.trusted T1.1]; fold untrusted then
  trusted. And never moves -> live command run (no second T1.1 fact), a real supervisor with T1.1 untrusted (stays
  untrusted, no fact, T1.3 not ready), and no trusted slice (R12 refusal stays). T9 before and T8 after prove that the
  T1.1 trust was handled, not dropped.
- Defect link: the tests wait for the supervisor in `running` with a snapshot before they send a trust. They do not
  depend on the start-up trust drop and do not test its fix. Code read: the fix's pending path keeps the
  `untrustedOutside` filter, so an external id stays excluded in the start-up window too.
- Verdict: `verdict VF7 trusted` -> state completed, trustLevel trusted.
