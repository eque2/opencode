# VF2 verify-scenario-trust transcript

Reviewer: eque2-verifier, fresh context, dispatched by the orchestrator (batch VF1-VF5).

## What I read
- `packages/opencode/test/task/verify-spec-VF2.spec.ts` (committed in 3789623276; 2 tests, each title `[VF2]`).
- `packages/opencode/test/task/lib/command.ts` (`seed`, `jobsOf` with mode "run", `runTask`, `statusFile`).
- `packages/opencode/src/task/core/command.ts` `refuse`: writes status.json only when `harness.live(directory)` is none.
- `packages/opencode/src/task/core/supervise/run.ts`: `HEARTBEAT = 5 s`.
- spec.md (owner ruling 3, defect 2), scenarios.gherkin VF2, tasks.md T3.2, journal/scenario/VF2.md.

## Gherkin step -> assertion
| Step | Assertion | Verdict |
|---|---|---|
| Given a live run in a directory | real `/task` job (real run supervisor, Recorder, status writer); poll until decoded status is live (running/waiting, no `ended` tag, no `endedAt`, `aliveAt` set); lease equals `{runID, spec, path}` | covered |
| When /task runs on a faulty spec in the same directory | second spec folder `faulty.spec` in the same directory with one R3 fault; real `TaskCommand.run` with the same harness | covered |
| Then the session gets the refusal message | reply equals exactly header + R3 line + hint; not the busy line; no new job start | covered |
| And the status file still shows the live run | decoded status.json after the refusal: same state (waiting, not refused), spec, path, `startedAt`, task ids; no `reason`; no faulty-spec text; lease unchanged. Control: after cancel and lease release, the same refusal writes `refused` with the reason | covered |

Note: the live writer's heartbeat is 5 s and the read follows the refusal at once, so an overwrite in that window is
unlikely; the control shows a refusal write is visible when it happens.

## Commands and results
- `node state.mjs <spec> query scenario/VF2`: completed, trustLevel verified.
- `bun test --timeout=30000 ./test/task/verify-spec-VF2.spec.ts` (packages/opencode): 2 pass, 0 fail, 35 expect() calls, 3.4 s.
- `node state.mjs <spec> verdict VF2 trusted --reason ...`: verdict trusted, trustLevel trusted.

## Outcome
Trusted. No gap.
