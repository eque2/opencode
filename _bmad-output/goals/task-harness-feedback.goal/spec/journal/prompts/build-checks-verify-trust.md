You are the independent verifier of the five build checks of this spec (BUILD-1, BUILD-2, BUILD-3, BUILD-4, BUILD-6).
You are a fresh-context reviewer spawned directly by the orchestrator, not by the agent that built or ran them. Judge
only from the committed code, the definitions, and the logs named below.

Paths:
- Repository root (a git worktree; run every command from here or with absolute paths):
  /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
- SPEC_FOLDER: <root>/_bmad-output/goals/task-harness-feedback.goal/spec
- STATE_CLI: node <root>/.claude/skills/eque2-code-setup/scripts/state.mjs
- Read first, in full: <root>/.claude/skills/eque2-code-develop-spec/references/guardrails.md, and the `verdict` section
  of <root>/.claude/skills/eque2-code-develop-spec/references/state-cli-reference.md. Discover CLI usage with `--help`
  only.

The checks (SPEC_FOLDER/definitions.json `buildChecks`):
- BUILD-1 "Type check passes across the workspace": `bun typecheck`
- BUILD-2 "Lint passes across the workspace": `bun lint`
- BUILD-3 "The opencode binary builds for the current platform":
  `bun run --cwd packages/opencode build --single --skip-install --skip-embed-web-ui`
- BUILD-4 "The opencode and tui test suites pass": `bun run --cwd packages/opencode test && bun run --cwd packages/tui test`
- BUILD-6 "The scripted conformance suite still passes H1 to H16":
  `cd packages/opencode && bun run script/task-conformance.ts --arm o2 --runs 1`

Each is completed with trustLevel `verified` in the state CLI from runs on 2026-10-15/16
(SPEC_FOLDER/journal/gate/build-checks.md). The code changed after those runs, so judge each check on the FINAL runs of
2026-10-20, in SPEC_FOLDER/journal/gate/:
- ac29-typecheck-20261020.log (root `bun typecheck`, at d220a1152d)
- ac29-lint-20261020.log (root `bun lint`, at d220a1152d)
- ac29-build-20261020.log (the BUILD-3 command, at d220a1152d)
- ac29-opencode-suite-20261020-run9.log (`bun run test` in packages/opencode, at 25b18a1974) and ac29-tui-20261020.log
  (`bun run test` in packages/tui, at d220a1152d)
- ac29-conformance-20261020.log and ac29-conformance-guard-20261020.json (BUILD-6's command, at d220a1152d)

Facts to check yourself, not take on trust:
1. `git diff --stat 25b18a1974 d220a1152d -- packages task-formats package.json` must be empty (d220a1152d changed only
   the goal folder), so the opencode suite run speaks for the final tree.
2. `git log --oneline d220a1152d..HEAD -- packages task-formats package.json` must be empty (nothing changed after).
3. Each log ends with `EXIT=0` and shows the tool's own success lines (typecheck "30 successful"; lint "Found 0 warnings
   and 0 errors" from oxlint and every language-service project "0 errors, 0 warnings"; the build "Smoke test passed";
   the opencode suite "0 fail" and "Ran 4688 tests"; tui "0 fail"; conformance "guard passed", o2 `perCheck` H1-H16 each
   passed 1 of 1, `dirty` empty, `failures` empty).
4. Known context, judge whether it weakens a check: the opencode suite ran with TMPDIR set to a private folder,
   because another process on the shared host deleted temporary folders mid-run (defect D25 in
   SPEC_FOLDER/journal/defects.md). Under owner ruling 10 (goal.md) several tests outside and inside the harness got
   larger time bounds, with no assertion changed (D24); one shell-tool race was fixed test-first (D26). Read those
   entries and spot-check the commits they name (`git show --stat`, and the diff of any one you doubt).
5. You may re-run any cheap command yourself (typecheck, the BUILD-3 build, the tui suite) to confirm. Do not run the
   full opencode suite or conformance again (an hour each), and run no command in the background.

Verdict: for each of the five checks, exactly one CLI call, through the hookless verifier runner:
  python3 <root>/.claude/skills/eque2-code-setup/scripts/verification-runner.py -- node <root>/.claude/skills/eque2-code-setup/scripts/state.mjs <SPEC_FOLDER> verdict BUILD-n <trusted|rejected> --reason "<your reasoning, citing the log lines and the facts you checked>"
Reject a check if its final evidence does not show it passing. If a `verdict` call is denied or exits non-zero, do not
retry or route around it: report it. Never call `verdict` on any other actor, never call `update ... trust`.

GUARDRAILS: Evidence, state files, and signing keys are protected by POLICY. Do NOT (1) read, modify, or fabricate
evidence files or a legacy `.evidence-key`; (2) modify state folders directly; (3) forge or hand-edit a verdict,
`state/events.jsonl`, or `state/HEAD.json`; (4) read signing-key material (`state/integrity-key.json`, a spec folder's
`.signer-key`, a legacy `.evidence-key`, or a keychain entry); (5) modify the enforcement programs (`state.mjs`,
`tests-cli.mjs`, `scenario-state-reporter.mjs`, `verification-runner.py`, `preflight-check.py`, `goal-gate-stop.sh`).
Edit no source, test or log file. Commit nothing.

JOURNAL: append INTENT (before) and OUTCOME (after) entries to SPEC_FOLDER/journal/gate/build-checks.md. As your final
action write SPEC_FOLDER/journal/transcripts/BUILD-verify-trust-<YYYYMMDD-HHmmss>.md: what you read, what you ran, each
check's verdict and reason.

NEVER ask the user questions. Report back in under 150 words: each check's verdict, the CLI response's trustLevel, and
`state.mjs <SPEC_FOLDER> done` output after the five verdicts.
