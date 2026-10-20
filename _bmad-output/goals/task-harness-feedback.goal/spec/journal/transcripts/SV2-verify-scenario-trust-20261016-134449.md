# SV2 verify-scenario-trust transcript

## What I read
- journal/scenario/SV2.md, spec.md, tasks.md T2.7-T2.10, core/supervise/run.ts (whole file), core/harness.ts,
  workers.ts `record` (it calls `run.recorder.record`), test/task/lib/supervise.ts `eventually` (dies after 20 s).
- packages/opencode/test/task/verify-spec-SV2.spec.ts (committed; sha256 prefix 8ea8b61091ab24df).

## Gherkin steps and their assertions
- Given a run with a ready leaf and a verifying scenario: the fold of the stored slice has T1.3 (no children) as the
  only ready/active task and S2 as the only verifying scenario.
- When the run supervisor reads the run actor: the real RunSupervisor, spawned by the real harness root, watches the
  real Recorder's run actor.
- Then one task supervisor for the leaf and one scenario supervisor for the scenario: children equal exactly
  task:<id>:T1.3 and scenario:<id>:S2; no other unit has a system entry; no second spawn on later snapshots.
- And each supervisor records its phase outcome through the Recorder: the store equals the wrapper's list
  (run.resumed, task.started T1.3, scenario.verified S2 trusted, task.needs_human T1.3); the run actor's log moved
  T1.3 building, S2 trusted, T1.3 needs_human.
- And a supervisor stops when its unit leaves ready/active/verifying: S2 stops at trusted while T1.3 and the run go
  on; T1.3 keeps one ref across ready->building, then stops at needs_human, its turn cancelled, while S2 goes on.
- And the run machine invokes nothing: no invoke in over 100 state nodes (control: the walk finds the run
  supervisor's invokes); no actor implementations; no child in a live run actor snapshot.

## Commands and results
- `bun test --timeout=30000 --reporter=junit ... ./test/task/verify-spec-SV2.spec.ts` (packages/opencode, HEAD
  f57285510d): exit 0, 5 pass, 0 fail, 63 expect(), 16 s.
- `state.mjs verdict SV2 trusted --reason ...`: trustLevel trusted.

## Outcome
Trusted. No gap.
