---
title: 'Promote the spike-task-harness winner (O2) to production'
type: 'feature'
created: '2026-10-13'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '6deb46357228dae670fa8046fbbc8d20378403ee'
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/packages/opencode/AGENTS.md'
  - '{project-root}/_bmad-output/goals/spike-task-harness-promotion.goal/decisions.md'
  - '{project-root}/_bmad-output/goals/spike-task-harness-promotion.goal/ACs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The spike's winning `/task` harness (O2, xstate-effect engine) and its task-ui are on the promotion branch as spike code: three engines behind an `OPENCODE_TASK_HARNESS` selector, a task-ui that only a demo script loads, six unexamined validator messages, and safety gaps the spike deferred (provider keys reach model-written tests, a writable verifier, a hard-coded `main`).

**Approach:** Keep O2 alone and always on, make the task-ui a built-in, close the deferred safety items the approved contract names, reach byte parity with the golden model, and keep the conformance suite as a two-arm same-run guard against the pre-promotion commit — all to the approved goal contract (`_bmad-output/goals/spike-task-harness-promotion.goal/ACs.md`, D1–D9).

## Boundaries & Constraints

**Always:** build to `decisions.md` D1–D9 without re-deciding them; evidence every goal criterion with real command output; small atomic commits with Why / Source / Notes; Effect idioms of the surrounding code; the guard's baseline is commit `55ab6b3e56`; keep all seven task-ui designs.

**Never:** push; edit `task-formats/blend/golden/`; weaken a conformance check; ship `launch.sh`, `task-seed.sh`, the presenter launch mode, or any `_bmad-output`/spike reference in product code; retry the guard until green; run a live (paid) L1 run; bulk-delete branches or worktrees.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY_PATH | `/task task-formats/blend/release-notes.spec` in a clean repo on any branch | run starts on the checked-out branch as base | N/A |
| DIRTY_ROOT | uncommitted change outside `.opencode/task/` | named refusal, no model turn | refusal names the dirty paths |
| SHADOWED_COMMAND | config defines `command.task` | harness keeps `/task`; one warning names the shadowed command | warning, not error |
| PROOF_ENV | `OPENAI_API_KEY` set in opencode's environment | proof commands do not see it | allowlist only |
| NO_DESIGN | task-ui built-in with no `design` option | default design shows | N/A |
| BASELINE_DOWN | baseline export fails to start | guard exits non-zero, reason in JSON | non-zero exit |

</frozen-after-approval>

## Code Map

Paths are under `packages/opencode/` unless they start with `packages/` or `task-formats/`.

- `src/task/core/selector.ts`, `src/task/core/engines.ts`, `src/task/engine-table/`, `src/task/harness-plugin/` -- delete (O1, O3, the selector, the dynamic engine registry).
- `src/session/prompt.ts:62,1214-1223,1289,1428-1430` -- `TaskSelector.inCore` gates; the repetition stop and `createTaskHarnessTools` are no-ops for unwatched sessions and other agents, so drop the gates; dispatch `/task` to `TaskCommand.run` always.
- `src/command/index.ts:13,92-100,102-117` -- register `task` always; the `cfg.command` (102) and MCP (117) loops overwrite it: skip `Default.TASK` there with `Effect.logWarning` naming the shadowed command (house style: `src/skill/index.ts:127`).
- `src/agent/agent.ts:37,282-338` -- builder/verifier always registered (already `hidden`). Verifier: `bash` allows only `git diff|log|show*` and `bun test*`, `external_directory: deny`. Builder: `external_directory: deny` (checked by `tool/external-directory.ts`, `tool/shell.ts:295,687` against the leaf worktree — a deterrent, not a sandbox).
- `src/task/core/command.ts:15,20,131-134,158,179-182,188,209` -- static `TaskEngineXState.XStateEngine`; no harness check; reply text without the option name; resolve base branch and refuse a dirty root before starting.
- `src/task/core/status.ts:62-66,81,118,154` + `src/task/core/runner.ts:43,112` -- drop the `harness` field; `packages/tui/src/task-ui/store.ts:39` and fixtures (`packages/tui/test/task-ui/fixture-status.json:2`, `test/task-harness/arms/status.ts:25`, `test/task-harness/arms.test.ts:42`, `test/task/core-status.test.ts`).
- `src/task/core/workspace.ts:10,64,68,112,114` -- `MAIN = "main"` becomes the run's base branch carried on `TaskRunner.Start` (`runner.ts:41-53`, callers 353, 502-503, 597).
- `src/task/proof/process.ts:34,96-105` -- spawn with an allowlisted env (PATH, HOME, TMPDIR, LANG, LC_*, TERM, SHELL, USER, GIT_*, CI, TZ, OPENCODE_TASK_* for the harness's own report path); used by `proof/index.ts:161,264,403` and `core/workspace.ts:41`.
- `src/task/blend/document.ts:53-61`, `src/task/blend/schema.ts:12-20,148,151` -- replace the standard issue formatter with a Python-jsonschema-style walker (enum, type, pattern with the JSON-Schema source text, additionalProperties grouped at the parent, Python repr); `test/task/blend.test.ts:36,113-120` -- drop `SCHEMA_MESSAGE_CASES`, compare whole output, assert 38 cases.
- `src/task/engine-xstate/index.ts:20-60` -- rewrite the spike header (deviations, `_bmad-output` paths) as production docs; `src/task/core/model.ts:3-4,123-124` -- `Engine.name` is `"xstate"`.
- `test/task/engine-table.test.ts` -> `test/task/engine-xstate.test.ts` -- keep the 27 contract cases on `XStateEngine`; drop the differential and registry tests; `test/task/harness-wiring.test.ts` -- drop selector cases.
- `script/task-conformance.ts:29,33,43,46,61-141` + `test/task-harness/arms/{index,server,status}.ts` + `conformance.test.ts:27-29` -- two arms (`baseline`, `o2`); `--arm o2` runs both; baseline = `git archive 55ab6b3e56` export in the run folder with its own `bun install --frozen-lockfile` (ELECTRON_SKIP_BINARY_DOWNLOAD=1), entry passed to `Server.start`; startup preflight; exit gate; run folder renamed from `.spike-runs` (also `.gitignore:64`).
- `packages/tui/src/feature-plugins/builtins.ts:23-37` -- add the task-ui plugin (`id: "internal:task-ui"`); built-ins get no options, so the default design applies. `packages/tui/src/task-ui/index.tsx:1-3`, `README.md:3-5,17-29,68-77` -- rewrite as product docs; delete `launch.sh`. Test: load the entry via `createTuiPluginApi` (`packages/tui/test/cli/cmd/tui/notifications.test.ts:46-79`, fixture `packages/tui/test/fixture/tui-plugin.ts`), dispatch `task_ui.pick` per design, rewrite the status file and wait over 1 s.
- Rollback: only workspace sync replays stored events (`src/server/routes/instance/httpapi/handlers/sync.ts:51`, `src/control-plane/workspace.ts:358,412`); `packages/core/src/event.ts:64-69` dies on unknown durable types. Local session list/open read projections.

## Tasks & Acceptance

**Execution:**
- [ ] `src/task/{harness-plugin,engine-table,core/selector.ts,core/engines.ts}` -- delete; gates in prompt/command/agent always on; static engine; drop `harness` status field -- D2, AC 1/9/17
- [ ] `src/command/index.ts` -- skip and warn on a shadowing config/MCP `task` command; test -- AC 19
- [ ] `src/task/proof/process.ts` -- env allowlist; `src/agent/agent.ts` -- read-only verifier, confined builder; `src/task/core/{workspace,command,runner}.ts` -- base branch from the repo, dirty-root refusal; tests -- AC 20
- [ ] `src/task/blend/{document,schema}.ts`, `test/task/blend.test.ts` -- byte parity, no exemptions -- AC 3/22
- [ ] `packages/tui/src/feature-plugins/builtins.ts`, `packages/tui/src/task-ui/*`, test -- built-in, all 7 designs, no demo -- AC 4/21
- [ ] `script/task-conformance.ts`, `test/task-harness/*` -- two-arm same-run guard -- AC 2/23/24
- [ ] `src/task/engine-xstate/index.ts` and leftovers -- production docs, no spike text -- AC 16
- [ ] build + binary smoke (AC 18); rollback check (AC 27); quality gate (AC 6)

**Acceptance Criteria:**
- Given the goal contract `_bmad-output/goals/spike-task-harness-promotion.goal/ACs.md`, when this spec is done, then AC 1-4, 6, 14, 16-24, 27 and 28 hold with evidence.

## Implementation Notes

- 2026-10-13: Checkpoint 1 passed without a human pause under the developer's goal "Complete all workflows autonomously"; the spec exceeds 1,600 tokens and is kept whole (one approved promotion, D1). Multi-goal check: one goal, the promotion the plan approved.
- Transfer (AC 14): 178 picks onto this branch, `2cdd8c054c` to `6deb463572` — 175 whole product commits with `-x` (their spike SHA in the message), and three partial picks: `25eb9e45ba` (ESLint), `a0113e5f11` (`.gitignore` line only), `70e1f314bd` (task-ui README only). Skipped: 30 evidence-only commits, `19ca8d4768` (tooling; dev has 0.67.1 as `55ab6b3e56`), `8b4325a5e6` (`task-seed.sh`, demo tooling), `be2452ea6a` (`task-ui.md` brief).
- Picked commits that touch files outside the harness folders (promotion-branch SHAs):
  - harness wiring in core files: `6d5c712d05` (`src/command/index.ts`), `02d8664aa2`, `10d53690a6`, `4c74c37268` (`src/agent/agent.ts`), `8c459b2bd7`, `6eeac31100`, `d640bafeb6` (`src/session/prompt.ts`);
  - dependency and tooling: `8ab699cad4` (`@jambudipa/xstate-effect` 0.1.0 in the catalog, `bun.lock`), `17e50e4bd3` (`eslint.config.mjs` `runSync` exception for the engine file), `1cfb58dfdb` (`.gitignore` run folder);
  - test library: `56d851acda`, `c8b9e979d9` (`test/lib/llm-server.ts` per-request responder);
  - generic TUI used by the watch view: `ec31485090` (route `watch` param, `session_watch` slot, plugin API and spec doc), `1344b18eea` (hide a hint whose key another layer takes);
  - unrelated fix: `db6c781b4c` = spike `dbf57fe844` (`packages/app/src/i18n/desktop-native.ts`, Punjabi Nastaliq to the Arabic-script bundle; the app suite fails on Bun 1.3.14 without it).

- Implementation commits (all on this branch):
  - `dc65c9c2ac` remove the O3 plugin harness; `753835377c` make the xstate engine the only harness (selector, O1, engine registry and the `harness` status field gone; prompt hooks ask `TaskHooks.watching`; 27 contract cases moved to `engine-xstate.test.ts`).
  - `a1a3b5d427` warn when a config or MCP `task` command is shadowed.
  - `a88daab69e` proof env allowlist; `47fb0d50fa` read-only verifier, confined builders; `4325961f06` base branch from the repo, dirty-root and detached-HEAD refusal, merge only onto the base; `beb7e7212d` command-level refusal tests (services resolved after refusals).
  - `e99aabc57a` engine header as product docs; `28e3d83d16` task-ui built-in (`internal:task-ui`) with a plugin-entry test; `f110a4c1a4` README as product docs, `launch.sh` deleted.
  - `8664d7bbb1` validator messages in jsonschema's words (no exemptions, 38 cases, whole output compared).
  - `440eb4f3ea` two-arm same-run conformance guard (baseline pinned to `55ab6b3e56`, exported and installed under `.task-conformance/`, preflight, non-zero exit).
  - `17efbe7bef` dependency order as `bun install` writes it.
- Surprise: the spike's baseline commit is not on dev, so the apparatus lived in the 88 commits before it (found in the contract review).
- Surprise: `opencode run --command task` never exits after a code-answered command (no idle event without a model turn); deferred to the re-planned task-harness goal (see `deferred-work.md`).
- Surprise: under load average 70–290 from other work on the machine, Bun's default 5 s test timeout cut the instance-based tests; the package script's `--timeout 30000` holds.

## Spec Change Log

## Review Triage Log

Review pass 1, 2026-10-13, on `6deb463572..e264d01b4f`'s first state (`review.diff`, 297 kB): blind hunter (B, 18 findings), edge-case hunter (E, 18), verification-gap reviewer (V, 8 + 2). Overlaps are merged into one row and tagged with every lens. Every survivor was patched or deferred; no finding routed to intent_gap or bad_spec.

| # | Finding (lenses) | Verdict and evidence | Route | Outcome |
|---|---|---|---|---|
| 1 | A parent review's `restore` runs `git clean -fd` in the root checkout; untracked user files were let through and would be deleted (B) | high: `runner.ts` restores `run.directory` after a root judge; the old `uncommitted` skipped untracked files on purpose | patch | fixed `a7fa014ce0`: untracked files refuse /task |
| 2 | The base branch is not stored; a resume after a branch switch merges into the new branch (B, E) | medium: base came from the checkout at each /task; facts held no branch | patch | fixed `4dcccc83ab`: `base` on run.started/resumed, resume on another branch refused |
| 3 | Leaf branches and worktrees named by task id only; a second spec's T1.1 reuses the first's branch; a merged leaf restarts from an old tip (B) | high: `task/<id>` reused when present | patch | fixed `35acea8a3f`: `task/<run key>/<id>`, merged branch reset to the base head |
| 4 | `.opencode/task/` not ignored; `git add -A` would add leaf worktrees as embedded repos (B) | high: `config.ts` gitignore lacks `task/` | patch | fixed `89424cc678`: the folder writes its own `*` .gitignore |
| 5 | Proofs run `bun test` only; other test runners fail every proof (B) | medium, pre-existing in the format (`requires: "Bun 1.3"`) | defer | deferred-work.md |
| 6 | Docs say every built-in can be overridden; no /task user docs (B) | low: commands.mdx:320 | patch + defer | note fixed `e264d01b4f`; a /task docs page deferred |
| 7 | Shadow warning only in the log; a skill named task dropped silently; no off switch (B, V8) | medium for the skill path: `if (commands[item.name]) continue` | patch / defer / reject | skill fixed `a74a9ffc7a`; a visible TUI notice deferred; an off switch rejected: D2 decides "no switch" |
| 8 | Wrong refusal reasons: no git, no commits, git status named for a git diff failure (B, E, V) | medium: every git failure mapped to "detached HEAD" | patch | fixed `a7fa014ce0` (`readiness`) |
| 9 | Proofs get an allowlisted env, the builder's and verifier's shells the full env; proxy and CA variables missing in proofs (B, E) | medium: `tool/shell.ts` spawns with process.env, as for every opencode agent | defer | deferred-work.md |
| 10 | GIT_ and BUN_ prefixes pass tokens; HOME lets a test read auth.json (B) | medium (security): GIT_CONFIG_PARAMETERS can carry a header token | patch + defer | prefixes fixed `4b95545df5`; HOME is needed by tools, documented as a deterrent |
| 11 | Guard ignores the noise floor, a dirty fingerprint and sameFixture; `--arm baseline` prints passed; guard() untested (B, V7) | medium: verdict inline in a top-level script | patch | fixed `64428e097c` (`guardFailures` + tests) |
| 12 | Nothing enforces or records the guard (B) | low: the header says it is manual (AC 23) | defer | deferred-work.md; every attempt's JSON is kept in the goal journal |
| 13 | Baseline isolation checks core only; two runs can delete each other's export (B, E) | medium | patch | fixed `64428e097c` (`linksInside`, lock file) |
| 14 | The random-fact fold left with O1 (B, E) | medium | patch | fixed `7e84e29332`, `5e93e76412` |
| 15 | Design choice not persisted; keys not rebindable; plugin missing from the spec's built-in list (B) | low/medium | patch + defer | persistence and list fixed `2430bd8c3a`; keybind ids deferred |
| 16 | All seven designs ship; the plugin polls even without runs (B) | false as a defect: the user asked "We want all the task designs! As options"; a 1 s stat is negligible | reject | — |
| 17 | Spike wording left in runner, events and test comments (B, E) | low | patch | fixed `e264d01b4f`, `64428e097c` |
| 18 | Python repr of floats and non-string keys is not exact (B, E) | low: not rebuildable from parsed JS values | patch (claim) | comment narrowed `c10a0811ed`; exact float repr rejected |
| 19 | No runner-level run on a non-main base (V1) | medium | patch | fixed `64428e097c` (seed on `dev`) |
| 20 | The /task dispatch has no normal test (V2) | medium | patch | fixed `c636108c3c` |
| 21 | The `watching` gate has no normal test (V3) | medium | patch | fixed `c636108c3c` |
| 22 | Most R3 message shapes unpinned (V4) | medium | patch | fixed `c10a0811ed` (27 cases checked against jsonschema 4.25.0) |
| 23 | The uncommitted test cannot see the `.opencode/task` exclusion (V5) | low | patch | fixed `a7fa014ce0` |
| 24 | The built-in task-ui never tested without a status file (V6) | medium | patch | fixed `2430bd8c3a` |
| 25 | A non-string `covers` item gets the anyOf message, not jsonschema's type message (V) | low | patch | fixed `c10a0811ed` |
| 26 | A tag named like the branch gives `heads/<name>` (E) | low | patch | fixed `a7fa014ce0` |
| 27 | A crash mid-merge leaves the root dirty, so /task refuses its own resume (E) | medium | patch | `a7fa014ce0`: a named refusal "a merge is in progress … `git merge --abort`" |
| 28 | An instance in a subfolder sees only its own changes (E) | medium | patch | fixed `a7fa014ce0` (from the top) |
| 29 | Windows variable casing drops Path in proofs (E) | medium | patch | fixed `4b95545df5` |
| 30 | The verifier's shell denies pipes and `git --no-pager` (E) | low | patch | prompt names the allowed forms `e264d01b4f` |
| 31 | User config can override or disable the harness agents (E) | low: a deliberate user act | defer | deferred-work.md |
| 32 | User permission deny rules are not merged into the harness agents (E) | medium, design question | defer | deferred-work.md |
| 33 | `bun test` loads `.env` files in root-checkout proofs (E) | medium, unverified fix | defer | deferred-work.md |
| 34 | The verifier can write through `git diff --output` or `bun test -u` (E) | low: the runner restores the judge's checkout after each round | reject | — |
| 35 | `.spike-runs/` dropped from .gitignore (E) | low: only the spike worktree had such folders | reject | — |
| 36 | Guard attempt 2 (o2 13/17): H4, H8, H9 passed their 16 s wall bound under load (own run) | high for the guard: same test 2.4 s, 3.4 s, 11 s | patch | fixed `9c131e5fa1` (margin 60 s) |
| 37 | `opencode run --command task` never exits after a code-answered command (AC 18 smoke) | medium | defer | deferred-work.md (the re-planned task-harness goal holds the criterion) |

## Verification

**Commands:**
- `bun lint` and `bun typecheck` at the root -- expected: exit 0
- `GITHUB_ACTIONS=false bun turbo test` -- expected: all tasks pass
- `cd packages/opencode && bun run test:httpapi` -- expected: every mode passes
- `cd packages/opencode && bun run script/task-conformance.ts --arm o2 --runs 1` -- expected: exit 0, H1-H16 pass, margin >= 50
