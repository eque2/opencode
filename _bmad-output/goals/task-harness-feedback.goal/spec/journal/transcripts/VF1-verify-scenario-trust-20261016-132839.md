# VF1 verify-scenario-trust transcript

Reviewer: eque2-verifier, fresh context, dispatched by the orchestrator (batch VF1-VF5).

## What I read
- `packages/opencode/test/task/verify-spec-VF1.spec.ts` (committed in 3789623276; 3 tests, each title `[VF1]`).
- `packages/opencode/test/task/lib/command.ts`: `seed` (committed git copy of the spec), `runTaskInputs` (calls the
  real `TaskCommand.run`; the ops only record the prompt), `refusalOf` (reads `.opencode/task/status.json` on disk).
- `packages/opencode/src/task/core/command.ts`: `loadFailures` and the `refuse`/`failed` path.
- spec.md, scenarios.gherkin VF1, tasks.md T3.2, journal/scenario/VF1.md.

## Gherkin step -> assertion
| Step | Assertion | Verdict |
|---|---|---|
| Given a spec folder with three loader failures | `plantThree` edits three files; `Blend.load` failures equal `[R1 draft.txt, R3 T1.4 TASK.md, R4 T1.1 TASK.md]`; path order is not sorted order | covered |
| When /task runs on it | real `TaskCommand.run` with real `TaskHarness.make`; one `noReply` input; no job start; `harness.live` is none | covered |
| Then the header "Refused <path>: 3 failures. No work started." | `message[0]` equals the exact string (spec path and a typed task-folder path) | covered |
| And each failure line in loader order, then the hint | 5 lines exactly; lines 1-3 equal the loader lines in order (pinned per rule; exact R4 text); line 4 equals `Fix each line, then type /task <path> again.` | covered |
| And the status run reason holds exactly those failure lines | status.json `run.reason` equals the three lines joined by `\n`; no header, no hint; `state` refused, `spec`, `path` | covered |

## Commands and results
- `node state.mjs <spec> query scenario/VF1`: completed, trustLevel verified.
- `bun test --timeout=30000 ./test/task/verify-spec-VF1.spec.ts` (packages/opencode): 3 pass, 0 fail, 35 expect() calls, 2.7 s.
- `node state.mjs <spec> verdict VF1 trusted --reason ...`: `{"verdict":"trusted","trustLevel":"trusted"}`.

## Outcome
Trusted. No gap.
