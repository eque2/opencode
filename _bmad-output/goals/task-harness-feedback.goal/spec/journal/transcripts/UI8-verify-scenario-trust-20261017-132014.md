# UI8 semantic verification

- Read: guardrails, Gherkin, spec.md, tasks.md, UI8 and T4.11 journals, and full `verify-spec-UI8.spec.ts`. No evidence or keys read.
- Given: a stored unended run resumes through `/task`; a scripted judge and the root's real model turn each wait behind a Deferred gate. The root session is asserted busy.
- When run ends: releasing the judge finalizes the folded run. The root turn stays held; no summary appears until its model reply completes.
- When user aborts: `SessionPrompt.cancel` stops the turn and cancels the job. The test awaits the turn, asserts one `run.cancelled`, and then checks the summary.
- When run is cancelled: `BackgroundJob.cancel` finalizes the run while the root turn remains held. No summary appears before the turn is released.
- Then: all three cases assert exactly one assistant summary after the header and turn, no logged summary failure, and a later root prompt with a new model hit and its answer.
- Commands: `state.mjs ... query scenario/UI8` returned completed/verified. `bun test --timeout=30000 ./test/task/verify-spec-UI8.spec.ts` returned 3 pass, 0 fail, 48 assertions. `state.mjs ... verdict UI8 trusted --reason ...` returned trustLevel trusted. Subsequent query returned state completed / trustLevel trusted.
- Outcome: trusted; no Gherkin gap. No test or source changed.
