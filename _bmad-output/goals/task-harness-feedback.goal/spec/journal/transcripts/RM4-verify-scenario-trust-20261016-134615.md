# RM4 verify-scenario-trust transcript

Role: fresh-context semantic verifier (eque2-verifier), batch RM2-RM6. No source or test file changed.

## What I read
- `state.mjs query scenario/RM4`: completed, trustLevel verified. spec.md owner ruling 2 and "Prepare-goal defaults";
  tasks.md T1.7; decisions.md headings D2-D4; journal/scenario/RM4.md.
- packages/opencode/test/task/verify-spec-RM4.spec.ts; test/task/engine-xstate.test.ts (header lines 12-60, helpers,
  tests 1-27, B1, B2); test/task/lib/delegate.ts.
- Old file from git: `git show b517ebb3f3^:packages/opencode/test/task/engine-xstate.test.ts` (29 tests);
  3e57ac078c^ also 29; 4dcccc83ab^ 27 (B1, B2 added before the goal).

## Gherkin step -> assertion
- Given the file after the rewrite / When its header list is read: `headerOf` parses `<id> "<title>" — <class><reason>`.
- Then every old test appears once: header ids equal the fixed 29-entry list in order; each old title once; classes
  limited to three; each entry has one new test titled `<id> <class>`; ported titles equal the old titles.
- And each re-baselined test names its decision: leading parenthesis names D<n>/AD-<n>/owner ruling <n>/default <n>,
  validated against known inputs; reason text says what changed; title carries the same names; D3 for 6, 9, 11, 12,
  13, 21, 24; default 4 for 14. Controls on the name reader.
- And each retired test names the replacing guard: `Replaced by "<guard>"` for 25, 26, 27; title carries it; all three
  guards run and hold on the real engine and release-notes plan.
- And every listed test runs as a fact sequence through initial, apply and the selectors: imports exclude the machine
  module and the port; fold helpers pinned to `engine.initial`/`engine.apply`; per-body forbidden-internal scan and
  fold/read requirement; B1/B2 through `TaskCommand.sliceOf` (TaskEvents.fold with this engine); nested `bun test`
  runs the 29 listed tests, 29 pass.

## Judgement on the writer's notes
- "default 4" (test 14): accepted. It is a numbered decision recorded in spec.md, derived from D3, and tasks.md T1.7
  asks each re-baselined title to name "D3 or default 4".
- Test 1 ("is named xstate"): accepted. It checks the engine's name member, as the old test did; there is no state to
  fold and no hand-built State. Reads of `context.log` (same array as `view().history`) and of a phase tag by `hasTag`
  are public snapshot reads, not machine internals.

## Commands and results
- `bun test --timeout=30000 ./test/task/verify-spec-RM4.spec.ts`: 4 pass, 0 fail, 594 expect(), 10 s.
- `bun test --timeout=30000 ./test/task/engine-xstate.test.ts`: 46 pass, 0 fail.
- `state.mjs <spec> verdict RM4 trusted --reason ...` -> {"verdict":"trusted","trustLevel":"trusted"}.

## Outcome
Trusted. No gap; two accepted readings recorded above.
