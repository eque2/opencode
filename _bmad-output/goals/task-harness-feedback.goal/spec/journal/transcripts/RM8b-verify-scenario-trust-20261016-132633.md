# RM8b verify-scenario-trust transcript

Fresh-context Layer 3 reviewer (eque2-verifier), batch RM7, RM8a, RM8b, RM8c, RM9.

## Read
- spec.md (owner ruling 3), scenarios.gherkin (RM8b), tasks.md (T1.11, T2.11 rows).
- journal/scenario/RM8b.md (Layer 1+2 record, with the "records only run.resumed" reading).
- packages/opencode/test/task/verify-spec-RM8b.spec.ts (committed b9553cc37d; not changed since).
- packages/opencode/test/task/lib/command.ts; src/task/core/command.ts (`normalizedPath`, `pathOf`, `sliceOf`);
  src/task/core/supervise/run.ts (`startRun`); base 2c0214ab71 events.ts (old run.started / run.resumed shape).

## Gherkin step -> assertion
| Step | Assertion |
|---|---|
| Given an old slice: run.started without a path, no run.ended, a fold that is not done | First fact `{ run.started, base }`; no fact has `path`; every type is an old type and decodes; no run.ended or run.cancelled; fold active, running, not ended; T1.1 trusted, T1.2 waiting. |
| When /task runs on the whole spec, also as ./<spec>/ | Two instance tests with the real `TaskCommand.run` and the real run job: `/task <spec>` and `/task ./<spec>/`; `normalizedPath` maps four written forms to the spec path. |
| Then the slice counts as a whole-spec slice and the run resumes | `sliceOf` = resume with the stored facts for the spec path; = new for a subtree path (contrast); reply is the header alone; one job of the run id; lease `{ runID, spec, path: spec }`. |
| And the resume records only run.resumed with the path, a fact type that already exists | First appended fact equals exactly `{ run.resumed, base, path: spec }`; no run.started appended; one run.resumed; one slice whose first fact is the old run.started; old facts unchanged; run.resumed is an old type and decodes. |

## Commands
- `node state.mjs <spec> query scenario/RM8b` -> completed, trust verified.
- `bun test --timeout=30000 ./test/task/verify-spec-RM8b.spec.ts` (packages/opencode) -> 4 pass, 0 fail, 54 expect() calls, 10.3 s.
- `node state.mjs <spec> verdict RM8b trusted --reason ...` -> `{"verdict":"trusted","trustLevel":"trusted"}`.

## Outcome
Trusted. Reading noted: "records only run.resumed" means the resume marks itself with run.resumed alone; `startRun`
in the run supervisor confirms that. No gap.
