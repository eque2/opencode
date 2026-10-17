# SV18 semantic verification

- Read: dispatch prompt, guardrails, skill, spec.md, scenarios.gherkin, tasks.md T2.1/T2.13/T4.13, their journals, SV18 journal, committed test and state-audit.test.ts.
- Given each forbidden harness construct; When audit runs: the test copies both trees and the unchanged audit, plants one construct, then runs the audit test. A clean copy passes.
- Failure names file and identifier: eight planted cases require a failed audit result and a finding for the plant's exact file, identifier and rule. No other file may appear in findings.
- Task-ui sleep and Schedule: two separate plants fail by name and rule. The same constructs outside task-ui pass.
- Real tree and written reasons: the audit passes in place. Blanking DISPLAY's reason in a copy fails with that allowlist key.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-SV18.spec.ts` from packages/opencode: 3 pass, 0 fail, 66 assertions, 17.06 s.
- CLI: `verdict SV18 trusted` succeeded. `query scenario/SV18` reports state completed and trustLevel trusted. Gap: none.
