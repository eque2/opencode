# RM8b verification journal (eque2-verifier, action: verify, batch RM7, RM8a, RM8b, RM8c, RM9)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for RM8b only. No semantic verdict in this dispatch.
- State at start: RM8b not_started, untrusted, retryCount 0. No prior RM8b journal.
- No sibling verify spec covers RM8b (core-command.test.ts has an RM8b unit test on `sliceOf` and `normalizedPath`
  only). I write the registered file packages/opencode/test/task/verify-spec-RM8b.spec.ts.
- Plan: store one old-form whole-spec slice (run.started with a base and no path, T1.1 trusted, no run.ended) in the
  real event store of a seeded git instance; run the real `/task` twice in separate instances, once as `<spec>` and
  once as `./<spec>/`, with the job running; read the stored facts back. Pure checks: the fold is not done, the slice
  choice resumes for the whole spec and starts new for a subtree path, the path forms normalise to the spec path.
- Write only the test file; no source edit; commit nothing; never read evidence or key files.

## 2026-10-16 OUTCOME (test file written, Layer 1+2)
- Wrote packages/opencode/test/task/verify-spec-RM8b.spec.ts: 4 tests, each title starts with `[RM8b]`, no describe.
  Two pure tests (the stored slice and its fold; the whole-spec slice choice and path forms) and two instance tests
  (real event store, real `/task` as `<spec>` and as `./<spec>/`, job running, then a cancel and an interrupt).
- The stored slice: run.started { base: <checkout branch> } with no path, T1.1 built, proved and trusted, no stop.
  The base equals the checkout branch, because a resume of a slice from another branch is refused by design.
- Each instance asserts: the reply is the header alone; one job of the run id; the lease holds the spec path; the old
  facts stay; the first appended fact equals { run.resumed, base, path: <spec> } exactly; no run.started is appended;
  one run.resumed; still one slice whose first fact is the old run.started; run.resumed is an old fact type and decodes.
- Trial runs: 4 pass, 0 fail, 54 expect() calls, about 3.6-4.3 s (twice). tsgo clean, oxlint 0 warnings, prettier
  clean (new file).
- `update RM8b start`: not_started -> executing.
- Real run 20261016T121150Z-2f0828 through the adapter at HEAD 62554af3aa (test file untracked, sha256 prefix
  cec160564a8c91e7): bun exit 0, 4 pass, 0 fail, 0 skip, 54 expect() calls. Decision: handed-off, adapter exit 0.
- `verify RM8b --evidence=<spec>/evidence/RM8b.json`: structural pass; testInCommit false, as expected. State
  completed, trust untrusted -> verified.
- No gap found in the code for RM8b. Reading for the semantic verifier: "records only run.resumed" is read as "the
  resume marks itself with run.resumed and with no run.started"; the resumed run then goes on and can record its own
  work facts, which the test stops by a cancel.

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context Layer 3 reviewer, batch RM7, RM8a, RM8b, RM8c, RM9)
- Action: judge RM8b afresh and call `verdict RM8b` once. State at start: completed, trust verified.
- Plan: read the committed test file and the code it drives; map each Gherkin step, including "records only
  run.resumed"; run the file with bare `bun test`. No edit; commit nothing; no evidence or key reads.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- Read the test file (committed b9553cc37d, no later change), test/task/lib/command.ts, src/task/core/command.ts
  (`normalizedPath`, `pathOf`, `sliceOf`) and src/task/core/supervise/run.ts (`startRun`).
- Own run: `bun test --timeout=30000 ./test/task/verify-spec-RM8b.spec.ts` -> 4 pass, 0 fail, 54 expect() calls.
- "Records only run.resumed": `startRun` marks a resume with run.resumed alone (outside.trusted only for external
  regions, none in a whole-spec run). The test's reading matches the code. No gap.
- `verdict RM8b trusted`: trustLevel trusted.
