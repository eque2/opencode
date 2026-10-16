# VF8 verification journal (eque2-verifier, action: verify, batch VF6-VF10)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario VF8. No semantic verdict in this dispatch.
- State at start: VF8 not_started, untrusted, retryCount 0. No prior VF8 journal.
- Read: tasks.md T3.4 and T4.10 (both support VF8), journal/task/T3.4.md, core/command.ts (`plan`, `leftOut`,
  `header`, `headerParts`), the VF8 and header cases of core-command.test.ts, the acceptance files of
  release-notes.spec (each scenario's `needs`).
- No sibling verify spec covers VF8, so write packages/opencode/test/task/verify-spec-VF8.spec.ts, each title with
  `[VF8]`. Plan: run the real `TaskCommand.run` on the T1.1 and T1.2 task folders of a committed copy of the
  release-notes spec; the expected left-out ids come from the scenario files' `needs` (computed in the test and pinned
  as a literal read from the acceptance files); assert the first message's `Left out:` line and
  `metadata.taskHarness.header.leftOut` hold exactly those ids; control: the whole spec and the T1 folder leave none.
- Never read or write evidence or key files; never edit the reporter, the state CLI or any source file; commit nothing.

## 2026-10-16 OUTCOME (test file written)
- Wrote packages/opencode/test/task/verify-spec-VF8.spec.ts (4 tests, each title starts with `[VF8]`, no describe).
- Tests 1-2 (the T1.1 and T1.2 task folders): Given — the left-out ids computed from each scenario's `needs` in the
  loaded spec (needs a task outside the run that is not an outside precondition), equal as a set to the ids pinned by
  hand from acceptance/*.md (T1.1: S1, S3-S6, S8-S13; T1.2: all but S3); some kept, some left out. When — the real
  `TaskCommand.run` on the folder; the job starts (not refused). Then — the first message (noReply, one part) is
  exactly [the run header, `Left out: <ids> — they need tasks outside this run.`]; the named ids equal the pinned set
  and include no kept id. And — the part metadata is exactly `{ taskHarness: { header: { spec, task, leftOut } } }`
  with `leftOut` equal to the same ids in the same order.
- Tests 3-4 (controls): the whole spec and the T1 folder leave nothing out: no `Left out` line, `leftOut: []`.
- Trial: 4 pass, 0 fail, 30 expect() calls (two runs). tsgo clean for the file; oxlint 0 warnings; prettier clean.

## 2026-10-16 OUTCOME (Layer 1+2)
- `update VF8 start`: not_started -> executing.
- Real run 20261016T124834Z-046345 through the adapter at HEAD f57285510d (test file untracked, sha256 prefix
  a0bf87f173f82428): bun exit 0, 4 pass, 0 fail, 0 skip, 30 expect() calls, 4.5 s. Decision: handed-off, exit 0.
- `verify VF8 --evidence=<spec>/evidence/VF8.json`: structural pass (testInCommit false, as expected). State
  completed, trust untrusted -> verified ("awaiting semantic verifier").
- Run artefacts: scratchpad/adapter/runs/VF8/20261016T124834Z-046345/.
- No gap found in the code for VF8.
