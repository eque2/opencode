# RM20 — verify-scenario-trust transcript (2026-10-16 15:10)

Reviewer: eque2-verifier, fresh context, batch RM20, RM21, RM24. Outcome: **trusted**.

## What I read

- Dispatch prompt `journal/prompts/scenario-RM20-RM24-verify-scenario-trust.md`; `references/guardrails.md`;
  `semantic-verify-scenario/SKILL.md`.
- `spec.md` (Verification Intent, owner ruling 4), `scenarios.gherkin` RM19–RM24, `tasks.md` T1.9, T1.10, T1.15, T3.8.
- `journal/scenario/RM20.md` (the builder-verifier's verify entries).
- `packages/opencode/test/task/verify-spec-RM20.spec.ts` (commit cd8205fbc0; working tree equal to HEAD).
- `src/task/engine-xstate/alphabet.ts` (alphabet, walkKey), `machine.ts` (config, check, totality, machine),
  `index.ts` (initial), `test/task/lib/machine.ts` (loadPlan), the port's `src/graph/adjacency.ts`
  (limit fails with TraversalLimitError at line 72; transitions hold every next snapshot, error status included).
- `test/task/engine-xstate-graph.test.ts` (the unit graph proof; the scenario file mirrors its walk).
- `verify-spec-RM21.spec.ts` (same walk and stuck rule, used as the sensitivity control).

## Gherkin steps and assertions

| Step | Assertion | Verdict |
|------|-----------|---------|
| Given the loaded plans of the two live-check folders | `loaded()` asserts `Blend.load(...).failures` is `[]` and the spec id, then `loadPlan` (TaskCommand.plan); task ids `[T1, T1.1]` + scenario `S1`; `[T1, T1.1, T1.2, T1.3]`, T1.2 after T1.1, budget of T1.1 is 1 | covered |
| and from phase 3 the whole outside-run plan and its T1.2 subtree | whole plan `[T1, T1.1, T1.2]`, external `[]`; subtree `[T1.2]`, external `[T1.1]`, `waitingOn(initial, T1.2)` contains T1.1 | covered |
| When each plan is walked within 60 seconds | `getAdjacencyMap(TaskMachine.machine(plan), { canonical alphabet, walkKey, stopWhen done, limit 900 })`; `walked.ms < 60000`; each test timeout 60 000 ms | covered |
| Then each walk finds no stuck state | `stuck` (not done and no transition to another key; an empty transition set counts as stuck) equals `[]`; statuses `[active, done]`; `done > 0`; `keys > done` | covered |

## Commands and results

- `state.mjs <spec> query scenario/RM20` → completed, trust verified.
- `bun test --timeout=30000 --reporter=junit --reporter-outfile=/tmp/rm-trust-runs/RM20/junit.xml ./test/task/verify-spec-RM20.spec.ts`
  in packages/opencode → exit 0, 4 pass, 0 fail, 38 expect() calls, 8.30 s. Walks: 23/46/396 ms, 108/292/2 517 ms,
  29/74/537 ms, 14/35/121 ms (keys/edges/time).
- `state.mjs <spec> verdict RM20 trusted --reason "..."` → exit 0, trustLevel trusted.

## Notes

- I did not run the adapter: the structural layer is complete, and a trust dispatch writes no evidence.
- No mocks. The walk harness is test code, the same as the T1.10 unit proof; the machine, alphabet, key, loader
  and port are the real code.
- Gap: none.
