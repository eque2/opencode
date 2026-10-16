# VF6 verification journal (eque2-verifier, action: verify, batch VF6-VF10)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario VF6. No semantic verdict in this dispatch.
- State at start: VF6 not_started, untrusted, retryCount 0. No prior VF6 journal.
- Read: guardrails.md, verify-scenario/SKILL.md, spec.md, scenarios.gherkin (VF6), tasks.md T3.4 (supports VF6),
  journal/task/T3.4.md, core/command.ts (`run`, `plan`, `folderTrust`), test/task/lib/command.ts, the subtree cases
  of core-command.test.ts, test/task/lib/machine.ts.
- No sibling verify spec covers VF6, so write the registered file packages/opencode/test/task/verify-spec-VF6.spec.ts.
  Each title starts with `[VF6]`. Drive the real `TaskCommand.run` on a committed copy of release-notes.spec in a git
  instance, with the real harness root, loader, event store and run machine. No mock of the unit under test.
- Steps: trial with plain `bun test` until green, then `update VF6 start`, one adapter run, then `verify VF6`.
- Never read or write evidence or key files; never edit the reporter, the state CLI or any source file; commit nothing.

## 2026-10-16 OUTCOME (test file written)
- Wrote packages/opencode/test/task/verify-spec-VF6.spec.ts (5 tests, each title starts with `[VF6]`, no describe).
- Test 1 (no stored run): Given — the seeded spec loads clean, T1.3 `after` is [T1.1], the T1.3 subtree plan holds only
  T1.3 with the external region T1.1 (not an outside precondition), and the run aggregate is empty. When — the real
  `TaskCommand.run` on `<spec>/T1-release-notes.task/T1.3-markdown-render.task`. Then — one noReply message equal to
  [header "Refused <path>: 1 failure. No work started.", the exact R12 line, hint "Run the whole spec, or a folder
  that holds T1.1."]; the R12 line matches the Gherkin template and its folder is T1.3's folder relative to the spec;
  no job, no lease, no fact on the run aggregate, the git worktree list unchanged; status.json run is refused with
  reason equal to the R12 line.
- Tests 2-5 (trust read by folding each stored slice through its own plan): the expected trust of T1.1 is computed in
  the test by the pure fold of the slice through the plan of its own path; the command must start the run exactly
  when that fold gives trusted, else refuse with the R12 line. Cases: whole-spec slice with T1.1 trusted (runs);
  the same then `obligation.stale T1.1.c1` (refused: the fold, not a fact scan, decides); a whole-spec slice with
  `outside.trusted T1.1` (refused: a task region takes no outside trust); a T1.3-subtree slice with the same
  `outside.trusted T1.1` (runs: its external region takes it). The last two hold the same fact and differ only in
  the slice's own plan.
- Trial without the reporter: 5 pass, 0 fail, 42 expect() calls, 17.4 s. tsgo clean for the file; oxlint 0 warnings;
  prettier --write once (new file).

## 2026-10-16 OUTCOME (Layer 1+2)
- `update VF6 start`: not_started -> executing.
- Real run 20261016T124118Z-7e07c6 through the adapter at HEAD f57285510d (test file untracked, sha256 prefix
  d425238eaf503761): bun exit 0, 5 pass, 0 fail, 0 skip, 42 expect() calls, 15.3 s. Decision: handed-off, exit 0.
- `verify VF6 --evidence=<spec>/evidence/VF6.json`: structural pass (testFileExists, testPatternFound, testExecuted,
  testPassed; testInCommit false, as expected). State completed, trust untrusted -> verified ("awaiting semantic
  verifier").
- Run artefacts: scratchpad/adapter/runs/VF6/20261016T124118Z-7e07c6/{junit.xml,run.log,run.json,mapped.json}.
- No gap found in the code for VF6.

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context reviewer)
- Action: Layer 3 semantic trust for VF6. State at start: completed, trust verified (structural pass).
- Read: guardrails.md, semantic-verify-scenario/SKILL.md, spec.md, scenarios.gherkin (VF6), tasks.md T3.4, coverage A3.a.
- Plan: read verify-spec-VF6.spec.ts and the code it drives (core/command.ts trust walk, the test helpers); map each
  Gherkin step to an assertion; run the file with plain `bun test` once; call `verdict VF6` exactly once.
- Do not change any source or test file; do not read evidence or key files; commit nothing.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- Own run: `bun test --timeout=30000 ./test/task/verify-spec-VF6.spec.ts` in packages/opencode at HEAD 6d3f86d553
  (file committed in af2bdf043e, unchanged): 5 pass, 0 fail, 42 expect() calls, 162 s (machine load).
- Step map: Given -> loads clean, T1.3 after [T1.1], subtree external [T1.1], no stored facts. When -> real
  `TaskCommand.run` on the T1.3 folder. Then refused before work -> no job, no lease, no fact, worktrees unchanged.
  R12 line -> exact text, regex of the Gherkin template, folder relative to the spec, status reason. Fold through own
  plans -> four slice cases; stale-after-trusted and the same `outside.trusted T1.1` under two plans discriminate a
  fold through the slice's own plan from a fact scan or a fixed plan.
- Note: each case stores one slice; the newest-first walk over several slices is VF20/VF24 scope. Not a gap for VF6.
- Defect link: VF6 does not depend on the `trusting`-state trust drop in supervise/run.ts (no trust reaches a live run).
- Verdict: `verdict VF6 trusted` -> state completed, trustLevel trusted.
