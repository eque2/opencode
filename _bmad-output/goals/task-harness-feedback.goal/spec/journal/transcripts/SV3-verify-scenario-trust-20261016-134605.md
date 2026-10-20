# SV3 verify-scenario-trust transcript

## What I read
- journal/scenario/SV3.md, spec.md (owner ruling 3), tasks.md T2.11, core/command.ts (`normalizedPath`, `sliceOf`,
  `job`), core/supervise/run.ts (`cancel`, `startRun`).
- packages/opencode/test/task/verify-spec-SV3.spec.ts (committed; sha256 prefix 179d4e0c9f364c29).

## Gherkin steps and their assertions
- Given a stored slice not ended, started by /task with a path: run.started {path: SPEC} and task.started T1.1
  (real worktree, session ses_T1.1) in the real store.
- When /task runs again with the same path: `./SPEC/` (normalised to SPEC).
- Then the slice is folded: status.json has T1.1 building, attempts 1, the stored worktree, and history entry at 2.
- run.resumed is recorded with that path: fact 3 is run.resumed {path: SPEC, base}; one run.started only.
- The supervisor starts what the folded state asks for: the T1.1 supervisor claims and prompts ses_T1.1; T1.2 gets
  task.started in a new session; T1.3 has no supervisor. A scope close leaves the slice open.
- And /task with a different path starts a new slice: run.started with the T1.1 folder path; T1.1 begins in a new
  session.
- Or after the slice ended: after a job cancel stores run.cancelled, the same path records a third run.started; no
  run.resumed.

## Commands and results
- `bun test --timeout=30000 --reporter=junit ... ./test/task/verify-spec-SV3.spec.ts` (packages/opencode, HEAD
  f57285510d): exit 0, 2 pass, 0 fail, 23 expect(), 15 s.
- `state.mjs verdict SV3 trusted --reason ...`: trustLevel trusted.

## Outcome
Trusted. No gap for this Gherkin. The done and stored-stop slice ends are RM8a and RM8c.
