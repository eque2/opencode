# RM23 semantic verification

- Read: guardrails, spec.md, scenarios.gherkin, tasks.md, RM23 and T1.1 journals, and the full committed `verify-spec-RM23.spec.ts`. No evidence or keys read.
- Given pinned port / When probes run: package catalog, direct dependency and resolved 0.2.0 package are asserted. Nine tests call the port directly.
- Dot split, parallel final, onDone: dotted target and guard fail with the split `#T1` path while underscored controls resolve; a final child handles `reopen`; targeted onDone resets both children and an untargeted control preserves them.
- Done, raised and done events: a `poke` increments a done snapshot's context; a sent `go` has `at=5`, whereas raised `inner` and generated done events record no `at`.
- Tags, cap and edges: tags are an array with exact contents and `hasTag`; eventless loops settle under 1000 and fail over it; graph limit 4 succeeds while 3 fails for four edges, with a ten-loop control.
- Commands: `state.mjs ... query scenario/RM23` returned completed/verified. `bun test --timeout=30000 ./test/task/verify-spec-RM23.spec.ts` returned 9 pass, 0 fail, 37 assertions. `state.mjs ... verdict RM23 trusted --reason ...` returned trustLevel trusted; subsequent query returned state completed / trustLevel trusted.
- Outcome: trusted. No gap identified. No test, source or protected file changed directly.
