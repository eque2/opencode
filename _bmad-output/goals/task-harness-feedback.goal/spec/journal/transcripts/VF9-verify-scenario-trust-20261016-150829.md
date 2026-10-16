# VF9 — verify-scenario-trust transcript (2026-10-16)

Role: fresh-context semantic reviewer (Layer 3). No source or test file changed.

## Read
- VF9 Gherkin; spec.md defect 6 (loader order R1, R3, R4); tasks.md T3.5, T3.6; journal/scenario/VF9.md.
- packages/opencode/test/task/verify-spec-VF9.spec.ts; src/task/core/command.ts (`loadFailures`, `refuse`);
  src/task/blend/index.ts (failures stable-sorted by rule number).
- task-formats/blend/example-format-faults.spec: notes.txt, T1-words.task TASK.md files.

## Gherkin step -> assertion
| Step | Assertion | Result |
|---|---|---|
| Given the folder with a stray file, a TASK.md with no title and an unknown front-matter key | root listing exactly SPEC.md, notes.txt, T1-words.task; T1.2 body not `# `, T1.1 body `# `; `colour` in T1.1 front matter, not in T1.2; loader gives no spec and exactly [R1, R3, R4] | covered |
| When /task runs on it | real `TaskCommand.run` with the real harness and loader | covered |
| Then the refusal lists an R1, an R3 and an R4 line in the loader's rule order | message exactly [header "3 failures", R1, R3, R4, hint]; ids R1, R3, R4 in order; lines equal the loader's list; path order differs; status reason; no job, no lease; same for a task folder inside | covered |

## Commands
- `bun test --timeout=30000 ./test/task/verify-spec-VF9.spec.ts` at 9b96863f72 -> 2 pass, 0 fail, 20 expect(), exit 0, 56 s.
- `state.mjs <spec> verdict VF9 trusted --reason ...` -> exit 0, trustLevel trusted.

## Notes
- VF9 does not depend on the start-up trust drop in supervise/run.ts.

## Outcome
TRUSTED. State completed, trustLevel trusted.
