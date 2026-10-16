# Defects and deviations — task-harness-feedback

## D1 — T1.10: the cascade stale walk uses canonical progress, not the full interleaving
- Check: `packages/opencode/test/task/engine-xstate-graph.test.ts`, the stale walk of the loaded
  `example-cascade.spec` plan (T1.10 test case "the stale walk … with full interleaving … finds 0 stuck states").
- Actual failure: with the full interleaving plus every eligible `obligation.stale`, the walk passed 20 000 dequeued
  edges (TraversalLimitError at 677 s) and did not finish within 900 s under a load average of 40–70. The full
  interleaving without staleness has 1 310 edges; staleness multiplies the obligation-state combinations of every
  task in work.
- Impact: the stale walk's breadth. It does not touch AC 6 (the main walks of release-notes and both live-check
  plans, and the negative control, all pass with the canonical interleaving, as owner ruling 4 accepted).
- Attempts: (1) limit 20 000 — exceeded; (2) limit 400 000 with key caching — timed out at 900 s.
- Resolution: the cascade stale walk uses canonical progress and offers every eligible staleness in every state
  (staleness is the only fact that takes a unit out of `trusted`). A second check on the small
  `example-scenarios.spec` plan runs both the reduced walk and the full interleaving with staleness, with and
  without the blocked rows, and requires the same stuck configurations.
- Remaining validation: the full-interleaving stale walk of the cascade plan itself is not run.
- Update: the canonical-progress reduction with staleness proved unsound on the small plan (it found 0 stuck
  configurations in the copy without blocked rows where the full interleaving found 5), so it was dropped. The
  full-interleaving stale walk of the loaded cascade plan is now an opt-in test (`TASK_GRAPH_STALE=1`, limit 2 000 000,
  4 h timeout); its run started at 16:59 and its result is recorded here when it ends.
- Update 17:58: that run was stopped after 49 min wall time (18 min CPU) without a result. The conformance guard
  waits until no other `bun test` process runs, so the walk blocked the T1.14 gate. It runs again when no gate
  needs the machine.
- Update 20:36: the T1.10 verifier found that the walk key's `dead:` part held the wrong value (fc8ab41135 fixes it,
  with a property test that two snapshots with one key move alike in both key modes). The full stale walk of the
  cascade plan was started again at 20:36 on the fixed key (HEAD f6d5bb3dc7), with no gate run waiting on the
  machine; T1.10's trust waits on its result.
- Update 21:31: the full-interleaving stale walk of the loaded cascade plan passed: 36 353 keys, 361 474 edges,
  0 stuck states, statuses active and done, 3 280 s (`TASK_GRAPH_STALE=1 bun test --timeout 14400000
  test/task/engine-xstate-graph.test.ts -t staleness` at HEAD f6d5bb3dc7; output in `task/T1.10-stale-walk.log`).
  Its limit is now 1 100 000 (about 3 times the edges). Correction (T1.10 verifier, 22:03): the later guard change
  71f2906385 does change the walk. Under the old `unproved` guard, a child's `task.proved` moved a proving parent's
  review obligation; the verifier found 10 such divergences in 15 401 checked steps, all of which reconverged. The
  walk runs again at HEAD at 22:12, before the checkpoint gate.
- Update 23:04: the stale walk at 0ee865afbb (with the guard change; the later T1 review commits change no guard,
  row or key) passed: 33 944 keys, 331 133 edges, 0 stuck, 3 184 s (`task/T1.10-stale-walk-head.log`). Fewer keys
  than at f6d5bb3dc7, because a child's proof no longer moves a proving parent's review obligation.
- Status: resolved — the stale walk passes on the current guards.

## D2 — environment: the machine's load makes timing-bound tests fail
- Check: `packages/opencode/test/task/engine-xstate-graph.test.ts` (each walk has the specified 60 s timeout) and
  `engine-xstate-random.test.ts` (180 s per seed at first).
- Actual failure: with a load average of 60–190 on 20 cores from other sessions (another worktree's `tsc`/`eslint`,
  a pricing script, the IDE; 20.9 GB of 22.5 GB swap in use), RM19 and RM21 exceed 60 s and RM22 exceeds 120 s,
  although each walk returns the right result when it ends (RM19: 338 keys, 746 edges, 0 stuck; RM21: 398 keys,
  806 edges, 33 stuck). A 20-fact fold took 0.3–7 s depending on the moment's load.
- Impact: timing-bound tests cannot pass while the load lasts; logic results are unaffected.
- Attempts: memoised `initial` per plan; key caching in the walk; profiled the machine (the AD-3 eventless rows
  are the main cost: a fold takes 471 ms with them and 57 ms without, under load 90), and kept the spine's design.
- Remaining validation: the graph test and the 40-seed random test must be run when the load is low, before T1.10
  and T1.8 complete and before the checkpoint gate.
- Update 17:45: the owner stopped the CPU-hungry tasks (load 25–50). All 40 seeds and the coverage check pass (8
  parallel groups, 5–6 min each); RM19, RM20, RM21 and RM22 each pass inside their timeouts (whole-file times
  59.8 s, 21.5 s, 48.7 s, 42.8 s, start-up included). RM19 has little margin left under load.
- Update 19:26: the first T1.14 guard run (`--arm o2 --runs 1`) waited 63 min in total for other sessions' tests,
  then started the o2 arm at load 12.5. During the arm the load rose to 91 again, and H3 and H6 failed before any
  assertion: `opencode serve did not start within 60000 ms` (each check's own server start). The other 14 checks
  passed (score 82.353, 14/17). H3 and H6 are re-run alone (`--checks H3,H6`) for their real result.
- Update 2026-10-15 00:35: the checkpoint gate's full opencode suite. Run at 22:44 (HEAD 6c8373d2ac): 4000 pass,
  1 fail (`run-process.test.ts` "exits nonzero promptly when the model is unknown": 15 065 ms against its 15 000 ms
  bound). Re-run at 23:32 (HEAD 3b52c9289a, load up to 47 from other sessions, 3 444 s): 3990 pass, 11 fail, all
  subprocess or timing tests (`run-process.test.ts` concurrent CLI runs at their 30 s bound, `prompt.test.ts` "loop
  waits while shell runs" at 10 s, `acp/lifecycle.test.ts` "stdin EOF exits cleanly" at 7 s). None touches the task
  harness, the full run at 21:30 passed them all, and each passes when run alone (00:34). The gate runs again from a
  script that waits for load under 8 and no other `bun test`.
- Update 03:20: attempt 1 of that script (02:52, load 4 at the start, 13 later) gave 4000 pass, 1 fail: the same
  "exits nonzero promptly when the model is unknown" (15 376 ms). The run-process file alone at load 10-14 fails nine
  concurrent CLI tests at their 30 s bound and that one at 15 s, with and without the D4 preload change, and on `dev`
  in the main checkout at load 14 the same way. So the bound needs a quiet machine; the script now waits for a 1-minute
  load under 5 and a 5-minute load under 7.
- Status: open — the checkpoint gate must run on a quiet machine.

## D3 — BUILD-3 failed on dev: the web UI module did not resolve without the web UI
- Check: BUILD-3, `bun run --cwd packages/opencode build --single --skip-install --skip-embed-web-ui`.
- Actual failure (21:28, HEAD fbd0e2ca1a): `error: Could not resolve: "opencode-web-ui.gen.ts"` at
  `src/server/shared/ui.ts:55`. `script/build.ts` added that module only when it embeds the web UI, and the loader
  imports it by name. Neither file differs from the merge base with dev, so dev fails the same way.
- Impact: the quality gate (AC 29) at the phase-1 checkpoint.
- Attempts: (1) a build-script stub module that throws when imported, so the loader falls back to the upstream proxy.
- Resolution: commit "Give a build without the web UI a module that fails to import"; the build and its smoke test
  pass (4 s).
- Status: fixed — for the owner's final review (a change outside the task harness).

## D4 — BUILD-4: five Google Vertex tests read the developer's shell
- Check: BUILD-4, `bun run --cwd packages/opencode test` (21:30-21:40, HEAD 43b4e6f79e): 3996 pass, 41 skip, 5 fail;
  `bun run --cwd packages/tui test`: exit 0.
- Actual failure: `test/provider/provider.test.ts` Google Vertex tests expected `europe-west1` (or a REP endpoint) and
  got `us-central1`: the shell sets `GOOGLE_CLOUD_LOCATION`, which outranks the `VERTEX_LOCATION` the tests set.
  Unrelated to the task harness; it fails the same way on dev in this shell.
- Resolution: the test preload deletes `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and `VERTEX_LOCATION`, as it
  already deletes the other provider settings; the provider suite passes.
- Status: fixed — for the owner's final review (a change outside the task harness).

## D5 — RM22: the stale-walk step cannot run inside a verify dispatch's time bounds
- Check: scenario RM22, Gherkin step "the stale walk of the loaded example-cascade plan finds no stuck state";
  packages/opencode/test/task/verify-spec-RM22.spec.ts, test "[RM22] the stale walk ..." (TASK_GRAPH_STALE=1).
- Actual failure: not a test failure. The walk needs about 3 200 s (D1: 36 353 keys, 361 474 edges); the verify
  dispatch bounds each command to 180 s (bash) and 10 min, foreground only. Without TASK_GRAPH_STALE=1 the test is
  skipped, so the verifier made no adapter run and no `verify` (a skipped Gherkin step is not a pass).
- Impact: RM22 stays unverified (state not_started after `fail`, retryCount 1). The reduction check and the
  guard-read check of RM22 pass in trial runs (6 pass, 1 skip). It does not touch RM19-RM21.
- Attempts: none on the walk itself; D1 already records that no sound reduction exists for it.
- Remaining validation: one adapter run of verify-spec-RM22.spec.ts with TASK_GRAPH_STALE=1 and --overall-ms and
  --idle-ms of about 14 400 000, on a quiet machine, then `verify RM22`. machine.ts changed after the last logged
  stale walk (0ee865afbb), so that log is not evidence for the current tree.
- Status: open

## D6 — RM23: the preload's afterAll hook passes its 30 s bound under load when the file runs alone
- Check: scenario RM23, `bun test --timeout=30000 ./test/task/verify-spec-RM23.spec.ts` in packages/opencode.
- Actual failure: "(fail) (unnamed) ... a beforeEach/afterEach hook timed out for this test" (36-42 s). Every one of
  the 9 [RM23] tests passes. The global `afterAll` of test/preload.ts imports src/effect/app-runtime and disposes
  it; RM23 imports only the port, so that import is cold, and at load 120-200 on 20 cores it passes 30 s.
- Impact: RM23 has no evidence yet (state not_started after `fail`, retryCount 1). It does not touch RM20, RM21 or
  RM24 (their files load app modules, so the hook is warm; RM24 passed through the adapter at load 130).
- Attempts: trial 1 at load 90: 9 pass, 0 fail. Trials 2-5 at load 125-198: 9 pass, 1 fail each (hook). The
  retry limit for one issue was reached. Not tried: a larger --timeout (owner ruling 6 fixes 30 000 ms) or an extra
  import only to warm the hook (a workaround in the test for a load problem).
- Remaining validation: one adapter run of verify-spec-RM23.spec.ts at load under about 90 (runs under
  journal/adapter/runs/RM23), then `verify RM23`.
- Status: open

## D7 — SV6-SV10: the state CLI's `verify` verb was denied by the permission system
- Check: `node .claude/skills/eque2-code-setup/scripts/state.mjs <spec> verify SV6 --evidence=<spec>/evidence/SV6.json`,
  run by the eque2-verifier subagent of the SV6-SV10 verify batch (2026-10-16 14:54).
- Actual failure: "Permission for this action was denied by the Claude Code auto mode classifier. Reason:
  [Self-Approval]." The verifier did not retry it, used no other route, and did not call `verify` for SV7-SV10.
- Impact: SV6-SV10 stay `executing` although each has a passing adapter run and reporter-signed evidence
  (evidence/SV6.json ... SV10.json). It blocks nothing else; the tests and the evidence are in place.
- Attempts: none (a denied action is not repeated).
- Remaining validation: `verify SV6` ... `verify SV10` with their evidence files, by the orchestrator or with the
  owner's permission, while each test file is unchanged (the evidence holds its source hash).
- Status: open
