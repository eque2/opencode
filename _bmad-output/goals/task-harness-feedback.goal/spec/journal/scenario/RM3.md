# RM3 verification journal (eque2-verifier, action: verify, batch RM2-RM6)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario RM3. No semantic verdict in this dispatch.
- State at start: RM3 not_started, untrusted, retryCount 0. No prior RM3 journal. The test file does not exist.
- Plan: read the engine module (src/task/engine-xstate/), core/events.ts, the old module at b517ebb3f3^ (for the old
  definitions), and engine-api.test.ts. Write packages/opencode/test/task/verify-spec-RM3.spec.ts (titles start with
  `[RM3]`): runtime exports, a comment-stripped source scan with a negative control, and the XStateEngine shape.
  Trial with bare `bun test`, then `update RM3 start`, one adapter run, `verify RM3`.
- I write only the scenario test file. No source edits, no commits, no evidence or key reads.

## 2026-10-16 OUTCOME (test written, Layer 1+2)
- `update RM3 start`: not_started -> executing.
- Wrote packages/opencode/test/task/verify-spec-RM3.spec.ts (4 tests, titles start with `[RM3]`). It reads the runtime
  exports of index.ts, machine.ts, alphabet.ts and core/events.ts, scans their comment-stripped source (and all of
  `src` for the names that no other module may use), and drives `initial`, `apply`, `view`, the selectors and
  `TaskEvents.fold` on the real release-notes plan. A control proves the scanner finds the old definitions in the
  shape the old module (b517ebb3f3^) wrote them and ignores comments and longer names.
- Trial: 4 pass, 99 expect() calls, about 3.6 s. tsgo: no error in this file (an unrelated error exists in another
  verifier's untracked verify-spec-RM8c.spec.ts; not mine, not touched). oxlint 0, prettier clean.
- Real run 20261016T121436Z-1fa693 at HEAD 62554af3aa (sha256 prefix 9a3d75d97ace454b): bun exit 0, 4 pass,
  handed-off, adapter exit 0. `verify RM3`: structural pass; state completed, trust untrusted -> verified.
- Note for the semantic verifier: `cancel` is still a name in src/task/core/supervise/run.ts (RunSupervisor.cancel,
  the job's cancel finalizer) and core/sessions.ts; these are supervision code, not the engine's fold code, so the
  `cancel` check is scoped to the engine module.
