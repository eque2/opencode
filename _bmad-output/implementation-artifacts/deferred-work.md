# Deferred work — spike-task-harness promotion

Items the promotion does not take on, each with its reason. Part A comes from this build's review and checks; part B
lists every item of the spike's `builds/deferred-work.md` that this goal does not take on. Count at the end.

## A. From this build

- source_spec: `_bmad-output/implementation-artifacts/spec-spike-task-harness-promotion.md`
  summary: `opencode run --command task <spec>` never exits after /task answers in code (a refusal, a trust record or a started run); `run.ts` waits for a `session.status` idle event that a no-model-turn command never causes.
  evidence: AC 18 binary smoke (`scratchpad/binary-smoke.sh`): the refusal landed in status.json, and `run` was ended by a 180 s alarm. The re-planned task-harness goal (`goal/task-harness`, 661d031026) holds "opencode run with the task command returns only after the run ends and the host session is idle".
- source_spec: (same)
  summary: Proofs run `bun test` only, so a repository with another test runner fails every proof.
  evidence: review row 5; the format's gates say `requires: "Bun 1.3"`; the spike already deferred "a configurable test command and report adapter (T2 uses pnpm/nx)".
- source_spec: (same)
  summary: A user documentation page for /task (blend specs, `/task trust <id>`, `.opencode/task/status.json`, the task-ui designs and keys).
  evidence: review row 6; commands.mdx now states the /task exception; the task-ui README covers the TUI side.
- source_spec: (same)
  summary: A shadowed `task` command, MCP prompt or skill is reported in the log only, not in the TUI.
  evidence: review row 7; the log warning meets AC 19; a TUI notice needs a host-generic notice path.
- source_spec: (same)
  summary: Proofs and the harness agents' shells lack proxy and CA variables (HTTPS_PROXY, NO_PROXY, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE), so a test that needs a proxy fails.
  evidence: review row 9 (the keys part is fixed in f15a176a58); passing proxy variables could leak credentials embedded in a proxy URL, so it needs a per-project setting.
- source_spec: (same)
  summary: A model-written test can read files under the user's HOME (for example opencode's auth.json); the allowlist keeps keys out of the environment, it is not a sandbox.
  evidence: review row 10; HOME is needed by bun and git.
- source_spec: (same)
  summary: The conformance guard is manual: CI does not run it, and no committed record ties a pass to a commit.
  evidence: review row 12; the runner header states it (AC 23); every attempt's JSON is kept in the goal folder's journal.
- source_spec: (same)
  summary: The task-ui keys (`<leader>j/k/o/v/w`, Tab while live) are fixed, not named keybind ids a user can rebind.
  evidence: review row 15; other built-ins use keybind ids (`tui-plugins.md`).
- source_spec: (same)
  summary: A user's `agent.task-builder` or `agent.task-verifier` config can override or disable the harness agents.
  evidence: review row 31; a deliberate user act; a warning like the command shadowing would cover it.
- source_spec: (same)
  summary: Leaf worktrees and branches are kept after a run ends.
  evidence: commit 35acea8a3f notes; they are the run's evidence, and a cleanup command needs its own design.

## B. Spike deferred items this goal does not take on

The goal took on, by name, the environment allowlist for proof commands, the read-only verifier, builders confined
to their worktree, the base branch from the repository (not a hard-coded main), the dirty-root refusal with
`.opencode/task/` excluded, and status, worktrees and branches keyed by run (AC 20, review rows 1-4). These remain:

- source_spec: `builds/spec-apparatus-blend-validator.md` (spike)
  summary: Validator hardening: symbolic links (loops, dangling), Windows-style paths in RepoPath, dot-files under R1, R10 path normalisation, R6 check that `{test: k}` targets a test-proved obligation, walking children of an R2-invalid folder, the root `.spec` name pattern, scenario step validation, relative paths in read-error messages, one source for the proof-kind and budget vocabularies.
  evidence: none of these inputs occurs in the two trees, and several would change parity with the reference checker, which is not in the repository.
- source_spec: `builds/spec-apparatus-blend-validator.md` (spike)
  summary: Gates, the spec policy and refs have no unit hash, and obligation hashes omit judges, so a changed gate command or an added judge does not invalidate stored verdicts.
  evidence: a question for the format owner; the golden model has no gate hash.
- source_spec: `builds/spec-apparatus-proof-runner.md` (spike)
  summary: Scenario tags and run-time titles in the foreign-tag scan, touch change kinds against A/M/D status, a configurable test command and report adapter, and the policy fields the runner does not enforce (redFirst, signed-reporter evidence, deployed scenarios).
  evidence: none changes a conformance check; the configurable test command is part A's Bun-only item.
- source_spec: `builds/spec-o1-runner.md` (spike)
  summary: Runner hardening: checks for mid-run trust, a second /task after an ended run, a builder that never calls task_ready and a silent verifier; bound stall retries; tie trust to a commit and store the proof evidence in the facts; a concurrency limit and rebase on merge conflict; validate trusted ids against `outside`.
  evidence: none changes the 16 scripted checks; each needs its own design; the re-planned task-harness goal is their home.
- source_spec: `builds/spec-o2-engine-xstate.md` (spike)
  summary: O2's evidence region is rebuilt and discarded on every fold step, and each apply costs about 60 µs against about 1 µs for the removed table.
  evidence: a run folds a few hundred facts, far below a model turn; an optimisation, not a defect.
- source_spec: `builds/spec-o3-plugin.md` (spike)
  summary: O3 hardening items.
  evidence: not applicable: O3 is removed (D2).

Count: 16 deferred items (10 in part A, 6 in part B).
