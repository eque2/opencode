# VF8 — verify-scenario-trust transcript (2026-10-16)

Role: fresh-context semantic reviewer (Layer 3). No source or test file changed.

## Read
- VF8 Gherkin; tasks.md T3.4 and T4.10; journal/scenario/VF8.md.
- packages/opencode/test/task/verify-spec-VF8.spec.ts; test/task/lib/command.ts; src/task/core/command.ts (`plan`,
  `leftOut`, `header`, `headerParts`).
- task-formats/blend/release-notes.spec: acceptance/S1-S13 `needs`, SPEC.md `outside` (T8, T9), TASK.md `after` keys.

## Gherkin step -> assertion
| Step | Assertion | Result |
|---|---|---|
| Given the release-notes spec | seeded committed copy; left-out ids from `needs` equal the hand-pinned sets; some kept, some left out | covered |
| When /task runs on a task folder whose scenarios need tasks outside it | real `TaskCommand.run` on the T1.1 and T1.2 folders; one job start (not refused) | covered |
| Then the run's first message names each left-out scenario | noReply, one part, lines exactly [header, `Left out: <ids> — they need tasks outside this run.`]; named set equals pinned set; no kept id | covered |
| And the header metadata lists the same ids | part metadata equals `{taskHarness:{header:{spec, task, leftOut}}}`, `leftOut` the same array | covered |
| (controls) | whole spec and T1 folder: no Left out line, `leftOut: []` | covered |

## Commands
- `bun test --timeout=30000 ./test/task/verify-spec-VF8.spec.ts` at 2e6ff969e3 -> 4 pass, 0 fail, 30 expect(), exit 0, 87 s.
- `state.mjs <spec> verdict VF8 trusted --reason ...` -> exit 0, trustLevel trusted.

## Notes
- VF8 does not depend on the start-up trust drop in supervise/run.ts.

## Outcome
TRUSTED. State completed, trustLevel trusted.
