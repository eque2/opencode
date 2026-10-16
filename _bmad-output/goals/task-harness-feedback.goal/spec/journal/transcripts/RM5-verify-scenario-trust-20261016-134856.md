# RM5 verify-scenario-trust transcript

Role: fresh-context semantic verifier (eque2-verifier), batch RM2-RM6. No source or test file changed.

## What I read
- `state.mjs query scenario/RM5`: completed, trustLevel verified. tasks.md T1.8. journal/scenario/RM5.md,
  journal/scenario-findings.md, journal/task/T1.8-verify.md (log-rule lines).
- architecture/ARCHITECTURE-SPINE.md AD-5 (lines 197-240) and the fact table row for `run.resumed`.
- packages/opencode/test/task/verify-spec-RM5.spec.ts; machine.ts ACTIONS `begin`, `resume`, `check`, `stop`.

## Gherkin step -> assertion
- Given 40 seeded sequences of 100 facts, incl. after the end: 40 seed tests (mulberry32), 100 facts each, never cut;
  summary asserts all 18 FactSchema types, ids T7/T7.c1/S99, >= 30 ended runs, > 200 post-end facts; each post-end
  fact returns the identical snapshot.
- When folded with apply and sent to a live actor of the same machine: `engine.initial` + `engine.apply`;
  `createActor(TaskMachine.machine(plan))` in `Effect.scoped`, sent every fact.
- And a prefix is folded, restored, sent the rest: `getPersistedSnapshot` of the prefix fold, `createActor(machine,
  { snapshot })`, sent the suffix; >= 20 prefixes before the end, >= 5 after.
- Then the three snapshots are equal: status, value, full context (log included), sorted tags; fold = live,
  restored = fold, restored = live; control: skipping one moving fact gives a different snapshot.
- And the log grows exactly when the state or another context field changes: old log kept; any change appends;
  no change and no entry gives the identical snapshot; note-only growth allowed only for `run.started`,
  `run.resumed`, `spec.checked`, as one run entry with from === to.

## Judgement on the writer's note
The literal "exactly when" is false for the spine-mandated run notes: AD-5 says "a targetless row that writes context
always appends an entry", and the fact table gives `run.resumed` a history entry `resumed`. The machine's `begin`
(second run.started), `resume` and `check` (repeated warning) actions write only that note. The test asserts the
strongest true form and bounds the exception to three fact types, one entry, unit `run`, from === to. Accepted; the
wording gap is listed for the owner in journal/scenario-findings.md.

## Commands and results
- `uptime`: load average 40.
- `bun test --timeout=30000 ./test/task/verify-spec-RM5.spec.ts`: 41 pass, 0 fail, 10828 expect(), 64 s.
- `state.mjs <spec> verdict RM5 trusted --reason ...` -> {"verdict":"trusted","trustLevel":"trusted"}.

## Outcome
Trusted. Wording gap (owner, not a test defect) recorded.
