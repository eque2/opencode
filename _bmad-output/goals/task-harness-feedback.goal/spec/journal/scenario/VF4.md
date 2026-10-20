# VF4 verification journal (eque2-verifier, action: verify, batch VF1-VF5)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario VF4, after VF1-VF3 in the same batch. No semantic verdict here.
- State at start: VF4 not_started, untrusted, retryCount 0. No prior VF4 journal.
- Sources: spec.md (D12, defect 8: the stale-check worker records spec.checked), scenarios.gherkin VF4, tasks.md
  T3.3, the T3.3 journal, src/task/core/workers.ts `staleCheck`, src/task/core/supervise/run.ts (stale cadence,
  1 s), src/task/engine-xstate/machine.ts (`check` action), src/task/core/status.ts (`run.warning`).
- Plan: no sibling verify spec covers VF4, so write packages/opencode/test/task/verify-spec-VF4.spec.ts. Use a real
  `/task` job (as in VF2: T1.1 and T1.2 after the outside T9, so the run is live and stable). Edit T1.3 VERIFY.md of
  the root checkout so that the spec has two R3 failures (and one changed obligation text). Wait for the real stale
  cadence. Assert: one stored spec.checked with the loader's failures; a run history entry "spec.checked: 2
  failures"; status.json run.warning holds one line per failure; the run is still live and its supervisor keeps the
  loaded spec (old text). Then `/task trust T9` and assert the run goes on with work on the loaded plan's tasks.
  Trial with bun test, then `update VF4 start`, one adapter run, `verify VF4`.
- Never read or write evidence or key files; never edit the reporter, the state CLI or any source file; commit nothing.

## 2026-10-16 OUTCOME (test file written)
- Wrote packages/opencode/test/task/verify-spec-VF4.spec.ts (2 tests, each title starts with `[VF4]`, no describe).
- The live run is a real `/task` job (as in VF2): the real run supervisor with its real 1 s stale cadence and
  stale-check worker, the real Recorder and status writer. The edit in the root checkout gives T1.3 VERIFY.md two
  unknown categories (two R3 failures) and a changed c1 text.
- Trial 1: test 2 failed in the TEST: `JSON.stringify` of the supervisor context hit a cycle (the context holds the
  run's services). Fix: decode the context with a Schema struct that keeps only the spec's obligation ids and texts.
- Timing: the second test took up to 17 s on the loaded machine (live run start about 7 s, cancel about 2 s), so each
  live test has a 60 s per-test timeout (`LIVE_TIMEOUT`). Load alone, not a defect.
- Assertions: before the edit no warning and no spec.checked; after it, status.json `run.warning` split by line equals
  the loader's two lines in order; exactly one stored spec.checked whose failures equal those lines; status.json
  history has exactly one run entry "spec.checked: 2 failures"; the run is still live with the same state and no
  reason. Test 2: the run supervisor's spec is equal before and after (T1.3.c1 keeps its old text); status.json keeps
  the same task and obligation ids; the lease still names the run; after `/task trust T9` the run records
  outside.trusted T9 and task.started for T1.1 and T1.2, with no run.ended, no run.cancelled and no obligation.stale.
- Trials 2 and 3: 2 pass, 0 fail, 31 expect() calls (15-29 s). tsgo clean; oxlint 0 warnings; prettier --write once.

## 2026-10-16 OUTCOME (Layer 1+2)
- `update VF4 start`: not_started -> executing.
- Real run 20261016T122024Z-7450c3 through the adapter (HEAD moved to 14cbaffb08 by the orchestrator's RM commits
  during this batch; the VF4 file untracked, sha256 prefix 34cf4b9048dbae0e): bun exit 0, 2 pass, 0 fail, 0 skip,
  31 expect() calls, 15.1 s. Decision: handed-off, exit 0.
- `verify VF4 --evidence=<spec>/evidence/VF4.json`: structural pass (testInCommit false, as expected).
  State completed, trust untrusted -> verified ("awaiting semantic verifier").
- Run artefacts: scratchpad/adapter/runs/VF4/20261016T122024Z-7450c3/{junit.xml,run.log,run.json,mapped.json}.
- No gap found in the code for VF4. Note: the test does not observe WHICH actor records spec.checked (defect 8 says
  the stale-check worker); the stale check is the only path that records it in this run.

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context semantic verifier)
- Action: Layer 3 semantic trust for VF4. State at start: completed, trustLevel verified.
- Plan: read verify-spec-VF4.spec.ts, workers.ts `staleCheck`, supervise/run.ts, the machine `check` row and the
  status projection; judge each Gherkin step, with care for the writer's note (the test does not observe WHICH actor
  records spec.checked); run the file myself; then one `verdict VF4`.
- I judge only; I change no source or test file; I read no evidence or key file; I commit nothing.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- Read: the test file (committed in 3789623276), workers.ts `staleCheck`/`idChanges`, supervise/run.ts `checkStale`,
  the `stale` actor binding and the `staleCadence` region, the committed T1.3 VERIFY.md (the edit patterns match),
  tasks.md T3.3, spec.md defect 8.
- Own run: `bun test --timeout=30000 ./test/task/verify-spec-VF4.spec.ts` in packages/opencode: 2 pass, 0 fail,
  31 expect() calls, 6.6 s.
- The writer's note (the test does not observe WHICH actor records spec.checked): a text search of src/task finds one
  producer of `spec.checked`, `TaskWorkers.staleCheck`, invoked by the run supervisor's `stale` actor. The test
  replaces no actor and sees no spec.checked before the edit and one after, so the fact comes from the stale check.
  The worker-versus-supervisor detail is internal; the T3.3 unit test covers the order. Not a gap for VF4.
- Verdict: `verdict VF4 trusted` -> trustLevel trusted.
