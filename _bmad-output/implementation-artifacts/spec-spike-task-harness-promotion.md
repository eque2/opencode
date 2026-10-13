---
title: 'Promote the spike-task-harness winner (O2) to production'
type: 'feature'
created: '2026-10-13'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
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
- Non-harness commits taken with the transfer (AC 14): `dbf57fe844` (Punjabi Nastaliq i18n mapping, needed for the app suite on Bun 1.3.14), `25eb9e45ba` (ESLint `runSync` exception scoped to the engine file), `a0113e5f11` (`.gitignore` line only), `70e1f314bd` (task-ui README only).

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `bun lint` and `bun typecheck` at the root -- expected: exit 0
- `GITHUB_ACTIONS=false bun turbo test` -- expected: all tasks pass
- `cd packages/opencode && bun run test:httpapi` -- expected: every mode passes
- `cd packages/opencode && bun run script/task-conformance.ts --arm o2 --runs 1` -- expected: exit 0, H1-H16 pass, margin >= 50
