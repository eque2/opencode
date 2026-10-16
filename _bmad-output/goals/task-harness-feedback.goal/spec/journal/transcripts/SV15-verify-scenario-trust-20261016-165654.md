# SV15 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier, spawned by the develop-spec orchestrator (batch SV11-SV15).

## Read
- journal/scenario/SV15.md, tasks.md T2.3.
- packages/opencode/test/task/verify-spec-SV15.spec.ts (committed in 237e47bfa1).
- src/task/core/status.ts `project(plan, snapshot)`: run, tasks, obligations from the engine selectors and slots.

## Gherkin step -> assertion
- Given the observed facts folded through the release-notes machine -> `observed(plan)` folded with the real
  `TaskEngineXState.initial/apply`.
- When the status is projected -> the real `TaskStatus.project`.
- Then state, tags, blocked cause, times, task spans -> every unit equals the snapshot's own values (keys present or
  absent alike); pinned to facts: T1.1, T1.4, T1.5, T1, T1.1.c1, T1.4.c7, blocked scenarios, S2.
- And the run's title, spec id, path, times; scenario titles -> SPEC.md H1; spec, specId, path; startedAt =
  run.started; endedAt only after a stop (= the stop's at); titles equal the acceptance Scenario line minus the id.
- And no state of its own, no phase or dependency tags -> after every fold prefix: class tags only, AD-1 order;
  states equal the view; waitingOn equals the waits selector; an unlinked plan projects identically; the snapshot
  does hold phase and waits: tags (counted > 0), so the absence in the file is the projection's doing.
- And the old derivations no longer exist -> exports, declarations and property reads in status.ts; a scan of
  src/task finds only the engine's waits selector.
- And an obligation carries no blocked cause -> no blockedBy key and no blocked tag on any obligation after any
  prefix, while blocked tasks and scenarios have causes.

## Commands
- `bun test --timeout=30000 ./test/task/verify-spec-SV15.spec.ts` (packages/opencode): 5 pass, 0 fail, 4394 expect, 23.7 s.
- `state.mjs <spec> verdict SV15 trusted --reason ...`: exit 0, trustLevel trusted.

## Outcome
Trusted. No gap. Minor softness: the T1.1 last-span `to` check accepts two values; the snapshot comparison pins it.
