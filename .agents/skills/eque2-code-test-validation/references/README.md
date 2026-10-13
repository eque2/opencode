# Test-Validation References

The canonical anti-flakiness standard for this module, reshaped for two jobs:
**advising** a test while it is built, and **validating** a test after it is built.
Portable and repo-agnostic — no repo-specific names, paths, or IDs.

| File | Job | Used by |
|---|---|---|
| [`build-time-guidance.md`](./build-time-guidance.md) | **Advise while authoring** — imperative rules an LLM follows as it writes a spec (locator ladder, auto-wait over hard-wait, isolation, no floating promises, container scoping). | `[ET]` build prompts (Stages 3/5 + engine) cite this so generated tests start compliant. |
| [`validation-rubric.md`](./validation-rubric.md) | **Validate after authoring** — checkable anti-pattern list with detection cues + severities for scoring an existing `*.spec.ts`. | The `[TV]` skill loads this to score tests and drive the report + auto-fix offer. |
| [`constrained-spa-playbook.md`](./constrained-spa-playbook.md) | **Escape hatches** — disciplined patterns for iframe / heavyweight vendor SPAs you can't add test-ids to or mock. Bounded+documented settles here are `waived`, not failures. | Referenced by both jobs when the target is a constrained third-party SPA. |

Both job-docs derive from the same source: a deep research report on the causes and
prevention of flaky Playwright tests (official Playwright docs + corroborated field
reports). `build-time-guidance.md` and `validation-rubric.md` are the two faces of one
standard — change one, keep the other in step.
