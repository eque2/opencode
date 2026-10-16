# SV1 verification journal (eque2-verifier, action: verify, batch SV1-SV5)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for SV1. No semantic verdict in this dispatch.
- State at start: SV1 not_started, untrusted. No prior SV1 journal, no test file.
- Plan:
  1. `update SV1 start`.
  2. Write packages/opencode/test/task/verify-spec-SV1.spec.ts: a TypeScript-AST inspection of every source file
     under packages/opencode/src/task/ for each construct the Gherkin names (polled loop, tick counter, stale
     cadence counter, failure map, failure limit, stopping flag, children list, worker FiberMap, judged-state list,
     process-wide run registry), and a live run started by the real `/task` command and found through the harness
     actor system by `run:<runID>`.
  3. Trial runs with bun, then one adapter run, then `verify SV1 --evidence=...`.
- Never read or write evidence or key files; never edit the reporter, the state CLI or any source file; commit nothing.

## 2026-10-16 OUTCOME (Layer 1+2)
- `update SV1 start`: not_started -> executing.
- Test file written: packages/opencode/test/task/verify-spec-SV1.spec.ts (8 tests, each title starts with `[SV1]`).
  - A TypeScript-AST scan of every file under packages/opencode/src/task/ (by construct kind, not only by name).
  - A negative control: the same scan over a planted source flags each named construct.
  - The live run: the real `/task` command, the real core BackgroundJob registry, a seeded git instance; the run is
    found as `run:<runID>` in the harness actor system, a second harness root does not see it, and a cancel removes it.
- Two rule corrections during trials (my rules were too broad, the claim did not change): function-local consts
  named `stopped` computed from tags are not a flag; the AD-1 tag vocabulary lists (`TAGS`, `Tag`) are not state lists.
- Trial runs without the reporter: 8 pass, 0 fail. tsgo clean for the file, oxlint 0 warnings, prettier clean (new file).
- Real run 20261016T121819Z-3ab569 through the adapter at HEAD 62554af3aa (file untracked, sha256 prefix
  f9ae7f1d4d6896cb): bun exit 0, 8 pass, 0 fail, 43 expect() calls, 28.6 s. Decision: handed-off.
- `verify SV1`: structural pass (testInCommit false, as expected). State completed, trust untrusted -> verified.
- Notes for the semantic verifier: AD-17 keeps two polls in proof/process.ts (`appender`, `awaitGroupGone`); the
  test pins exactly those. "Failure limit" is read as the runner's MAX_FAILURES with its failure map; the three
  supervisors' FAILURE_LIMIT constants remain as xstate guard parameters over a context count, and the test pins that.

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context reviewer, batch SV1-SV5)
- Action: Layer 3 semantic trust for SV1. State at start: completed, trust verified.
- Plan: read the test file, spec.md, tasks T2.12/T2.13, the source under packages/opencode/src/task/; judge each
  Gherkin step against its assertions; run the test file myself; call `verdict SV1` exactly once.
- I change no source or test file. I commit nothing. I read no evidence or key file.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- My own run: `bun test --timeout=30000 --reporter=junit ./test/task/verify-spec-SV1.spec.ts` at HEAD f57285510d,
  file committed, sha256 prefix f9ae7f1d4d6896cb: exit 0, 8 pass, 0 fail, 43 expect(), 8 s.
- Each Gherkin step has a real assertion. The AST scan has a negative control. I cross-checked the source by grep
  and read harness.ts and supervise/run.ts: no Ref, map, set, FiberMap, endless loop or module `let` exists.
- "Failure limit" read as the runner's MAX_FAILURES: accepted. T2.12 names MAX_FAILURES; SV6 needs a 3-failure rule,
  and the three FAILURE_LIMIT uses are xstate guards over a context count.
- Verdict: `verdict SV1 trusted` -> state completed, trustLevel trusted.
