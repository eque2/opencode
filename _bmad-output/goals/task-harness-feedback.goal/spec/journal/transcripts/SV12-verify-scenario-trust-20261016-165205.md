# SV12 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier, spawned by the develop-spec orchestrator (batch SV11-SV15).

## Read
- journal/scenario/SV12.md, tasks.md (T2.2, T2.8 State Transitions line).
- packages/opencode/test/task/verify-spec-SV12.spec.ts (committed in 237e47bfa1).
- test/task/lib/supervise.ts (repository, started, move, storedFacts).
- src/task/core/supervise/task.ts: `ended` order capped > repeated > readied > nudgeLeft (nudges < 2) > unready;
  `nudging` records task.nudged 1 or 2; `unready` commits, records task.ready then a failed task.proved with NO_READY.
- src/task/core/workers.ts: `proof` calls `proveLeaf` with the task's worktree, base and head.

## Gherkin step -> assertion
- Given a building task, turn ends idle without task_ready -> unitState building, session, worktree; scripted turns
  only write a file and end.
- When the turn ends idle a first and a second time -> prompts equal [attempt, nudgeMessage, nudgeMessage].
- Then task.nudged nudge 1, then nudge 2 -> stored types equal [task.nudged, task.nudged]; nudge 1 then 2 with the
  NO_READY reason; context.nudges 1 then 2; two building->building log entries; attempts 1.
- And the proof runs on the builder's head -> test 1: task.ready.head equals the worktree HEAD (not the base, holds
  [T1.1.c1]); task.proved: c1 needs-judge, others "no test titled"; the proof log shows the bun test run; no NO_READY.
- Or the task records "the builder ended without task_ready" -> test 2: no third nudge; task.ready names the head
  that holds the last edit; task.proved equals every test obligation failed with NO_READY; the fold gives attempt 2.

## Commands
- `bun test --timeout=30000 ./test/task/verify-spec-SV12.spec.ts` (packages/opencode): 2 pass, 0 fail, 49 expect, 15.1 s.
- `state.mjs <spec> verdict SV12 trusted --reason ...`: exit 0, trustLevel trusted.

## Outcome
Trusted. No gap. The task_ready hook goes straight to the supervisor here; SV13 covers its routing.
