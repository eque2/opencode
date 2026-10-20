# VF23 semantic trust transcript

- Read: guardrails, skill, spec.md, scenarios.gherkin, tasks.md T3.2/T3.11, VF23 journal and test, command helper, TaskCommand.run, Blend.load stage gate, blend README Validation section.
- Given: the seeded spec loads without faults. A real front-matter edit creates R3 alone; reciprocal after links create an R7 cycle alone. The loader asserts each fault separately before both edits coexist.
- When/Then: with both faults, the real loader reports only R3. The real `/task` reply equals the counted header, all R3 lines, and hint; status reason equals R3 lines. No graph-rule line, job, lease or run fact appears.
- Negative control: removing R3 while retaining the cycle makes loader and `/task` report R7 again. The graph fault was deferred, not omitted.
- README And: the Validation section asserts the two-stage text, R3/R7 example, and each file/graph rule table timing.
- Run: `bun test --timeout=30000 ./test/task/verify-spec-VF23.spec.ts` in packages/opencode: 2 pass, 0 fail, 38 assertions.
- Verdict: one `verification-runner.py -- node state.mjs ... verdict VF23 trusted` call succeeded. CLI query: state completed, trustLevel trusted. No material coverage gap.
