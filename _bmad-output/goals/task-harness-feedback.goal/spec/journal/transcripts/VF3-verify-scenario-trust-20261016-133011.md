# VF3 verify-scenario-trust transcript

Reviewer: eque2-verifier, fresh context, dispatched by the orchestrator (batch VF1-VF5).

## What I read
- `packages/opencode/test/task/verify-spec-VF3.spec.ts` (committed in 3789623276; 4 tests, each title `[VF3]`).
- `packages/opencode/src/task/blend/schema.ts` `VerifyFrontMatter`: `ensures` is a required record, min 1 property.
- `task-formats/blend/schema/verify.schema.json`: draft 2020-12, root `type: object`, `additionalProperties: false`,
  `required: ["ensures"]`, no root `$ref`/`allOf`.
- spec.md (D11), scenarios.gherkin VF3, tasks.md T3.1, journal/scenario/VF3.md (writer's note).

## Gherkin step -> assertion
| Step | Assertion | Verdict |
|---|---|---|
| Given a leaf VERIFY.md that has no ensures key | temp copy; T1.2 VERIFY.md had `ensures:`; after the edit it has no `ensures` text, keeps `hint`, `gates` and the fence; T1.2 has no child `.task` folder | covered |
| When the spec loads | real `Blend.load(spec)` | covered |
| Then R3 reports that ensures is a required property | `failures` equals exactly `[{R3, T1.2 VERIFY.md, "(root): 'ensures' is a required property"}]`; `spec` undefined; control: unedited copy loads clean | covered |
| And the JSON schema of VERIFY.md also lists ensures as required | committed schema: `title` "VERIFY.md front matter", `required` equals `["ensures"]`, `properties` has `ensures` | covered (structural; see note) |
| And release-notes and provider-ordering-admin specs still load with no failure | both committed specs: `failures` `[]`, `spec` defined, tasks > 0, every task has an obligation | covered |

Note on the writer's flag: the test runs no JSON Schema validator. The step asks whether the schema lists `ensures`
as required, and the assertion reads exactly that list. The schema root has no indirection, so the list is the
effective constraint. I judge the step proven.

## Commands and results
- `node state.mjs <spec> query scenario/VF3`: completed, trustLevel verified.
- `bun test --timeout=30000 ./test/task/verify-spec-VF3.spec.ts` (packages/opencode): 4 pass, 0 fail, 32 expect() calls, 1.9 s.
- `node state.mjs <spec> verdict VF3 trusted --reason ...`: verdict trusted, trustLevel trusted.

## Outcome
Trusted. No gap.
