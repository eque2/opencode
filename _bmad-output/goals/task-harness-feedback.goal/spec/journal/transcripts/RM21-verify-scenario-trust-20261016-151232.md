# RM21 — verify-scenario-trust transcript (2026-10-16 15:12)

Reviewer: eque2-verifier, fresh context, batch RM20, RM21, RM24. Outcome: **trusted**.

## What I read

- Dispatch prompt, `references/guardrails.md`, `semantic-verify-scenario/SKILL.md`.
- `spec.md` (Verification Intent, owner ruling 4), `scenarios.gherkin` RM21, `tasks.md` T1.10.
- `journal/scenario/RM21.md`.
- `packages/opencode/test/task/verify-spec-RM21.spec.ts` (commit cd8205fbc0; working tree equal to HEAD).
- `src/task/engine-xstate/machine.ts`: `blockRows` (line 681, the only source of `target: "blocked"`), its uses in
  `always` lists (lines 807, 811, 917, 921, 932), `config`, `mapStates`, `check`, `totality`.
- `src/task/engine-xstate/alphabet.ts`, `test/task/lib/machine.ts` (`loadPlan`, `observed`, `unitState`), the port's
  `src/graph/adjacency.ts`.

## Gherkin steps and assertions

| Step | Assertion | Verdict |
|------|-----------|---------|
| Given a copy of the release-notes machine config without the blocked rows | plan from `loadPlan("release-notes.spec")`, tasks `[T1, T1.1..T1.5]`, T1.5 after `[T1.3, T1.4, T9]`; real config has blocked rows (> 0), the copy has none, the remaining `always` rows are equal; `check(plan, real)` returns real; `check(plan, copy)` throws `/totality/`; copy machine uses the real ACTIONS and GUARDS; first snapshot active, T1.5 waiting | covered |
| When the copy is walked | `getAdjacencyMap(copy machine, { canonical alphabet, walkKey, stopWhen done, limit 2 500 })`; statuses `[active, done]` | covered |
| Then the walk reports a stuck state with T1.1 to T1.3 trusted, T1.4 budget exhausted, and T1.5 and T1 waiting | `stuck.length > 0`; a stuck snapshot with the observed configuration exists; its machine states and its status names equal the observed set; status active; `waitingOn(T1.5)` contains T1.4; no `blocked` tag on T1.5 or T1; key equals `walkKey(snapshot)`; no alphabet fact changes it | covered |

Extra test: the observed facts plus `outside.trusted T9`, folded with `engine.applyTo` on the copy, reach the same
configuration; every one of the 486 states that the whole alphabet reaches from there keeps it and stays active, and
some are stuck.

## Commands and results

- `state.mjs <spec> query scenario/RM21` → completed, trust verified.
- `bun test --timeout=30000 --reporter=junit --reporter-outfile=/tmp/rm-trust-runs/RM21/junit.xml ./test/task/verify-spec-RM21.spec.ts`
  in packages/opencode → exit 0, 3 pass, 0 fail, 994 expect() calls, 37.28 s; copy walk 398 keys, 33 stuck.
- `state.mjs <spec> verdict RM21 trusted --reason "..."` → exit 0, trustLevel trusted.

## Notes

- The second test's assertion count (10) shows one matching stuck snapshot with an empty alphabet, so its
  "no fact changes the key" loop does not run; an empty alphabet means that nothing can move the snapshot. Not a gap.
- I did not run the adapter: the structural layer is complete, and a trust dispatch writes no evidence.
- Gap: none.
