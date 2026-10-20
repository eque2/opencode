# UI7 semantic verification

- Read: guardrails, Gherkin, spec.md, tasks.md, UI7 and T4.11 journals, full `verify-spec-UI7.spec.ts`, `summary.ts` and EXPERIENCE's closing-summary contract. No evidence or keys read.
- Given: a real stored run folds to T1.5 budget exhausted, T1 blocked, S4 verifying, S5 blocked and S13 parked; it carries an earlier failed spec check. Two root child sessions hold token and cost usage.
- When final: `/task` resumes through SessionPrompt, the real judge tool rejects S4, the job closes, and the folded machine is asserted final.
- Assistant summary without a model call: root messages have exactly one user header and one assistant text message. The assistant has zero usage and the model requests belong to the judge alone.
- Content: exact lines cover the outcome, counts, duration, 1.5M tokens, $2.31, stopped task reasons, rejected scenario reason, parked scenario, warning and every task duration. The UX contract places blocked scenarios in counts, not the failed-scenario section.
- Escaping: exact raw markdown contains CommonMark escapes. The transcript-equivalent renderer shows `<`, `*`, `_`, backtick and `|` literally in the two model-text reasons.
- Commands: `state.mjs ... query scenario/UI7` returned completed/verified. `bun test --timeout=30000 ./test/task/verify-spec-UI7.spec.ts` returned 2 pass, 0 fail, 27 assertions. `state.mjs ... verdict UI7 trusted --reason ...` returned trustLevel trusted. Subsequent query returned state completed / trustLevel trusted.
- Outcome: trusted; no Gherkin gap. No test or source changed.
