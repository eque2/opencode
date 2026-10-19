# State — task-harness-feedback

- Stage: 3 (pursue-goal). `ACs.md`: 43 of 46 ticked. Open: AC 29 (final quality gate: the opencode suite and o2 conformance), AC 28 (final merge), AC 46 (no goal path tracked on dev after the merge). The gate file still reports its last evaluation (42 met) because no Stop hook ran in the OpenCode session.
- Develop-spec state on 2026-10-19: 54/54 tasks, 108/108 scenarios completed and trusted (UI3 and UI8 re-verified after test-only fixes), 5/5 build checks completed with trustLevel `verified`. BUILD-1/2/3/4/6 need a fresh verifier's trust verdict, citing the final AC 29 logs.
- AC 29 at product HEAD 688450d923: root `bun lint` exit 0 and root `bun typecheck` exit 0 (2026-10-19); `packages/tui` `bun run test` 368 pass, 0 fail. The `packages/opencode` suite has not yet exited 0: run 3 failed UI3 only (load 30-40), run 4 UI8 only (load 15-20), run 5 seven timing tests at load 80-170 (stopped). UI3 and UI8 are fixed (D23), the acp EOF test is fixed (D21).
- AC 27 ticked: 3 of 4 live runs, $0.5944 (`spec/journal/live/README.md`). D22 (TUI command list fails when an MCP server offers prompts) is open and outside the harness.
- A waiter (`$TMPDIR/opencode/ac29/chain.sh`) starts the opencode suite when the 1-minute load is under 30 and the 5-minute load under 35, then o2 conformance if the suite exits 0. Logs: `$TMPDIR/opencode/ac29/opencode-suite6.log`, `conformance.log`, `chain.log`.
- Next: see `handover.md`.
