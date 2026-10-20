# VF1 verification journal (eque2-verifier, action: verify, batch VF1-VF5)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario VF1. No semantic verdict in this dispatch.
- State at start: VF1 not_started, untrusted, retryCount 0. No prior VF1 journal.
- Plan:
  1. Read spec.md, scenarios.gherkin (VF1), tasks.md (T3.2 supports VF1), the T3.2 task journal, the command code and
     the existing core-command.test.ts refusal cases and helpers.
  2. No sibling verify spec covers VF1 (only verify-spec-RM1.spec.ts exists), so write the registered file
     packages/opencode/test/task/verify-spec-VF1.spec.ts. Each title starts with `[VF1]`. Drive the real loader and
     the real `TaskCommand.run` with the project's helpers; no mock of the unit under test.
  3. Trial with plain `bun test` until green, then `update VF1 start`, one adapter run, then `verify VF1`.
- Never read or write evidence or key files; never edit the reporter, the state CLI or any source file; commit nothing.

## 2026-10-16 OUTCOME (test file written)
- Wrote packages/opencode/test/task/verify-spec-VF1.spec.ts (3 tests, each title starts with `[VF1]`, no describe).
- It seeds a committed copy of release-notes.spec in a git instance (`seed` of test/task/lib/command.ts) and plants
  three faults in three files: R4 (T1.1 TASK.md with `## Goal` renamed), R3 (an unknown key in T1.4 TASK.md) and R1
  (a stray `draft.txt`). The loader order (by rule) differs from the path order, so the order check discriminates.
- It drives the real `TaskCommand.run` (through `runTaskInputs`) with the real harness root and loader. The expected
  lines come from `Blend.load`; the status reason is read back from status.json on disk (`refusalOf`).
- Assertions: one noReply message of exactly 5 lines (header "Refused <path>: 3 failures. No work started.", the
  three lines in loader order, the hint); `run.reason` equals the three lines joined with `\n` and holds no header or
  hint; no job and no lease; a typed task-folder path appears in the header and the hint, with the same lines.
- Trial without the reporter: 3 pass, 0 fail, 35 expect() calls, about 6.6 s. tsgo typecheck clean; oxlint 0
  warnings; prettier clean (new file).

## 2026-10-16 OUTCOME (Layer 1+2)
- `update VF1 start`: not_started -> executing.
- Real run 20261016T115753Z-aa6214 through the adapter at HEAD 62554af3aa (test file untracked, sha256 prefix
  3ff23f5975bf9260): bun exit 0, 3 pass, 0 fail, 0 skip, 35 expect() calls, 7.0 s. Decision: handed-off, adapter exit 0.
- The reporter wrote VF1's signed evidence. `verify VF1 --evidence=<spec>/evidence/VF1.json`: structural pass
  (testFileExists, testPatternFound, testExecuted, testPassed; testInCommit false, as expected).
  State completed, trust untrusted -> verified ("awaiting semantic verifier").
- Run artefacts: scratchpad/adapter/runs/VF1/20261016T115753Z-aa6214/{junit.xml,run.log,run.json,mapped.json}.
- No gap found in the code for VF1.

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context semantic verifier)
- Action: Layer 3 semantic trust for VF1. State at start: completed, trustLevel verified.
- Plan: read the committed test file verify-spec-VF1.spec.ts, the code under test (core/command.ts refusal path,
  TaskStatus.refused, the test helpers it uses), and judge each Gherkin step against a real assertion. Run the file
  myself with plain `bun test` from packages/opencode. Then one `verdict VF1` (trusted or rejected).
- I judge only; I change no source or test file; I read no evidence or key file; I commit nothing.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- Read: the test file (committed in 3789623276), test/task/lib/command.ts (seed, runTaskInputs, refusalOf),
  core/command.ts `loadFailures` and `refuse`, tasks.md T3.2, scenarios.gherkin VF1.
- Own run: `bun test --timeout=30000 ./test/task/verify-spec-VF1.spec.ts` in packages/opencode: 3 pass, 0 fail,
  35 expect() calls, 2.7 s.
- Every Gherkin step has an exact assertion against the real command, harness, loader and status.json on disk.
- Verdict: `verdict VF1 trusted` -> trustLevel trusted. No gap.
