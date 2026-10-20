# RM19 verify-scenario-trust transcript

- Scenario: RM19 The graph walk finds no stuck state in the release-notes plan (owner ruling 4).
- Reviewer: eque2-verifier, fresh context, batch RM15-RM19 (resumed after a session limit). State before: completed,
  trustLevel verified.

## What I read
- journal/scenario/RM19.md; spec.md owner ruling 4; tasks.md T1.9 and T1.10.
- packages/opencode/test/task/verify-spec-RM19.spec.ts (unchanged since dc3c63e00b).
- src/task/engine-xstate/alphabet.ts (alphabet, walkKey); the canonical strategy in test/task/engine-xstate-graph.test.ts.

## Gherkin step -> assertion
| Step | Assertion |
|------|-----------|
| Given the release-notes plan and the engine's progress alphabet | Real loader: 6 tasks, 13 scenarios; TaskMachine.check returns the config; events from TaskAlphabet.alphabet, key from TaskAlphabet.walkKey. |
| When every state reachable with the canonical interleaving is walked within 60 s | getAdjacencyMap from TaskEngineXState.initial, canonical events, stopWhen done; elapsed < 60000 ms; edges < hang guard (walk complete). |
| Then no state that is not done lacks an event that changes its key | stuck list equals []; negative control (example-cascade.spec without blocked rows) reports stuck states incl. T1.2 waiting. |
| And every visited snapshot has status active or done | set of statuses equals [active, done]. |
| (non-vacuity) | > 100 keys; done outcomes budget_exhausted, done, failed, needs_human; observed cascade states have T1.5 and T1 blocked. |

## Commands and results
- Whole file, load ~125: cut by my 178 s limit, no result.
- `-t "structural totality|stuck detector"` (--timeout=120000): 2 pass, 8 expect(), 69.9 s.
- `-t "within 60 seconds"`, load ~120: fail on the 60 s bound only (73.9 s): load effect.
- Re-run once: pass, 18 expect(), 338 keys, 746 edges, 26.9 s.
- Whole file, `bun test --timeout=30000 ./test/task/verify-spec-RM19.spec.ts`, load ~50: 3 pass, 0 fail, 26 expect(), walk 34.1 s.
- `state.mjs <spec> verdict RM19 trusted --reason ...`: exit 0, trustLevel trusted.

## Outcome
Trusted. Note: the 60 s bound has about a 2x margin on this shared host and fails under heavy load (environment
risk, not an assertion gap).
