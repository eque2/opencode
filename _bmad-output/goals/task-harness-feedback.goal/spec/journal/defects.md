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
- Status: open — for the T1 review and the owner's final review.

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
