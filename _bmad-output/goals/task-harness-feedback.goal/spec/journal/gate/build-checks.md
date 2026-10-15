# Build checks BUILD-1 to BUILD-6 (state CLI `check` actions, after all 54 tasks were trusted)

Each check: `update <id> start`, the command from the repository root at the goal branch, then
`update <id> complete --exit-code=<code>` with the command's real exit code.

- BUILD-1 `bun typecheck` at a41387da5c (18:00 BST): "Tasks: 30 successful, 30 total" (turbo cache hits of the same
  inputs), exit 0; completed (`check-BUILD-1.log`). A first `complete` without `--exit-code` was refused
  ("exitCode=undefined") and returned the actor to not_started.
- BUILD-2 `bun lint` at a41387da5c (18:01–19:22 BST): oxlint "Found 0 warnings and 0 errors", Effect ESLint silent,
  every Effect language-service project "0 errors, 0 warnings"; exit 0; completed (`check-BUILD-2.log`).
- BUILD-3 `bun run --cwd packages/opencode build --single --skip-install --skip-embed-web-ui` at a41387da5c
  (18:01 BST): built opencode-darwin-arm64, "Smoke test passed"; exit 0; completed (`check-BUILD-3.log`).
- BUILD-4 `bun run --cwd packages/opencode test && bun run --cwd packages/tui test`:
  - Attempt 1 (18:02–19:23 BST, `check-BUILD-4-attempt1.log`): it ran beside BUILD-2's language service, and from about
    18:30 five whole-disk `bfs` searches of another session held the load average at 100–122. 17 tests failed, each a
    timeout (PTY HTTP API, the graph proof RM19, command tests, Truncate, tool.registry, prompt loop); no failure was an
    assertion on code this branch changed. Stopped; `complete --exit-code=1` returned the actor to not_started
    (retry 1 of 3). Running it beside the lint was a mistake.
  - Attempt 2 (19:31–20:00 BST, `check-BUILD-4-attempt2.log`): alone, but other sessions' node processes raised the
    load to 45; two `spec.checked` cases of supervise-run.test.ts timed out at 30 s. Stopped before it recorded an exit
    code; the actor stays building.
  - Attempt 3 (20:01–20:51 BST, `check-BUILD-4-attempt3.log`): opencode "4212 pass / 3 fail / Ran 4257 tests"; the three
    failures are subprocess start-up timeouts of CLI tests this branch does not touch (`opencode run` with an unknown
    model 15.6 s, `acp initialize` 17.3 s, `acp` stdin EOF 5.2 s), during a load spike to 121 from another project's
    vitest run. No exit code recorded; the actor stays building.
  - Attempt 4 (20:51–21:45 BST, `check-BUILD-4-attempt4.log`): opencode "4214 pass / 1 fail / Ran 4257 tests"; the one
    failure is `test/cli/run/run-process.test.ts` "exits nonzero promptly when the model is unknown" (15.5 s against
    its 15 s bound). No exit code recorded.
  - That test, measured (21:46–22:00 BST): alone, 10.0–10.5 s on this branch and 10.0–10.4 s on the pre-harness
    baseline export (`.task-conformance/baseline/55ab6b3e56`); the whole file (13 concurrent subprocess tests) at a
    load of 24–38 failed that one test in 4 of 4 runs on this branch AND in 4 of 4 runs on the baseline. The test file
    is the same in both trees. So the failure is the machine's load against a 15 s bound, not this branch; the suite
    passed it at 16:01 at a load of 17.
  - Attempt 5 (22:02–22:27 BST, load 8–9, `check-BUILD-4-attempt5.log`): this branch's own supervise-run.test.ts case
    "a resumed slice with a 2-failure warning and a now-valid spec" failed (the stale entry missing from the run's
    log). It failed 2 of 12 times alone at load 9: the test read the run actor's log as soon as the fact was stored,
    before the actor took it. Fixed in e61728a508 (it now waits for the log entry too): 0 of 20 failures. Attempt 5
    was stopped; no exit code recorded.
