# RM4 verification journal (eque2-verifier, action: verify, batch RM2-RM6)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario RM4. No semantic verdict in this dispatch.
- State at start: RM4 not_started, untrusted, retryCount 0. No prior RM4 journal. The test file does not exist.
- Plan: take the old test list from git (engine-xstate.test.ts at b517ebb3f3^, the file before T1.6; the same 29
  titles at 403a06028c^), read the new header list and test bodies. Write
  packages/opencode/test/task/verify-spec-RM4.spec.ts: parse the header, compare it with the 29 old titles, check
  re-baselined names and retired guards against the new titles, scan each listed test body, and run the 29 listed
  tests through the project's `delegate` helper (nested `bun test`, JUnit). Then `update RM4 start`, one adapter
  run, `verify RM4`.
- I write only the scenario test file. No source edits, no commits, no evidence or key reads.

## 2026-10-16 OUTCOME (test written, Layer 1+2)
- `update RM4 start`: not_started -> executing.
- Old list: `git show b517ebb3f3^:packages/opencode/test/task/engine-xstate.test.ts` gives 29 tests (27 under
  `XStateEngine`, 2 under "the base of an unfinished run"); the same 29 titles stand at 403a06028c^. I wrote them
  into the test as a fixed list.
- Wrote packages/opencode/test/task/verify-spec-RM4.spec.ts (4 tests, titles start with `[RM4]`). It parses the
  header list of engine-xstate.test.ts, compares it with the 29 old titles, checks the re-baselined names and the
  retired guards against the new titles, runs the three named guards on the real engine, scans each listed test
  body, and runs the 29 listed tests through `delegate` (nested `bun test -t "^(XStateEngine|the base of an
  unfinished run) "`, JUnit): 29 passed.
- Trial: 4 pass, 594 expect() calls, about 12 s. tsgo: no error in this file. oxlint 0, prettier clean.
- Real run 20261016T122228Z-09de8d at HEAD 9ae952134b (sha256 prefix d361e8d649a02ec9; engine-xstate.test.ts
  unchanged in the working tree): bun exit 0, 4 pass, handed-off, adapter exit 0.
- `verify RM4`: structural pass; state completed, trust untrusted -> verified.
- Notes for the semantic verifier:
  1. Test 14 is re-baselined by "default 4", a prepare-goal default, not a D-decision or an owner ruling. tasks.md
     T1.7 asks for exactly that name, so the test accepts `default <n>` as a named decision.
  2. Test 1 ("is named xstate") reads only the engine's name: it runs no fact sequence, as the old test did.
  3. Several listed tests (3, 6, 7, 10, 11, 15, 16, 17, 19, 24) also read the history as `snapshot.context.log`
     (directly or by `entriesOf`), and 6 and 17 read a phase tag with `hasTag`. The test proves that
     `view(snapshot).history` is the same array as `context.log`; it forbids every other internal read.

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context semantic verifier, batch RM2-RM6)
- Action: verify-scenario-trust (Layer 3). State at start: RM4 completed, trustLevel verified.
- Plan: read the RM4 Gherkin, owner ruling 2, tasks.md T1.7, the test file, the header list of
  engine-xstate.test.ts and the old file from git; judge the "default 4" naming and the test-1 note afresh; run the
  file myself; then call `verdict RM4` exactly once. No source or test edits.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- My own bare runs: verify-spec-RM4.spec.ts -> 4 pass, 0 fail, 594 expect(), 10 s; engine-xstate.test.ts -> 46 pass.
- Git check: the old file at b517ebb3f3^ (and 3e57ac078c^, before the goal touched it) holds the same 29 titles.
- Judged afresh: "default 4" is the spec's recorded prepare-goal decision (derived from D3) and the name tasks.md T1.7
  requires; test 1 reads only the engine's name, so it has no facts to fold. Both are accepted readings, not gaps.
- `verdict RM4 trusted` -> {"verdict":"trusted","trustLevel":"trusted"}.
