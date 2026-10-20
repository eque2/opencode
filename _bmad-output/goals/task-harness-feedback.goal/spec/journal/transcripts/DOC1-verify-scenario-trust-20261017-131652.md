# DOC1 semantic verification

- Read: guardrails, Gherkin, spec.md, tasks.md, DOC1 and T3.11 journals, full `verify-spec-DOC1.spec.ts` and full blend README. No evidence or keys read.
- Given README / When Validation opens: tests extract `## Validation` and its five subsections from the real file, and reject the old heading.
- Before work and refusal: text checks name the loader and check order; a real command invocation refuses loader faults before git, writes every line to run.reason, and starts no job. A valid spec with dirty git gets the plain refusal.
- Rules: the table must have exactly R1 through R13 in order, with existing code paths and rule markers. It distinguishes runtime R12.
- Order and faults: prose names effective after, blocked cascade and parent wait. A real cascade fold checks those moves. The loader refuses cycle, self-after, ancestor/descendant and unknown-reference fixtures with R7/R6.
- Folders: table rows equal all eight on-disk folders. Five faulty folders receive the stated /task refusals, outside-run gets a subtree R12 refusal and whole-spec start, and both live-check folders load with the stated units.
- Commands: `state.mjs ... query scenario/DOC1` returned completed/verified. `bun test --timeout=30000 ./test/task/verify-spec-DOC1.spec.ts` returned 4 pass, 0 fail, 172 assertions. `state.mjs ... verdict DOC1 trusted --reason ...` returned trustLevel trusted. Subsequent query returned state completed / trustLevel trusted.
- Outcome: trusted, no Gherkin gap. No test or source changed.
