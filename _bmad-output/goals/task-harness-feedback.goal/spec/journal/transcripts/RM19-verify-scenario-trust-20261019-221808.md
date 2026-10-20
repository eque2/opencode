# RM19 verify-scenario-trust — 2026-10-19 22:18 (batch UI8, RM19)

Fresh-context semantic review after 46ab502fab (owner ruling 10). Dispatched directly by the orchestrator. UI8 was
done first (transcript `UI8-verify-scenario-trust-20261019-221501.md`).

## What I read

- Dispatch prompt `journal/prompts/scenario-UI8-RM19-verify-scenario-trust.md`; `references/guardrails.md`;
  `semantic-verify-scenario/SKILL.md`.
- `journal/scenario/RM19.md` (recovery). Its last entry was the structural verifier's INTENT for 46ab502fab; that
  verifier's outcome is in `transcripts/RM19-verify-20261019-221116.md` (adapter run 20261019T210938Z-ee0f43, 3 pass;
  verify -> verified).
- The RM19 Gherkin in `scenarios.gherkin` (line 224) and the CLI query; goal.md owner rulings 4, 8 and 10.
- `git show 46ab502fab` and `git diff -w 46ab502fab~1 46ab502fab`.
- The whole committed test `packages/opencode/test/task/verify-spec-RM19.spec.ts` (HEAD equals the working tree).
- Product code: `src/task/engine-xstate/alphabet.ts` (`alphabet`, `walkKey`); test helpers
  `test/task/lib/machine.ts` (`loadPlan` through `Blend.load` and `TaskCommand.plan`; `outcome`, `unitState` read only).

## Gherkin steps and their assertions

| Step | Assertion |
| --- | --- |
| Given the release-notes plan and the engine's progress alphabet | `loadPlan("release-notes.spec")` (real loader); tasks T1..T1.5 and 13 scenarios; `TaskMachine.check` returns the config unchanged; `TaskEngineXState.initial(plan).status` is active; events from `TaskAlphabet.alphabet`, key from `TaskAlphabet.walkKey` |
| When every state reachable with the canonical interleaving is walked within 60 seconds (600 s under rulings 8 and 10) | the port's `getAdjacencyMap` from the engine's first snapshot on `TaskMachine.machine(plan)`, first unit in document order only (ruling 4), `stopWhen` done, `limit` 5_000; `expect(elapsed).toBeLessThan(600_000)`; `expect(walked.edges).toBeLessThan(LIMIT)` |
| Then no state that is not done lacks an event that changes its key | `expect(walked.stuck).toEqual([])` (a state with no event, or no key-changing event, counts as stuck); negative control on example-cascade with the blocked rows removed reports stuck states, including T1.2 waiting, while the intact plan reports none |
| And every visited snapshot has status active or done | `expect(walked.statuses).toEqual(["active", "done"])` |
| (non-vacuous) | more than 100 keys (338); done outcomes exactly budget_exhausted, done, failed, needs_human; the observed cascade states have T1.5 and T1 blocked |

## Can the larger bound hide a failure?

No. Only the elapsed-time assertion uses the bound. The stuck, status and non-vacuity checks are not time-based. A
state-space blow-up fails the port's deterministic edge limit (5_000, unchanged; this walk dequeues 746). The 600 s
bound is owner ruling 10, which extends ruling 8's reading of the Gherkin's 60 s.

## Commands and results

- `state.mjs <spec> query scenario/RM19`: completed, verified (before).
- `git diff --stat HEAD -- packages/`: empty.
- `uptime`: load 41.38 / 53.43 / 68.64.
- `bun test --timeout=30000 ./test/task/verify-spec-RM19.spec.ts` (cwd packages/opencode): 3 pass, 0 fail, 26 expect()
  calls; walk 338 keys, 746 edges, 47561 ms; file 66.47 s.
- `python3 .agents/skills/eque2-code-setup/scripts/verification-runner.py -- node .../state.mjs <spec> verdict RM19
  trusted --reason "..."`: exit 0, `{"verdict":"trusted","trustLevel":"trusted"}`.
- `state.mjs <spec> query scenario/RM19`: completed, trusted (after).

## Outcome

RM19 is trusted. One verdict was issued through the CLI. Note: the Gherkin text still says "within 60 seconds"; the
600 s bound rests on owner rulings 8 and 10. No source, test or state file was edited. Nothing was committed.
