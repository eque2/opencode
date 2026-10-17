# SV9 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier (semantic trust), batch SV6-SV10, OpenCode runtime.

## Read
- Dispatch prompt; guardrails.md; semantic-verify-scenario/SKILL.md; journal/scenario/SV9.md; scenario-findings.md;
  tasks.md T2.8, T2.9, T2.10; spine AD-7 and the `outside.trusted` fact-table row.
- Test `packages/opencode/test/task/verify-spec-SV9.spec.ts` (unchanged since 6841bc0e5d).
- Code: `src/task/engine-xstate/alphabet.ts`.

## Gherkin step -> assertion
- Given each unit kind in each state -> three real `/task` runs (example-scenarios, example-cascade, release-notes
  T1.5 subtree); the covered-state lists are asserted exactly: leaf ready/building/proving/verifying, parent
  ready/verifying, scenario ready/verifying; test 3 adds outside waiting and external waiting (start-up).
- When its supervisor records a fact -> every stored fact of the slice, replayed through the real pure fold, checked
  against the real `TaskAlphabet.alphabet` of the snapshot before it (same type and unit).
- Then the fact is in the alphabet for that state, or is one of the listed exceptions -> zero NOT ALLOWED in each run;
  exact exception lists (run.started; task.nudged x2; spec.checked x2; run.cancelled); test 3 asserts the whole
  ordered list. Negative control: out-of-state facts and a late external trust are NOT ALLOWED.

## Open wording note (SV9 in scenario-findings.md)
- Decided: the test's reading meets the Gherkin. AD-7 and AD-15 put the external trust in the alphabet "in the
  start-up step"; the alphabet encodes that as an empty log, but `run.started` (a listed exception) does not move the
  region. The test bounds the allowance (real start-up step, untrusted region, empty-log alphabet holds it) and its
  negative control refuses a later one. The Gherkin wording could still name it (owner).

## Gaps
- None that fails the Gherkin. Not exercised but allowed by the list: run.resumed, run.ended, obligation.stale.
  task.failed and task.needs_human are not exercised here (SV6 covers task.failed).

## Commands
- `state.mjs <spec> query scenario/SV9` -> completed, verified.
- `bun test --timeout=30000 ./test/task/verify-spec-SV9.spec.ts` (packages/opencode) -> 4 pass, 0 fail, 15.2 s.
- `state.mjs <spec> verdict SV9 trusted --reason ...` -> exit 0, trustLevel trusted.

## Outcome
Trusted.
