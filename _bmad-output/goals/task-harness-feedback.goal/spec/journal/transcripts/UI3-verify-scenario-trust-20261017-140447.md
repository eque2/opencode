# UI3 semantic verification

- Read: scenario, spec.md, tasks.md T4.1/T4.3, task journals, UI3 journal and test, state CLI query.
- Given/When: statuses with harness tags and heartbeats are read by the real taskView machine. The exact 15,000 ms age is live; 15,001 ms is still.
- Then: the real plugin with an owned harness child and fresh heartbeat handles Tab, watch and esc twice; selection, route and abort are asserted.
- And liveness: missing or old heartbeat, ended tag and no file are asserted by machine and disk-feed tests, including live-to-still aging.
- And inert keys: the plugin test checks Tab reaches the agent, no watch navigation, no toast and no abort for unowned, still, ended and absent cases. A machine test covers disarm after liveness changes.
- Command: `bun test --timeout=30000 ./test/task/verify-spec-UI3.spec.ts` in packages/opencode: 4 pass, 0 fail, 71 expect calls.
- Command: verification-runner wrapped `state.mjs ... verdict UI3 trusted --reason ...`: success, trustLevel trusted. Initial query state completed, trustLevel verified.
- Outcome: trusted; no semantic gap.
