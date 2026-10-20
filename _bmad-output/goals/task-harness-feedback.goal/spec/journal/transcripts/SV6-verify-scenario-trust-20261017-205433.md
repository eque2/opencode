# SV6 independent semantic verification

- Read: `scenarios.gherkin`, `tasks.md` T2.8/T2.9, the SV6 journal and committed test, `test/task/lib/supervise.ts`, `src/task/core/workers.ts`, and the task, scenario and run supervisors. The test invokes real workers and records through the real Recorder and event store.
- Given: T1.1 is ready and its real `begin` worker fails in a non-git checkout. S1 is ready for a batch proof with trusted prerequisites. A verifying S2 drives the real judge, with a failing claim boundary.
- When: simulated 1-second delays separate failures one, two and three in each path. The task and batch tests assert no failed fact after the first two failures; the judge counts three claims and no prompt. The tagged WorkerError keeps the same claim message.
- Then task: one `task.failed` fact names T1.1 and starts `harness error:` with the git error. It folds to failed. A further 5 seconds records no fourth fact.
- Then scenario batch: one `scenario.proved` fact names S1, has failed status and the same prefix with the git error. It folds to failed. A further 5 seconds records no duplicate.
- Supplemental scenario judge: one `scenario.verified` fact rejects S2 with the exact harness reason and folds to rejected. T2.8's success-reset rule also has a separate focused unit test, though it is not a step in this Gherkin.
- Focused run: `bun test --timeout=30000 ./test/task/verify-spec-SV6.spec.ts` from `packages/opencode`: 3 pass, 0 fail, 30 assertions. One `verdict SV6 trusted` through the hookless verification runner succeeded. CLI query: state `completed`, trustLevel `trusted`.
- Gap: none in the stated Gherkin. No evidence or key files read, and no source, test, or state file edited.
