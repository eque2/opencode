# RM18 independent semantic verification

- Read: `spec.md`, `scenarios.gherkin`, `tasks.md` T1.11, the RM18 journal and test, `test/task/lib/supervise.ts`, and `src/task/core/supervise/run.ts`. The test uses the real run supervisor, Recorder and store. The deleted phase-1 runner survives only as Gherkin wording.
- Given/When: `supervise` starts the real actor; the whole release-notes run progresses with scripted child facts and a held S5 verdict.
- Ready-only: spawn snapshots show ready tags and trusted dependencies. Adding a ready tag to waiting T1.5 starts it; removing one from ready T1.3 prevents its start.
- No own checks/trust/done: the tag controls exclude an independent readiness rule. An outside trust fact recorded outside the supervisor prevents a duplicate trust fact; `trusting` drains and `untrustedOutside` reads the snapshot. An unsettled machine stays active with every unit trusted.
- No done fact: the stored run has no `run.ended`; the AST check finds only the failed wall-clock fact and a raised internal event.
- Stop on done: holding S5 keeps the snapshot and supervisor active; releasing its trust produces a done snapshot and a closed supervisor.
- Focused run: `bun test --timeout=30000 ./test/task/verify-spec-RM18.spec.ts` from `packages/opencode`: 5 pass, 0 fail, 51 assertions. One `verdict RM18 trusted` through the hookless verification runner succeeded. CLI query: state `completed`, trustLevel `trusted`.
- Gap: the scenario wording names the deleted phase-1 runner; its successor has the tested behavior. No assertion gap found. No evidence or key files read, and no source, test, or state file edited.
