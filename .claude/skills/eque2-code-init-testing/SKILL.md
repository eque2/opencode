---
name: eque2-code-init-testing
description: Sets a repo's test baseline with the BMAD TEA chain, drives coverage high, and gates it on push and in CI. Use when the user says 'init testing', 'set up testing for this repo', 'get this repo to high coverage', 'run IT', or '/eque2-code-init-testing'.
---

# Init Testing [IT]

## Overview

This skill takes the repository it runs in from whatever tests it has to a
measured, enforced baseline: unit tests across the code, integration tests
where code crosses a process boundary, one coverage threshold that the
pre-push hook and CI both enforce, and an `AGENTS.md` block that tells every
later session how to keep the tests current. Act as a test architect who
owns the result, not the plan: the run ends with tests written, committed,
and gated, not with a document. It drives the BMAD TEA skills and supplies
the facts they would otherwise ask for.

Args:

- `--headless` / `-H` — no questions and no approval gate. Every assumption
  goes to the decision log; the run ends with JSON.
- `--scope <path>` — one package or directory instead of the whole repo.

Re-running resumes an unfinished run; on a finished one it re-verifies the
gates and reports drift. It commits; it never pushes.

## Conventions

- Bare paths (e.g. `scripts/repo_inventory.py`) resolve from the skill root.
- `{skill-root}` resolves to this skill's installed directory.
- `{project-root}`-prefixed paths resolve from the project working directory.
- `{skill-name}` resolves to the skill directory's basename.

## On Activation

Load config from `{project-root}/_bmad/config.yaml` and
`{project-root}/_bmad/config.user.yaml` (root and `eque2-code` section), and
`{project-root}/_bmad/tea/config.yaml`. Bind `{test_artifacts}` from the TEA
config (default `{project-root}/_bmad-output/test-artifacts`) and
`{workspace}` = `{test_artifacts}/init-testing` (suffix `-<scope-slug>` with
`--scope`). If `{workspace}/plan.md` exists, read it and
`{workspace}/.decision-log.md`, then continue at the first stage or layer
not marked done. Otherwise create both; the plan and the log are this run's
memory, and context compaction will happen on any repo worth running this on.

## Baseline

Run `python3 {skill-root}/scripts/repo_inventory.py --root {project-root} [--scope <path>] -o {workspace}/inventory.json`
(`--help` lists what it reports). If `bmad.testarch_skills_missing` includes
`test-design`, `automate`, `test-review`, `trace`, or `ci`, stop and give the
install: `npx bmad-method install --directory . --modules tea --tools claude-code --yes`.

Read every file in `docs_to_read`: the traps that waste a whole pass — a
framework major version, a renamed API, a banned idiom — live there. Then run
the type-check and the coverage command once per package and record the real
numbers: type errors, test files that register tests, coverage. Turn on an
lcov reporter (vitest, jest) or Cobertura (coverlet, pytest-cov
`--cov-report=xml`) if none is on, and measure with:

`python3 {skill-root}/scripts/coverage_by_dir.py <report>... --root {project-root} --depth 2`

A package with no unit runner gets its stack's standard one: vitest (jest if
the repo already uses it), pytest with pytest-cov, xUnit with coverlet.
`bmad-testarch-framework` scaffolds Playwright or Cypress only; run it only
when the strategy puts E2E in scope.

## Strategy

Run `bmad-testarch-test-design` at system level, answering its prompts from
the inventory and the baseline. Write `{workspace}/plan.md` with:

- **Scope** — in and out, as paths. Out always includes generated code,
  build output, vendored code, `_bmad-output`, and worktrees.
- **Layers** — the directories `coverage_by_dir.py` reports, ordered by
  test-design risk, then worst coverage first. A progress table: layer,
  start lines/branches, current, status, commit.
- **Test kinds** — unit tests for logic; integration tests where code
  crosses a boundary (database, HTTP, filesystem, queue), against a local
  dependency the repo can start (Testcontainers, an in-memory server), never
  a shared or production service.
- **Layout** — the convention the inventory's `layout` shows; .NET test
  projects mirror source projects (`App` → `App.Tests`) unless the repo
  already does otherwise.
- **Thresholds** — ≥ 90 % lines and ≥ 85 % branches overall, no layer below
  80 % lines. Lower one only with a named reason written in the plan (a
  UI-only layer, an adapter that needs live infrastructure).
- **Commands** — test, coverage, and type-check, copy-pasteable from the
  repository root, each one run before it is written down.

Interactive: show the plan and wait for approval. This is the only gate;
after it the run asks nothing unless it is blocked. Headless: continue, and
log each assumption in the decision log.

## Execute

The TEA skills greet and ask questions; answer every prompt from the plan's
facts and never stop for input. Per layer, in plan order:

1. Run `bmad-testarch-automate` scoped to the layer.
2. Run the layer's tests, then re-measure with `coverage_by_dir.py`. The
   ran-test count must rise: a test file that registers zero tests looks
   green and proves nothing.
3. Update the progress table and commit the layer's tests as one commit
   whose message states the layer and its before → after coverage.

A layer still under 80 % lines gets one more pass; after that, record the
shortfall and its reason in the plan and move on.

Hard rules — each one has cost a whole run:

- Never weaken an assertion, skip a test, lower a threshold, or add a
  coverage exclusion to make a number pass. Exclude generated code only, and
  name it in the plan.
- Never cast, `any`, `@ts-expect-error`, or suppress a warning to make a test
  compile.
- Do not change production code. Code that cannot be tested without a
  change goes in the report, not into a refactor.
- A test that exposes a real bug asserts the correct behaviour and is marked
  as an expected failure (`it.fails`, `pytest.mark.xfail(strict=True)`,
  `[Fact(Skip = "BUG: …")]`). Never assert the buggy behaviour.
- No network, no sleeps, no wall clock: fake timers and injected clocks.

After the last layer, run `bmad-testarch-test-review` and fix every
high-severity finding, then `bmad-testarch-trace`, and record its gate
decision in the plan.

## Enforce

**One threshold home.** Put the thresholds in the runner's own config, so a
single coverage command fails below them wherever it runs: vitest
`test.coverage.thresholds`, jest `coverageThreshold.global`, coverage.py
`[tool.coverage.report] fail_under` with `branch = true`. coverlet.collector
cannot fail a build; for .NET, add coverlet.msbuild to the test projects and
set `Threshold` and `ThresholdType` in their `Directory.Build.props`. The
gate enforces the overall thresholds; the per-layer floor is a target for
this run. Commit the config alone.

**Pre-push hook** running that one command:

- The inventory's `hooks.managers` names one → add to it (`.husky/pre-push`,
  a lefthook `pre-push` command, a pre-commit hook with
  `stages: [pre-push]`). Keep any existing pre-push content.
- None → create `.githooks/pre-push` (POSIX `sh`), mark it executable with
  `git update-index --chmod=+x`, add `.githooks/* text eol=lf` to
  `.gitattributes` (a CRLF hook dies on WSL with `$'\r': command not found`),
  and run `git config core.hooksPath .githooks`. New clones need that config
  too: in an npm repo add `"prepare": "git config core.hooksPath .githooks || true"`;
  elsewhere the AGENTS.md block carries the command.

Prove the hook: raise the line threshold to 100, run the hook file
directly, and confirm a non-zero exit; restore the threshold and confirm
exit 0. Record both exit codes in the plan. Commit the hook alone.

**CI.** If the inventory's `ci` lists a pipeline that runs tests, change its
test step to the one coverage command. Otherwise run `bmad-testarch-ci`,
answering the platform from the inventory and the git remote (github.com →
GitHub Actions, dev.azure.com → Azure Pipelines), and make the pipeline run
that command. CI cannot be proven without a push; say so in the report.
Commit the pipeline alone.

## Keep Tests Current

Write `docs/testing.md` (or the repo's existing docs folder): the commands,
the layout rule, the thresholds and the file they live in, how a fresh clone
gets the hook, and when to run which TEA skill:

| When | Run |
| --- | --- |
| A story or feature is about to be built | `bmad-testarch-atdd` — acceptance tests first, failing |
| Code changes in a covered layer | `bmad-testarch-automate`, scoped to the changed paths |
| Before a pull request or a release | `bmad-testarch-test-review`, then `bmad-testarch-trace` |
| The CI pipeline changes | `bmad-testarch-ci` |
| The coverage gate fails | Add tests. A threshold change or a new exclusion needs a named reason in this file |

Write the AGENTS.md block between `<!-- eque2:testing -->` and
`<!-- /eque2:testing -->`, replacing it on a re-run, and create `AGENTS.md`
if it is absent. Keep it outside any `<!-- bmad:context -->` block:
`bmad-project-context` owns that block and replaces it on refresh. Follow
that skill's style: terse imperative lines, every command verified by
running it, every pointer naming a trigger an agent can observe — a path, a
file type, a named task — never one it must judge. The load-bearing lines
stay in the block (the coverage command to run before pushing, where tests
for a changed path go, the hook setup command for a fresh clone); the rest
points to `docs/testing.md`.

Claude Code reads `CLAUDE.md`, not `AGENTS.md`: when `CLAUDE.md` exists
without an `@AGENTS.md` line, add one; when it does not exist, create it
with that line alone. Commit the docs and instruction files together.

## Finish

Report: coverage per layer from start to end, overall against the
thresholds, tests added, bugs found (the expected-failure tests), code left
untested and why, the hook proof, the CI file and that it is unproven until
pushed, and the commits made. Nothing is pushed; say so. Audit the decision
log: every entry is reflected in the plan or the report, or set aside with a
reason.

Headless: emit JSON only.

```json
{
  "status": "complete",
  "workspace": "{workspace}",
  "coverage": { "lines": 91.4, "branches": 86.2, "baseline_lines": 42.0, "baseline_branches": 30.5 },
  "commits": 9
}
```

When blocked (missing TEA skills, a suite that does not build or run, a hook
that will not fail when it should), set `"status": "blocked"` and add
`"reason": "<one line>"`; the decision log holds the detail.
