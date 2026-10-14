# Phase R — adversarial review of the contract

- Goal: `task-harness-feedback`, branch `goal/task-harness-feedback` at `df7403cb6a`.
- Scope: `goal.md`, `ACs.md` (38 criteria), `spec/` (spec, tasks, coverage, scenarios, context, definitions).
  Reference inputs read only: `decisions.md`, `plan.md`, the spine, `EXPERIENCE.md`, `task-questions.md`.
- Method: one critical pass by hand (the `bmad-review` lens was not loaded). Each finding was checked against the
  files and the installed pipeline scripts (`eque2-code-develop-spec`, `eque2-code-goal-gate`,
  `eque2-code-setup/scripts`), read only. No state CLI or tests CLI ran. No state, evidence or key file was read.
- Approved items: AC 1–29 and D1–D27 may change only by an APPENDED criterion. A finding that needs a reword,
  a removal or a ruling on an approved item is flagged **OWNER**.

## Summary

| ID | Sev | Defect (one line) | Fix (one line) | Approved item |
|---|---|---|---|---|
| ADV-1 | critical | No sanctioned evidence path for `bun test` scenarios, so [DS] can never verify any of the 98 scenarios | Resolve before start: upstream/owner-instructed bun (JUnit) mode for the reporter, or an owner ruling on scenario evidence | OWNER (pipeline) |
| ADV-2 | high | [DS] verifies no scenario and runs no build check until all 54 tasks are trusted, so AC 2–6 cannot be pipeline-evidenced at the AC 7 checkpoint | Charter note that defines the checkpoint evidence for AC 2–6, or defer the checkpoint | charter; OWNER if deferred |
| ADV-3 | high | The goal gate ends the loop without completion after 50 iterations; a 5–7 day goal can exceed that | Owner sizes `GOAL_GATE_MAX_ITERATIONS` before start; charter names the bound | OWNER (gate config) |
| ADV-4 | high | "Commit goal-folder files with `git add -f`" can commit the private `spec/.signer-key` and merge it into `dev` | Force-add named files only; check `git ls-files` for key files before each commit and merge | none |
| ADV-5 | high | BUILD-4 and BUILD-6 break the [DS] guardrails (3-minute command cap, kill after 120 s silence) | Run them in the background with a log, poll, on a quiet machine | none |
| ADV-6 | medium | The AC 7 and AC 28 merges put 41+ `_bmad-output/` files into `dev`, against the dev convention and the last goal's precedent | Append a criterion: no `_bmad-output/` path in `dev...branch` at each merge; add merge-hygiene notes | append only |
| ADV-7 | medium | [DS] setup asks a worktree question and a parallel question that the charter does not answer; [Y] diverts all work to `feature/*` | Charter: answer [N] every time; state the parallel choice | none |
| ADV-8 | medium | [DS] spawns one verifier per ready scenario at once (98), against the charter's canary-first fan-out rule | Charter: one canary verify, then bounded batches | none |
| ADV-9 | medium | AC 6 says "every reachable state"; the spec walks only the canonical interleaving (A1.a) with no ruling | Owner ruling in the charter; AC 6 evidence cites AD-7 and RM22 | OWNER (AC 6, D5) |
| ADV-10 | medium | Default 6 is still pending and narrows AC 23 and AC 25; a headless loop cannot resolve it | Get the ruling before start; record it in "Owner answers" | OWNER (AC 23, AC 25) |
| ADV-11 | medium | AC 8, AC 14 and AC 20 name `core/runner.ts`, which T2.12 deletes before AC 14 and AC 20 are built | Charter maps each to its real file | charter; OWNER only for a reword |
| ADV-12 | medium | The builder edits the H1–H16 suite (T1.14, T2.14) and no criterion bounds the edits | Append a criterion: every changed H-check expectation listed and justified; none removed or skipped | append only |
| ADV-13 | medium | AC 29 says bare `bun test` (5 s default timeout); BUILD-4 uses `bun run test`; no policy for known dev flakes | Charter: the AC 29 command is `bun run test`; A/B re-run policy for dev-side flakes | none |
| ADV-14 | medium | Verify subagents never commit the 98 `verify-spec-*.spec.ts` files, so AC 28 merges a tree without its acceptance tests | Charter: commit verified test files before AC 29 and AC 28 | none |
| ADV-15 | medium | The AC 27 recipe is unsafe or unmeasurable as written (cwd, `exec bun dev`, resume in a reused folder, bold not in plain capture, cost summed per root session, no meter) | Charter: one fresh folder and tmux session per run, `capture-pane -e`, independent spend meter | none |
| ADV-16 | low | AC 31 "a stop outranks a task that died first" changes AC 4's end-state rule; the charter does not record it like ruling 1 | Record in "Owner answers"; AC 4 evidence cites AC 31 | OWNER (AC 4, D3) |
| ADV-17 | low | AC 11 accepts any allowlist with reasons; only SV19 (not a criterion) pins it to AD-17 | Append: the final allowlist holds only the AD-17 entries | append only |
| ADV-18 | low | AC 35 byte equality is true by construction after `UPDATE_FIXTURE=1` | Evidence shows the fixture unchanged by the verifying run, and its key fields | none |
| ADV-19 | low | AC 10 says each obligation carries a blocked cause; SV15 says it carries none | AC 10 evidence cites spec defect 9 | none |
| ADV-20 | low | The evidence validator refuses backticked spans with `mock`, `fake`, `toy` (in `destroy`) and similar; the charter warns only about `example` | Charter lists the evidence-side tokens | none |
| ADV-21 | low | The [DS] completion text sends the agent to [ET]/[PR]; a PR pushes, which D26 forbids | Charter: after [DS] is done, go to AC 27; no [ET], no [PR] | none |

## Findings

### ADV-1 — critical — no evidence path for `bun test` scenarios

- **Where:** `goal.md` lines 199–202 (Notes, "Scenario evidence under `bun test`"); `spec/spec.md` "Risks for
  [DS]"; `spec/definitions.json` (all 98 `testFile` values are `packages/opencode/test/task/verify-spec-*.spec.ts`,
  `workingDirectory: ""`); `.claude/skills/eque2-code-develop-spec/verify-scenario/SKILL.md` step 3;
  `.claude/skills/eque2-code-setup/scripts/scenario-state-reporter.mjs` lines 754, 759, 783.
- **Defect:** The reporter implements only the Vitest hooks (`onFinished`, `onTestRunEnd`) and the Playwright hook
  (`onEnd`), and the state CLI's `verify` passes a scenario only on reporter-signed evidence. Every scenario here is
  a `bun test` file, so no scenario can reach `completed`, `done` can never be true, and the charter's own STOP rule
  fires with certainty. The empty `workingDirectory` also points at the repository root, where `bunfig.toml`
  (`[test] root = "./do-not-run-tests-from-root"`) blocks a test run.
- **Fix:** Resolve before the loop starts, not "before the first scenario verify". Options: (a) the owner instructs,
  or an upstream eque2-code release ships, a `bun test` mode for the reporter (the policy allows a reporter change
  only that way); (b) the owner rules on an alternative scenario evidence path and the charter records it. In both
  cases set each scenario's working directory to `packages/opencode`.
- **Approved item:** none reworded. **OWNER** — an enforcement-program change needs the owner's instruction or an
  upstream release.

### ADV-2 — high — no scenario or build check is verified before the AC 7 checkpoint

- **Where:** `.claude/skills/eque2-code-setup/scripts/state.mjs` lines 36745 and 36772 (`computeRecommendations`);
  `goal.md` lines 179–182 and 195–196; `goal.md` lines 44–45 (no self-certification); `ACs.md` line 32 (AC 7).
- **Defect:** `next` recommends a build check only when every task is done and trusted, and a scenario verify only
  when, in addition, every build check is done. So at the checkpoint (after T1.14, with T2.1–T4.14 not started) no RM
  scenario and no BUILD check has run through the state machine. AC 7 needs "AC 2–6 pass" first, but the charter
  forbids ticking a criterion "with tests the state machine never independently verified". The loop must stall at
  the checkpoint or self-certify. It also means ADV-1 surfaces only after all four phases are built and phase 1 is
  already on `dev`.
- **Fix:** Add a charter note that defines the checkpoint evidence for AC 2–6: the trusted T1.x task actors
  (`state.mjs query` output), the named task test files run with the logged command, and the goal loop's own
  BUILD-1..4 and BUILD-6 runs. State that the RM scenarios are verified at the end and that the AC 2–6 evidence is
  then extended with the scenario verdicts. If the owner prefers pipeline-verified scenarios before `dev` moves, the
  checkpoint must wait until the end, which removes the purpose of D26's first merge.
- **Approved item:** AC 7 and D26 unchanged with the charter note. **OWNER** only if the checkpoint moves.

### ADV-3 — high — the goal gate's recursion bound ends a long loop

- **Where:** `.claude/skills/eque2-code-goal-gate/goal-gate-stop.sh` line 319 (`GOAL_GATE_MAX_ITERATIONS`,
  default 50) and line 3354; `plan.md` "Total: about 5–7 days of agent time"; `goal.md` lines 197–198 (names only
  the [DS] cap of 100).
- **Defect:** The gate counts every evaluation and never resets the count. Once the count passes 50 on a turn that
  a block continued, it records `recursion_bound_exceeded` and ends the loop "WITHOUT COMPLETION". The last goal in
  this repository used 16 gate iterations for 28 criteria in about 12 hours (its `run-log.jsonl`); this goal has 38
  criteria, several [DS] re-invocations, a checkpoint and a paid check across several days.
- **Fix:** The owner sets `GOAL_GATE_MAX_ITERATIONS` in the session environment to a value sized for the goal
  before the start (it is a documented override, so the builder must not set it), and the charter names the bound
  and what to do when it trips (a fresh `pursue-goal` on the same folder).
- **Approved item:** none. **OWNER** (gate configuration).

### ADV-4 — high — `git add -f` can commit the private signer key

- **Where:** `goal.md` line 206; `state.mjs` line 32640 (`{specFolder}/.signer-key`) and line 35467 (it only
  gitignores the key in `spec/.gitignore`).
- **Defect:** The verdict path writes a private Ed25519 key to `_bmad-output/goals/task-harness-feedback.goal/spec/
  .signer-key`. `git add -f` ignores `.gitignore`, so a directory pathspec (`git add -f <goal folder>` or
  `.../spec`) stages the key, and the AC 7 or AC 28 merge puts it on `dev`. Evidence files and `state/` would follow
  the same way.
- **Fix:** Charter note: force-add only named files (`goal.md`, `ACs.md`, `STATE.md`, `JOURNAL.md`,
  `journal/*.md`, `reviews/*.md`, `spec/*.md`, `spec/definitions.json`), never a directory. Before every commit and
  every merge, `git ls-files | grep -E '(^|/)\.(signer-key|evidence-key)|verifier-marker'` must print nothing.
- **Approved item:** none.

### ADV-5 — high — the gate commands break the [DS] guardrails

- **Where:** `.claude/skills/eque2-code-develop-spec/references/guardrails.md` lines 39–40; `spec/definitions.json`
  `buildChecks` BUILD-4 and BUILD-6; `packages/opencode/package.json` line 10 and `packages/tui/package.json`
  line 9 (`--only-failures`); `packages/opencode/script/task-conformance.ts` line 57 (`CHILD_BOUND_MS`, 4 h).
- **Defect:** The guardrails cap each command at 3 minutes and say to kill a command that is silent for 120 s.
  `--only-failures` hides every passing test, so the opencode suite (about 3,900 tests in 275 files, per the last
  goal's evidence) is silent for minutes. The conformance guard runs two arms and took tens of minutes per attempt in
  the last goal; three of its six attempts failed on timing under load. A guardrail-abiding check subagent kills
  both commands and reports them failed.
- **Fix:** Charter note: run BUILD-4, BUILD-6 and the AC 29 gate in the background with output to a log file, poll
  per `circuit-breaker.md`, and run them only when no builder or verifier subagent is active.
- **Approved item:** none.

### ADV-6 — medium — the merges carry `_bmad-output/` into `dev`

- **Where:** `ACs.md` lines 32 and 86 (AC 7, AC 28); `goal.md` lines 181 and 206; `.gitignore` line 39; precedent
  commit `a1feaa7a84` ("untrack the promotion record before the merge").
- **Defect:** `dev` tracks no path under `_bmad-output/`. This branch tracks 41 goal-folder files today, including
  `CLAUDE.md` and `AGENTS.md` with the "START NOW" banner, and will track more. The last goal untracked its folder
  before its merge and had a criterion that `git diff --name-only dev...branch` lists no `_bmad-output/` path; this
  goal has neither. The charter also does not say what to do when the main checkout is dirty or `dev` moved since
  the branch point; under YOLO an agent may stash or commit the owner's work there.
- **Fix:** Append a criterion: "before the AC 7 merge and before the AC 28 merge, `git diff --name-only
  dev...goal/task-harness-feedback` lists no path under `_bmad-output/`" (untrack with `git rm -r --cached`, as in
  `a1feaa7a84`). Charter notes: merge `dev` into the branch first and re-run the gate when `dev` moved; when the main
  checkout is not on `dev` or not clean, stop and report — never stash, commit or switch branches there.
- **Approved item:** AC 7 and AC 28 unchanged; a criterion is appended.

### ADV-7 — medium — [DS] setup prompts are not answered

- **Where:** `.claude/skills/eque2-code-develop-spec/references/setup.md` §5 (line 78) and §6; `goal.md` lines
  19–26 and 197–198.
- **Defect:** Setup asks "Create an isolated git worktree at `.claude/worktrees/{SPEC_SLUG}`?" and "Run independent
  tasks in parallel?". The charter does not answer either. [Y] creates a nested worktree on `feature/{SPEC_SLUG}`
  inside this worktree, so all work lands on a branch that AC 7 and AC 28 never merge. Every re-invocation (the cap,
  the checkpoint) asks again.
- **Fix:** Charter note: answer [N] to the worktree question every time (the session is already in the goal
  worktree); state the parallel choice explicitly (recommend no `--parallel`: the tasks form a dependency chain, and
  load breaks the timing-bound tests).
- **Approved item:** none.

### ADV-8 — medium — the verify fan-out ignores the canary rule

- **Where:** `.claude/skills/eque2-code-develop-spec/references/execute.md` line 66 (step 2d); `goal.md` lines
  81–92.
- **Defect:** When more than one scenario is ready, [DS] spawns one verifier per ready scenario in parallel. All 98
  become ready at the same moment (ADV-2), so the first verify is a 98-way fan-out of `bun test` runs (60 s graph
  walks, nested delegated TUI runs of at least 120 s, scripted `/task` runs). The charter requires one canary first.
  The last goal's subagents also stopped on the usage limit.
- **Fix:** Charter note: verify one scenario first as the canary, then verify in batches of at most a small fixed
  number (for example 4), with no builder running.
- **Approved item:** none.

### ADV-9 — medium — AC 6 is narrowed to the canonical walk

- **Where:** `ACs.md` line 30 (AC 6, "walks every reachable state"); `spec/coverage.md` Assumption A1.a;
  `spec/scenarios.gherkin` RM19 ("every state reachable with the canonical interleaving") and RM22; spine AD-7
  ("[ASSUMPTION] D5's 'every reachable state' means … the canonical interleaving"). `spec/spec.md` "Defects found in
  the inputs" and the charter's "Owner answers" do not list it.
- **Defect:** The full interleaving did not finish in 25 minutes, so the graph proof walks a reduced state space.
  That is defensible (AD-7 gives a soundness argument and RM22 checks it on a small plan), but AC 6's text says
  "every reachable state". A verifier that reads AC 6 literally can refuse it, and AC 7 waits on AC 6.
- **Fix:** Record an owner ruling in the charter, as for rulings 1 and 2: AC 6 is met by the canonical walk plus
  the RM22 reduction check; the AC 6 evidence cites AD-7 and RM22.
- **Approved item:** AC 6 and D5 narrowed. **OWNER**.

### ADV-10 — medium — pending default 6 narrows AC 23 and AC 25

- **Where:** `goal.md` lines 149–150 and 213–215; `spec/spec.md` "Prepare-goal defaults" (default 6) and defect 3;
  `spec/scenarios.gherkin` UI12 (`@ASSUMPTION:A2.a`); `ACs.md` lines 73 and 77.
- **Defect:** AC 23 says a duration "shows live while the task runs"; default 6 freezes it when `run.aliveAt` is
  older than 15 s. AC 25 names two static cases; default 6 adds a third. The ruling is pending and the loop is
  headless, so the builder builds to an assumption that a verifier can judge against the literal ACs.
- **Fix:** Get the owner's ruling before the start and record it under "Owner answers". Until then the AC 23 and
  AC 25 evidence cites default 6 as a narrowing.
- **Approved item:** AC 23, AC 25, D21, D23 narrowed. **OWNER**.

### ADV-11 — medium — three criteria name a file that T2.12 deletes

- **Where:** `ACs.md` lines 37, 52 and 67 (AC 8, AC 14, AC 20 name `packages/opencode/src/task/core/runner.ts`);
  `spec/tasks.md` T2.12 (`core/runner.ts (DELETE)`), T3.3 (`core/supervise/run.ts`), T4.11; spine "Capability →
  Architecture Map" (D12 in `core/supervise/run.ts`, D18 in `core/supervise/run.ts` and `ops.ts`).
- **Defect:** AC 14 (phase 3) and AC 20 (phase 4) are built after phase 2 deletes `runner.ts`, so their specified
  system does not exist when they are evidenced. A verifier that checks the named path finds nothing.
- **Fix:** Charter note mapping each criterion to its real file: AC 8 → the deletion of `core/runner.ts` plus
  `core/supervise/run.ts`; AC 14 → `core/supervise/run.ts` (the stale check); AC 20 → `core/supervise/run.ts` and
  `core/ops.ts`.
- **Approved item:** unchanged with the charter note. **OWNER** only if the owner wants the paths reworded.

### ADV-12 — medium — the regression suite is edited with no bound

- **Where:** `spec/tasks.md` T1.14 and T2.14 (`conformance.test.ts` and `arms/status.ts` UPDATE; H3, H4, H7, H16
  re-baselined; `arms/status.ts` accepts new states); `ACs.md` line 88 (AC 29, "still passes H1–H16");
  `packages/opencode/script/task-conformance.ts` header.
- **Defect:** The builder changes the expectations of the suite that guards "supervision behaves as today". No
  criterion requires each change to be listed and justified, or forbids removing or skipping a check. The guard's
  other test (o2 at least 50 points above the pre-harness baseline) still passes with a loosened suite.
- **Fix:** Append a criterion: "`conformance.test.ts` and `arms/status.ts` carry a header list of every changed
  H-check expectation, each tied to D2, D3, AD-4 or AD-13, and `git diff 2c0214ab71 -- <both files>` removes no
  check and adds no skip" (the same device as owner ruling 2 for the engine tests).
- **Approved item:** AC 29 unchanged; a criterion is appended.

### ADV-13 — medium — the AC 29 test command is ambiguous, with no flake policy

- **Where:** `ACs.md` line 88 ("bun test exits 0 in packages/opencode and in packages/tui");
  `spec/definitions.json` BUILD-4 (`bun run --cwd packages/opencode test && bun run --cwd packages/tui test`);
  `packages/opencode/bunfig.toml` line 5 (the timeout is not read from bunfig); the last goal's AC 6 evidence
  (`acp lifecycle subprocess > stdin EOF exits cleanly` failed 2 of 3 runs on dev's own code under load).
- **Defect:** Bare `bun test` uses the 5 s default timeout, so a literal run can fail tests that `bun run test`
  (`--timeout 30000`) passes. The charter's "Done when" also tells the loop to fix pre-existing defects, which pulls
  unrelated subprocess-timing tests into scope, and gives no re-run rule for a flake that also fails on `dev`.
- **Fix:** Charter note: the AC 29 test command is `bun run test` in each package. A test that also fails on an
  export of `dev` is recorded with an A/B log and re-run, not edited or skipped.
- **Approved item:** AC 29 unchanged (a reading, not a reword).

### ADV-14 — medium — the acceptance tests are never committed

- **Where:** `.claude/skills/eque2-code-develop-spec/verify-scenario/SKILL.md` line 21 ("Do NOT commit the test
  file"); `spec/spec.md` "Verification Intent" ("Every scenario test is `verify-spec-<ID>.spec.ts`"); `ACs.md`
  lines 86 and 88.
- **Defect:** The 98 verify files stay untracked. The AC 29 gate on the worktree runs them, but the AC 28 merge
  leaves them off `dev`, so the merged tree differs from the tested tree and the acceptance proofs die with the
  worktree.
- **Fix:** Charter note: after [DS] reports done, commit the verified `verify-spec-*.spec.ts` files (their content
  does not change, so the source hashes still match), then run AC 29 and AC 28.
- **Approved item:** none.

### ADV-15 — medium — the AC 27 recipe is unsafe or unmeasurable as written

- **Where:** `goal.md` line 185; `packages/opencode/script/task-demo.sh` (seeds `$(pwd)`, refuses a non-empty
  folder that is not a demo, ends with `exec bun dev "$target"`, and its header warns that an unfinished run resumes
  in a reused folder); `ACs.md` line 84 (AC 27); `spec/spec.md` "Risks for [DS]" (two runs from one root session sum
  their costs).
- **Defect:** Run as written from the worktree root, the script refuses; run in a new folder outside tmux, it starts
  an interactive TUI that hangs the shell. A re-run in the same folder can resume the earlier run. "Bold spec title"
  is not visible in a plain `tmux capture-pane`. Two runs from one root session report a summed "run total". The
  $5 cap has no meter other than the D24 display that the check tests.
- **Fix:** Charter note: for each live run, create a new empty folder and run `tmux new-session -d -s <name> -c
  <folder> "bash <worktree>/packages/opencode/script/task-demo.sh"`; one run per folder and per root session; capture
  with `tmux capture-pane -e -p` (keeps the bold escape); before each further run, total the spend from the session
  store or the provider console, and confirm on the first run that the configured model reports a non-zero cost.
- **Approved item:** none.

### ADV-16 — low — AC 31 changes AC 4's end-state rule without a recorded answer

- **Where:** `ACs.md` lines 26 (AC 4, "otherwise the state of the task that died first") and 95 (AC 31, "a stop
  outranks a task that died first"); `spec/scenarios.gherkin` RM27; `goal.md` lines 149–150.
- **Defect:** RM27 ends a cancelled run `cancelled` even when a task died first, which AC 4's text does not allow.
  The charter records owner ruling 1 as overriding AC 4, but records default 4 only as "a cancel finishes waiting
  units", not as an AC 4 override.
- **Fix:** Record it under "Owner answers" (or as default 4's stated scope): AC 4's end-state rule applies to a run
  that settles without a stop; the AC 4 evidence cites AC 31.
- **Approved item:** AC 4 and D3 narrowed. **OWNER** (it is a default the owner may overrule).

### ADV-17 — low — AC 11 does not pin the allowlist

- **Where:** `ACs.md` line 43 (AC 11, "except allowlist entries that each carry a written reason");
  `spec/scenarios.gherkin` SV19; `spec/context.md` SD-8; spine AD-17.
- **Defect:** AC 11 passes with any allowlist whose entries have reasons. Only SV19, which [DS] cannot verify while
  ADV-1 stands, pins the list to AD-17.
- **Fix:** Append a criterion: "on the final branch the state-audit allowlist holds only the AD-17 entries".
- **Approved item:** AC 11 unchanged; a criterion is appended.

### ADV-18 — low — AC 35 is true by construction after a fixture rewrite

- **Where:** `ACs.md` line 103 (AC 35); `spec/context.md` SD-10 and `spec/tasks.md` T2.3 (`UPDATE_FIXTURE=1`
  rewrites the fixture).
- **Defect:** A builder who regenerates `fixture-projected.json` from the code under test makes the byte-equality
  check pass whatever the projection emits.
- **Fix:** AC 35 evidence shows `git diff --exit-code packages/tui/test/task-ui/fixture-projected.json` after the
  verifying run and quotes the fixture's T1.5 and T1 `blockedBy` values.
- **Approved item:** none.

### ADV-19 — low — AC 10 and SV15 disagree on obligations

- **Where:** `ACs.md` line 41 (AC 10, "each task, obligation and scenario carries … its blocked cause");
  `spec/scenarios.gherkin` SV15 lines 393 and 397; `spec/spec.md` defect 9.
- **Defect:** SV15 says an obligation carries no blocked cause, which a literal reading of AC 10 refuses.
- **Fix:** The AC 10 evidence cites spec defect 9 (an obligation never blocks, so its cause is none).
- **Approved item:** AC 10 unchanged (a reading).

### ADV-20 — low — evidence-side surrogate tokens are not documented

- **Where:** `.claude/skills/eque2-code-goal-gate/validate-acs.sh` line 189; `goal.md` lines 209–210.
- **Defect:** The gate refuses a tick whose evidence has a backticked span containing `mock`, `stub`, `fake`,
  `dummy`, `surrogate`, `stand-in`, `placeholder`, `simulated` or `toy` (substring, so `destroy` and the fake
  `Ops` in `core-command.test.ts` match). The charter warns only about `example` in criteria. Each refusal costs a
  turn.
- **Fix:** Charter note listing the evidence-side tokens.
- **Approved item:** none.

### ADV-21 — low — [DS] completion points at [ET] and [PR]

- **Where:** `.claude/skills/eque2-code-develop-spec/references/complete.md` lines 26–28; `ACs.md` line 121
  ("Neither pushes"); `goal.md` YOLO "widest scope".
- **Defect:** The completion text says the next steps are [ET] and [PR]; a PR pushes the branch, which D26 forbids.
  A widest-scope reading can follow it.
- **Fix:** Charter note: after [DS] reports done, go to AC 27; do not run [ET] or [PR].
- **Approved item:** none.

## Checked and not reported

- AC 30 (acceptance) against AC 4: resolved by owner ruling 1 in the charter.
- AC 33 against AC 12: resolved by owner ruling 3 in the charter.
- AC 36 against AC 27 and AC 17: consistent (parent T1 per spec defect 7).
- AC 6 against the phase-1 build of the live-check folders: resolved by T1.15.
- Every scenario has a supporting task, and every scenario appears in the AC traceability table.
- Every AC system path either exists or is created by a named task, except ADV-11.
- AC 29's root scripts exist (`lint`, `typecheck`); the root `test` script refuses on purpose.
- `pursue-goal` does not re-check the stage-1 approval hashes, so the appended AC 30–38 do not stop the start.
