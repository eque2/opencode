# RM18 verify-scenario-trust transcript

- Scenario: RM18 The phase-1 runner reads readiness and completion from the machine.
- Reviewer: eque2-verifier, fresh context, batch RM15-RM19 (resumed after a session limit). State before: completed,
  trustLevel verified.

## What I read
- journal/scenario/RM18.md (the Layer 1+2 verifier's notes on the deleted runner, `trusting`, `builderMessage`).
- spec.md In Scope phase 1 (AD-20 seam) and phase 2 ("The polled runner removed").
- packages/opencode/test/task/verify-spec-RM18.spec.ts (unchanged since dc3c63e00b).
- test/task/lib/supervise.ts (runOf: real Recorder, real event store); test/task/lib/machine.ts.
- src/task/core/supervise/run.ts: supervised, untrustedOutside, dispatch, trust, the `ended` guard, the wall clock.
- `git log --diff-filter=D -- src/task/core/runner.ts`: 120efaae43 removed it. `grep run.ended src`: no done record.

## Gherkin step -> assertion
| Step | Assertion |
|------|-----------|
| Given the runner after phase 1 | The real RunSupervisor.machine (successor of the deleted runner) over a real Recorder and event store; test 5 asserts runner.ts is gone. |
| When a run proceeds | Test 1: a whole release-notes run from start to done. |
| Then starts a task only when the snapshot tags it ready | Test 1: each task spawned once, tags [waiting, ready], machine `ready`, ready tag, every dependency trusted. Test 2: ready tag added to T1.5 `waiting` -> started at once; tag removed from T1.3 `ready` -> never started. |
| And no readiness check, no outside trust set, no done decision | Test 2 (tag only). Test 4: T8 trusted by another writer is read from the snapshot; forwarded trusts record nothing; `trusting` empty. Test 5: no checkDone/follows/ACTIVE/JUDGED/trustActive. Test 1: tasks all trusted, S5 held -> runner still running. Test 3: no `run.settled` rows -> every unit final, runner still running; real machine on the same facts is done. |
| And never records run.ended in state done | Tests 1 and 3: no run.ended stored. Test 5: the only run.ended literal with a state is the wall clock's `"failed"`. |
| And stops when the snapshot status is done | Test 1: after S5's verdict the run machine is done and the runner reaches `closed`; not before. |

## Commands and results
- `bun test --timeout=30000 ./test/task/verify-spec-RM18.spec.ts`: 5 pass, 0 fail, 51 expect(), 116.4 s; load ~140.
- `state.mjs <spec> verdict RM18 trusted --reason ...`: exit 0, trustLevel trusted.

## Outcome
Trusted. Note (wording, not a test gap): the Gherkin names the deleted phase-1 runner; it could name the run
supervisor.
