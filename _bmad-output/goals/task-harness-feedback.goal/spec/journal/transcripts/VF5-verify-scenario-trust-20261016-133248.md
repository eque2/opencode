# VF5 verify-scenario-trust transcript

Reviewer: eque2-verifier, fresh context, dispatched by the orchestrator (batch VF1-VF5).

## What I read
- `packages/opencode/test/task/verify-spec-VF5.spec.ts` (committed in 3789623276; 3 tests, each title `[VF5]`).
- `packages/opencode/test/task/lib/supervise.ts` `runOf`: real `TaskRecorder.make`; the real status writer when
  `writes: true`; the session side is a scripted boundary (no session work happens in this run).
- `packages/opencode/src/task/core/workers.ts` `staleCheck` and `idChanges` (the SD-15 texts).
- `packages/opencode/src/task/engine-xstate/machine.ts` `check` action (warning set or cleared; history entry).
- scenarios.gherkin VF5, tasks.md T3.3, journal/scenario/VF5.md.

## Gherkin step -> assertion
| Step | Assertion | Verdict |
|---|---|---|
| Given a run whose warning shows two failures | real `RunSupervisor.machine` on a SimulatedClock; two R3 faults; one check stores one spec.checked with the two loader lines; view warning and status.json `run.warning` equal them | covered |
| When the spec validates again | original T1.3 VERIFY.md restored; loader gives `[]`; one more check | covered |
| Then spec.checked is recorded with no failures and the warning goes | stored list `[two, []]`; last fact `failures: []`; view warning undefined; status.json has no `warning`; history `["spec.checked: 2 failures", "spec.checked: no failures"]`; supervisor still running | covered |
| And a valid reload that adds or removes an obligation id counts as a failure and the run keeps the old text | add T1.3.c9: exact SD-15 "is not in the loaded plan" line recorded and set as warning; remove T1.3.c4: exact "of the loaded plan is missing" line; both times the supervisor keeps old c1 text and old ids; no `obligation.stale` | covered |
| And a reload with the same failures as the current warning records nothing | three more checks with the same two failures: stored list and history unchanged, warning kept; controls: a one-fault list is recorded at once; a repeated id-change failure records nothing | covered |

Each check is one 1 s clock step, observed as `staleCadence` `checking` then `waiting`, so "records nothing" follows a
check that really ran.

## Commands and results
- `node state.mjs <spec> query scenario/VF5`: completed, trustLevel verified.
- `bun test --timeout=30000 ./test/task/verify-spec-VF5.spec.ts` (packages/opencode): 3 pass, 0 fail, 62 expect() calls, 18.1 s.
- `node state.mjs <spec> verdict VF5 trusted --reason ...`: verdict trusted, trustLevel trusted.

## Outcome
Trusted. No gap.
