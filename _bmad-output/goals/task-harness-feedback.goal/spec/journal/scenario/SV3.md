# SV3 verification journal (eque2-verifier, action: verify, batch SV1-SV5)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for SV3. No semantic verdict in this dispatch.
- State at start: SV3 not_started, untrusted. No prior SV3 journal, no test file.
- Plan:
  1. `update SV3 start`.
  2. Write packages/opencode/test/task/verify-spec-SV3.spec.ts on the real `/task` command, the real core
     BackgroundJob registry, a seeded git instance and scripted limits. Given: a stored open slice started by /task
     with the whole-spec path, in which T1.1 builds in a real worktree with session ses_T1.1.
     - Same path (written `./<spec>/`): the slice is folded (status history and T1.1's worktree come from the stored
       facts), run.resumed is stored with the normalised path, no new run.started; the T1.1 supervisor claims and
       prompts ses_T1.1 again and T1.2 (ready in the fold) begins; T1.3 gets no supervisor.
     - The job then stops by a scope close (a server stop), so the slice stays open.
     - A different path (the T1.1 task folder): a new slice, run.started with that path, T1.1 begins again.
     - The same path after that slice ended (a job cancel stored run.cancelled): another new slice.
  3. Trial runs, one adapter run, `verify SV3`.

## 2026-10-16 OUTCOME (Layer 1+2)
- `update SV3 start`: not_started -> executing.
- Test file written: packages/opencode/test/task/verify-spec-SV3.spec.ts (2 tests, each title starts with `[SV3]`).
  The real `/task` command, the real core BackgroundJob registry (in its own scope, so closing it is a server stop),
  a seeded git instance, scripted limits, and a real T1.1 worktree in the stored slice.
- Trial runs: 2 pass, 0 fail (twice). tsgo clean for the file, oxlint 0 warnings, prettier clean (new file).
- Real run 20261016T122722Z-84770d through the adapter at HEAD 26a14ac15c (file untracked, sha256 prefix
  179d4e0c9f364c29): bun exit 0, 2 pass, 0 fail, 23 expect() calls, 3.1 s. Decision: handed-off.
- `verify SV3`: structural pass (testInCommit false). State completed, trust untrusted -> verified.
- Notes for the semantic verifier: "the slice is folded" is shown through what only the fold can give the new job:
  the status file's history entry (at 2, T1.1 building) and T1.1's stored worktree, and the reuse of the stored
  builder session; the test cannot read the job's run actor directly.

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context reviewer, batch SV1-SV5)
- Action: Layer 3 semantic trust for SV3. State at start: completed, trust verified.
- Plan: read the test file, task T2.11 and the command's resume code; judge each Gherkin step; run the test myself;
  call `verdict SV3` exactly once. I change no source or test file. I commit nothing.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- My own run at HEAD f57285510d (file committed, sha256 prefix 179d4e0c9f364c29): exit 0, 2 pass, 0 fail, 23 expect(), 15 s.
- I read command.ts `sliceOf` and `job`: the resume rule is the latest slice not ended and the same normalised path.
- Each Gherkin step has a real assertion on the real command, store, status file and harness system. The fold is
  shown through what only the fold gives: the stored history entry, attempts 1, the stored worktree and session.
- "After the slice ended" is shown with a job cancel; the done and stored-stop ends belong to RM8a and RM8c.
- Verdict: `verdict SV3 trusted` -> state completed, trustLevel trusted.
