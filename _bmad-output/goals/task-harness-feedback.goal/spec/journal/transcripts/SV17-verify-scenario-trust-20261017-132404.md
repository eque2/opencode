# SV17 semantic verification

- Read: dispatch prompt, guardrails, skill, spec.md, scenarios.gherkin, tasks.md T2.3/T4.2, their journals, SV17 journal and committed test.
- Given the shared fixture and fixed clock: a real Recorder resumes the observed facts under TestClock and writes status.json; a separate engine fold projects the same facts.
- When the TUI decodes both versions; Then both decode: `parse` accepts the projected fixture and old file. The real view actor reads each from disk. Assertions check decoded fields, unit counts, old-file detection, and invalid-input rejection.
- Byte-for-byte projection: both the Recorder's output and TaskStatus.write of the engine projection equal the fixture's bytes. The observed budget-exhausted and blocked states are asserted.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-SV17.spec.ts` from packages/opencode: 4 pass, 0 fail, 38 assertions, 8.71 s.
- CLI: `verdict SV17 trusted` succeeded. `query scenario/SV17` reports state completed and trustLevel trusted. Gap: none.
