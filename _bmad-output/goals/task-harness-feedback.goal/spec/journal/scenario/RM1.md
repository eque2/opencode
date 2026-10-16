# RM1 verification journal (eque2-verifier, action: verify, canary for the bun JUnit adapter)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario RM1 only. No semantic verdict in this dispatch.
- State at start: RM1 not_started, untrusted, retryCount 0. No prior RM1 journal.
- The adapter path in scratchpad/adapter/ is empty, and the S6 pilot adapter path no longer exists.
  I build the adapter new from the S6 recipe and refusal rules.
- Plan:
  1. Read spec.md, scenarios.gherkin (RM1), tasks.md Supports lines, task journals, the test file.
  2. Read the reporter's public interface (read only) and `bun test --help`.
  3. Build scratchpad/adapter/bun-junit-scenario-adapter.mjs.
  4. Prove each refusal rule on scratch fixtures with a dry-run mode (reporter not imported, no evidence).
  5. `update RM1 start`, run the real file once through the adapter, then `verify RM1 --evidence=...`.
- Never read or write evidence files or key material; never edit the reporter or the state CLI; commit nothing.

## 2026-10-16 OUTCOME (adapter built and proved; recipe for later verifiers)
- Adapter: /private/tmp/claude-501/-Users-marknorgate-Projects-eque2-repos-eque2-opencode-workspace-opencode--claude-worktrees-task-harness-feedback/3878ca44-82a4-48b1-8281-9fa90483a400/scratchpad/adapter/bun-junit-scenario-adapter.mjs
  (node 24, no dependencies; the header comment holds the full contract).
- Real-run recipe (run from any cwd; the adapter spawns bun in --cwd):
    node <adapter> --cwd=<repo>/packages/opencode --file=./test/task/verify-spec-<ID>.spec.ts \
      --runs=<scratchpad>/adapter/runs/<ID> --spec-folder=<SPEC_FOLDER> \
      --reporter=<repo>/.claude/skills/eque2-code-setup/scripts/scenario-state-reporter.mjs
  then: node <STATE_CLI> <SPEC_FOLDER> verify <ID> --evidence=<SPEC_FOLDER>/evidence/<ID>.json
  Options: --timeout=30000 (bun per-test), --overall-ms=170000, --idle-ms=120000. For UI scenarios that nest a
  `bun test` in packages/tui, keep --overall-ms at 170000 (under the 180 s command cap) and expect long idle gaps.
- It spawns `bun test --timeout=30000 --reporter=junit --reporter-outfile=<runs>/<runId>/junit.xml <file>`,
  tees output to <run dir>/run.log, writes <run dir>/run.json (command, bun exit, duration, counts, sha256 of the
  test file before and after, decision) and <run dir>/mapped.json (the exact files array given to the reporter).
- Mapping: bun file suite -> one Vitest file { filepath: <abs test file>, tasks, result }; describe suites ->
  { name, tasks }; testcases -> { name (entity-decoded, otherwise unchanged), result: { state pass|fail|skip,
  duration ms } }; todo maps to skip (bun marks it <skipped message="TODO">). File result: pass only on bun exit 0.
  A non-zero exit with no report maps to an empty file with result fail. The reporter is called once:
  `new Reporter({ specFolder }).onTestRunEnd([file])`.
- Refusals (exit 3, the reporter is never imported): R1 a report for another file (file attribute of the suite or
  any testcase does not resolve to --file, or more than one file suite); R2 a count mismatch (root or file suite
  tests/failures/skipped attributes vs parsed cases, bun's console summary vs the report, or exit 0 with failures);
  R3 a green exit with no report; R4 the test file changed during the run (sha256 before vs after, checked again
  just before the hand-off); R5 bun killed by the overall or idle limit (a hang is not a test result: re-run once,
  then record it). Exit codes: 0 handed off + bun 0; 1 handed off + bun non-zero; 3 refused; 4 usage/infra.
- Dry-run proofs (scratch fixtures in scratchpad/adapter/fixtures, runner shims in scratchpad/adapter/shims,
  script scratchpad/adapter/proofs/run-proofs.sh; `--dry-run` never imports the reporter, so no evidence):
  - P1 mixed (pass, fail, skip, todo, nested describe, `&` and `<>` in a name): 3 pass, 1 fail, 2 skip, names
    decoded, nesting kept, file fail, adapter exit 1.
  - P2 all pass: 2 pass, file pass, exit 0. P3 module-level throw: no report, empty file, file fail, exit 1.
  - P4 afterAll throws after every test passed: bun adds an "(unnamed)" failed case; file fail, exit 1.
  - P5 R4 (the test appends to its own file): refused. P6 R3 (shim exits 0, no report): refused.
  - P7 R1 (shim runs real bun on another file): refused. P8 R1 (shim adds a second file): refused.
  - P9 R2 (shim deletes one testcase; attributes disagree): refused. P10 R2 (shim deletes one case and fixes the
    attributes; bun's console summary disagrees): refused. P11 R5 (hanging test, --idle-ms=3000): killed, refused,
    no leftover process.
  Result: 10/10 proofs plus P1 behave as specified.

## 2026-10-16 OUTCOME (test file written)
- No sibling verify spec covers RM1 (none exists under packages/opencode/test/task/), so I wrote the registered
  file packages/opencode/test/task/verify-spec-RM1.spec.ts (5 tests, each title starts with `[RM1]`, no describe).
- It drives the real loader (`loadPlan` = Blend.load + TaskCommand.plan), the generator (`TaskMachine.machine`,
  `config`, `mapStates`, `fromConfig`) and the engine (`TaskEngineXState.initial`). Expected names come from the
  spine (AD-1 kinds and tag vocabulary, AD-2 state lists, AD-13 status names), not from the generator's tables.
- It includes a negative control: a machine built from an edited config copy (an out-of-vocabulary tag, a wrong
  meta state, a waits tag for an unknown unit) makes the gap checker name each of the four gaps.
- Trial runs without the reporter: 5 pass, 0 fail, 1360 expect() calls, about 3.2 s. tsgo typecheck clean,
  oxlint 0 warnings, prettier clean (new file).

## 2026-10-16 INTENT (Layer 1+2 real run)
- `update RM1 start`, then one real adapter run with the reporter, then `verify RM1 --evidence=...`.

## 2026-10-16 OUTCOME (Layer 1+2)
- `update RM1 start`: not_started -> executing.
- Real run 20261016T113540Z-2c7d52 through the adapter at HEAD f0d23f1b80 (test file untracked, sha256 prefix
  f213ca3b2184a051 before and after the run): bun exit 0, 5 pass, 0 fail, 0 skip, 1360 expect() calls, 3.3 s.
  Console summary and JUnit agree (5 tests, 1 file). Decision: handed-off.
- The reporter processed RM1, wrote its signed evidence and minted its own signed verdict (reporter design).
- `verify RM1 --evidence=<spec>/evidence/RM1.json`: structural pass (testFileExists, testPatternFound,
  testExecuted, testPassed; testInCommit false, as expected: the orchestrator commits the file).
  State completed, trust untrusted -> verified ("awaiting semantic verifier").
- Run artefacts: scratchpad/adapter/runs/RM1/20261016T113540Z-2c7d52/{junit.xml,run.log,run.json,mapped.json}.
- No gap found in the code for RM1. Caveat for the semantic verifier: the "every unit state" checks cover the
  release-notes plan, which has no external region; the external kind is covered by machine.test.ts (subtree plan).
