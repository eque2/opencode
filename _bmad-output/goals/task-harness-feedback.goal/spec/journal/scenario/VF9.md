# VF9 verification journal (eque2-verifier, action: verify, batch VF6-VF10)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario VF9. No semantic verdict in this dispatch.
- State at start: VF9 not_started, untrusted, retryCount 0. No prior VF9 journal.
- Read: tasks.md T3.5 and T3.6 (support VF9), journal/task/T3.6.md, spec.md defect 6 (loader order R1, R3, R4),
  task-formats/blend/example-format-faults.spec (every file), the pinned loader lines in blend.test.ts,
  fault-folders.test.ts, core/command.ts (`run`, `loadFailures`, the refusal).
- No sibling verify spec covers VF9 (fault-folders.test.ts is not a verify spec and has no `[VF9]` tag), so write
  packages/opencode/test/task/verify-spec-VF9.spec.ts, each title with `[VF9]`. Plan: check the three planted faults
  on disk in the seeded copy, run the real `TaskCommand.run` on the folder, and assert the refusal is the counted
  header, the R1, R3 and R4 lines (exact text) in the loader's order, then the hint; status.json reason equals the
  three lines; no job, no lease.
- Never read or write evidence or key files; never edit the reporter, the state CLI or any source file; commit nothing.

## 2026-10-16 OUTCOME (test file written)
- Wrote packages/opencode/test/task/verify-spec-VF9.spec.ts (2 tests, each title starts with `[VF9]`, no describe).
- Test 1: Given — in the seeded copy, the spec root holds exactly SPEC.md, notes.txt and T1-words.task (a stray
  file); T1.2's TASK.md body does not start with `# ` while T1.1's does (a TASK.md with no title); T1.1's front matter
  has `colour`, which no other TASK.md has (an unknown key); the loader returns exactly [R1, R3, R4] with no spec, and
  the sorted paths differ from that order. When — the real `TaskCommand.run` on the folder. Then — one noReply
  message exactly [`Refused <spec>: 3 failures. No work started.`, the R1, R3 and R4 lines (exact pinned text), the
  hint]; the rule ids are R1, R3, R4 in that order and the lines equal the loader's list; status.json reason equals
  the three lines; no job, no lease.
- Test 2: a task folder inside the faulty spec gives the same three lines in the same order.
- Trial: 2 pass, 0 fail, 20 expect() calls (twice). tsgo clean for the file; oxlint 0 warnings; prettier --write once.

## 2026-10-16 OUTCOME (Layer 1+2)
- `update VF9 start`: not_started -> executing.
- Real run 20261016T125018Z-c30944 through the adapter at HEAD f57285510d (test file untracked, sha256 prefix
  7ac4f152d0f9e76c): bun exit 0, 2 pass, 0 fail, 0 skip, 20 expect() calls, 2.4 s. Decision: handed-off, exit 0.
- `verify VF9 --evidence=<spec>/evidence/VF9.json`: structural pass (testInCommit false, as expected). State
  completed, trust untrusted -> verified ("awaiting semantic verifier").
- Run artefacts: scratchpad/adapter/runs/VF9/20261016T125018Z-c30944/.
- No gap found in the code for VF9.

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context reviewer)
- Action: Layer 3 semantic trust for VF9. State at start: completed, trust verified (structural pass).
- Plan: read verify-spec-VF9.spec.ts, the example-format-faults.spec files, `loadFailures` and the refusal in
  core/command.ts, and the loader's failure sort; map each Gherkin step to an assertion; run the file once at HEAD;
  call `verdict VF9` once.
- Do not change any source or test file; do not read evidence or key files; commit nothing.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- Own run at 9b96863f72: `bun test --timeout=30000 ./test/task/verify-spec-VF9.spec.ts` -> 2 pass, 0 fail,
  20 expect() calls, exit 0, 56 s. No source, fixture or test change since af2bdf043e.
- Step map: Given -> the three faults checked on disk (stray notes.txt, T1.2 TASK.md with no `# ` title, `colour` in
  T1.1's front matter); I read the files and confirm them. When -> real command on the folder. Then -> message exactly
  [counted header, R1, R3, R4, hint]; rule ids in order R1, R3, R4; lines equal the loader's list (sorted by rule
  number in blend/index.ts); status reason; no job, no lease. A task folder inside gives the same lines.
- Defect link: none.
- Verdict: `verdict VF9 trusted` -> state completed, trustLevel trusted.
