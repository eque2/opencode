# VF10 — verify-scenario-trust transcript (2026-10-16)

Role: fresh-context semantic reviewer (Layer 3). No source or test file changed.

## Read
- VF10 Gherkin; tasks.md T3.5, T3.6; journal/scenario/VF10.md.
- packages/opencode/test/task/verify-spec-VF10.spec.ts; src/task/core/command.ts (`loadFailures`, `refuse`).
- task-formats/blend/example-cycle.spec: the `after` lines of T1.1 and T1.2.

## Gherkin step -> assertion
| Step | Assertion | Result |
|---|---|---|
| Given the example-cycle folder where T1.1 is after T1.2 and T1.2 is after T1.1 | `after` keys read from the seeded files equal {T1.1:[T1.2], T1.2:[T1.1]}; loader gives no spec and only the R7 line | covered |
| When /task runs on it | real `TaskCommand.run` with the real harness and loader | covered |
| Then the refusal has an R7 line that names the cycle through T1.1 and T1.2 | message exactly [header, exact R7 line, hint]; only rule line R7; cycle [T1.1, T1.2, T1.1] closed, set {T1.1, T1.2}, each step an `after` edge; status reason; no job, no lease; same for a task folder inside | covered |

## Commands
- `bun test --timeout=30000 ./test/task/verify-spec-VF10.spec.ts` at 9b96863f72 -> 2 pass, 0 fail, 19 expect(), exit 0, 20 s.
- `state.mjs <spec> verdict VF10 trusted --reason ...` -> exit 0, trustLevel trusted.

## Notes
- VF10 does not depend on the start-up trust drop in supervise/run.ts.

## Outcome
TRUSTED. State completed, trustLevel trusted.
