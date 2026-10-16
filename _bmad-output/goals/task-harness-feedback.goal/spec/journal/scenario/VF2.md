# VF2 verification journal (eque2-verifier, action: verify, batch VF1-VF5)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario VF2, after VF1 in the same batch. No semantic verdict in this dispatch.
- State at start: VF2 not_started, untrusted, retryCount 0. No prior VF2 journal.
- Sources: spec.md (owner ruling 3, defect 2: AD-19 narrows D10), scenarios.gherkin VF2, tasks.md T3.2, the T3.2
  journal, command.ts `refuse` (writes status.json only when no run is live).
- Plan: no sibling verify spec covers VF2, so write packages/opencode/test/task/verify-spec-VF2.spec.ts. The live run
  is a REAL `/task` job (jobs mode "run") on a committed copy of release-notes.spec whose root tasks T1.1 and T1.2 are
  after the outside precondition T9, so every task waits and the run stays live and stable. Its status.json comes from
  the real status writer. Then `/task` on a faulty spec in the same directory (a second spec folder with a planted
  fault, and the live spec's own folder path as a task path that does not exist). Assert the session refusal and that
  status.json still shows the live run (not refused, same spec, no refusal reason) and the lease is still held.
  Cancel the job at the end. Trial with plain bun test, then `update VF2 start`, one adapter run, `verify VF2`.
- Never read or write evidence or key files; never edit the reporter, the state CLI or any source file; commit nothing.

## 2026-10-16 OUTCOME (test file written)
- Wrote packages/opencode/test/task/verify-spec-VF2.spec.ts (2 tests, each title starts with `[VF2]`, no describe).
- The live run is a real `/task` job (jobs mode "run"): the real command claims the lease and starts the job; the job
  runs the real run supervisor, Recorder and status writer. T1.1 and T1.2 get `after: [T9]` (committed), so every
  task waits on the outside T9 and the run stays live with no session work until the test cancels it.
- First trial: 2 fail. My live check waited for `run.state === "running"`, but a run whose tasks all wait on an
  outside region shows `waiting` (AD-13 live state, tag `waiting`, no `endedAt`, heartbeat `aliveAt`). A test
  assumption, not a code defect. Fix: the live check accepts `running` or `waiting`, not ended, with `aliveAt`.
- The faulty spec is a second spec folder in the same directory (a copy with a second `refs` key in T1.3 TASK.md, R3).
- Assertions: the reply is exactly the counted header, the R3 line and the hint (not the busy line); no new job; the
  status file (decoded with `TaskStatus.Status`) is still the live run (same state, spec, path, `startedAt`, task ids,
  no `reason`, no faulty-spec text); the lease still names the live run. Control: after the run is cancelled and the
  lease is free, the same refusal does write status.json as refused, so the test tells the two cases apart.
- Trial without the reporter: 2 pass, 0 fail, 35 expect() calls, about 3.5 s. tsgo clean; oxlint 0 warnings (after
  one consistent-return fix in the poll helper); prettier clean (new file).

## 2026-10-16 OUTCOME (Layer 1+2)
- `update VF2 start`: not_started -> executing.
- Real run 20261016T121138Z-666f37 through the adapter at HEAD 62554af3aa (test file untracked, sha256 prefix
  743e039510b36857): bun exit 0, 2 pass, 0 fail, 0 skip, 35 expect() calls, 3.7 s. Decision: handed-off, exit 0.
- `verify VF2 --evidence=<spec>/evidence/VF2.json`: structural pass (testInCommit false, as expected).
  State completed, trust untrusted -> verified ("awaiting semantic verifier").
- Run artefacts: scratchpad/adapter/runs/VF2/20261016T121138Z-666f37/{junit.xml,run.log,run.json,mapped.json}.
- No gap found in the code for VF2.
