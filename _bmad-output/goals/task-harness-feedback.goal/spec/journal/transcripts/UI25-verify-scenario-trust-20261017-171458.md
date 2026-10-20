# UI25 independent semantic review

- Read: dispatch prompt, guardrails, scenario query, scenario journal, `scenarios.gherkin`, `spec.md`, T4.2/T4.8 journals, scenario test, display table, Board, Matrix, Gantt and UX text.
- Given: lines 56–70 and 172–188 load two historical files and assert no tags, title or heartbeat.
- When/Then liveness: lines 190–211 assert `still` for each file at two clocks, with a fresh-status control.
- Then fallback: lines 214–238 render seven designs and assert the exact line and muted colour.
- And task display: lines 250–281 check all task glyphs and labels in Ledger and Ticker. Lines 283–294 check glyph/id alone in Dock, Matrix and Gantt. Gantt's right-hand state text and HUD's task display are not asserted.
- And classification: lines 296–318 assert Board headings all zero and no cards. Lines 320–335 forbid one full state-derived trusted count and stopped groups, but a partial nonzero trusted count could pass.
- Run: `bun test --timeout=30000 ./test/task/verify-spec-UI25.spec.ts` from `packages/opencode`: 4 pass, 0 fail, 185 assertions.
- Verdict: `verdict UI25 rejected` succeeded. CLI trustLevel: `suspect`; prior queried state: `completed`.
- Gaps: check labels where the designs display them and assert the exact tag-derived count in each design.
