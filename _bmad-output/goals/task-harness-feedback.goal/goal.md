> **START NOW — do not wait to be asked.** This is a prepared goal folder.
> Invoke `eque2-code-pursue-goal` on the directory containing this file,
> as the first thing you do. Being pointed at this charter IS the request
> to execute it; there is nothing else one does with a `.goal` folder.
> Do not summarise this charter back, do not ask whether to proceed, and
> do not begin the work with no gate bound. If the starter refuses,
> report the refusal and stop.

> **GOAL-READY 2026-10-14** — task-harness-feedback, heavy lane, spec-backed,
> adversarially reviewed; SPEC produced this run. Drive with your agent's
> completion loop (`pursue-goal`, which binds the stop gate). See SPEC + journal
> below for full contract.

> **Build via eque2-code (evidence-gated).** The SPEC for this contract
> was produced during goal-prep and is linked in the frontmatter block
> below — you do NOT need to create it. To IMPLEMENT it, run `[DS]`
> develop-spec — the autonomous build-verify loop gated by the state CLI's
> `verify` verb:
> `/eque2-code-develop-spec _bmad-output/goals/task-harness-feedback.goal/spec`
> (the spec lives in this goal folder, so pass the path, not a slug;
> develop-spec accepts a full path). One spec, four phases → one `[DS]`,
> paused once for the phase-1 checkpoint merge (see Ready-to-execute
> commands). Full verification is the DEFAULT — do NOT pass suppression
> flags (`--no-party` etc.). If requirements have SHIFTED since goal-prep,
> re-spec first with `[CS]` (`--headless:create-spec-from-prose <this-file>`),
> then `[DS]`.
>
> _Agent note — Claude Code: run the `[DS]`/`[CS]` skills above. Other
> agents (e.g. Codex): drive the state + tests CLI build-verify loop
> directly (`state.mjs`, `tests-cli.mjs`) per
> `references/agent-mapping.md`, or an installed create-spec/develop-spec
> prompt. The gate is enforced by the scripts, so the safety is the same._
>
> **⛔ BYPASSING THIS PIPELINE IS ABSOLUTELY FORBIDDEN.** Because
> eque2-code is the resolved mechanism, every artefact of this contract
> MUST be produced through the state machine and the tests CLI's
> verification lifecycle
> (`building → awaiting_verification → verified_passing`). It is FORBIDDEN
> to:
> - hand-write the implementation or the tests instead of running the
>   gated build-verify loop;
> - skip, stub, fake, or route around the state CLI's `init` / `update` /
>   `verify` / `done` verbs or the tests CLI's gating;
> - self-certify a "Done when" checkbox with tests the state machine never
>   independently verified;
> - substitute weaker tests (isolated component renders, seeded query
>   caches, mocked APIs, reduced-region assertions) for the pipeline's
>   gated verification;
> - optimise for the Stop-hook checklist while skipping the process that
>   earns it. The checklist grades *outputs*; the pipeline is what makes
>   those outputs real. Bypassing it produces green gates over broken
>   software — the exact failure this mechanism exists to prevent.
>
> If the pipeline genuinely cannot run (agents not installed, a tool
> errors, an external precondition missing), you STOP and REPORT it as a
> blocker. You do NOT silently substitute your own approach. Deviating
> from this mechanism without surfacing it FIRST and getting the owner's
> go-ahead is itself a violation, regardless of how the result looks.
>
> **⚠️ ENFORCEMENT — this is not a guideline.** Any agent caught bypassing
> the eque2-code pipeline — building around the state machine, faking or
> skipping verification, or self-certifying unverified work as "done" —
> WILL BE SWITCHED OFF. Non-compliance ends the agent. Follow the pipeline
> or escalate the blocker; there is no third option.

> **Run autonomously (YOLO).** When this charter is executed, run it
> end-to-end **without stopping to ask permission**. Resolve issues
> automatically — investigate-and-fix a failing test, a missing file, an
> unfamiliar flag, a crashed tool; do NOT escalate them. Default
> decisions, never questions:
> - **A fidelity question → choose the HIGHEST fidelity** (the real `/task`
>   command driven through `SessionPrompt.command` in a temporary git
>   repository with the scripted model, the real SQLite fact store, the real
>   `bun test` JUnit reports, the real opentui test renderer, and the real TUI
>   in `tmux` for the live check; never a mocked runner, store, machine or
>   proof as the verdict).
> - **A scope question → choose the WIDEST scope** consistent with the
>   stated intent (do the complete job, not a slice).
> - Do NOT ask *how* to build (the Build-via directive is the answer) or
>   *whether* to spend on the sanctioned compute (yes).
> **Validate before you fan out — MANDATORY, no exceptions.** Autonomy and
> widest-scope do NOT mean launching N parallel/expensive workers on
> unproven code. Before any fan-out (multiple VMs/jobs, a large batch, a
> costly parallel sweep) you MUST, in this order: (1) test the code
> thoroughly (the suite is green); (2) run ONE small real subset
> end-to-end in the LIVE environment — a single VM / a handful of items /
> one shard — and confirm it actually succeeded (correct output, no
> errors, expected cost); only THEN scale to the full fan-out. One canary
> that passes earns the fleet; an unvalidated fleet is forbidden even
> under YOLO. The widest-scope default applies to the *eventual* run,
> never to the first launch. (A single bug fanned across 25 VMs cost $700
> — this gate exists to prevent exactly that.)
> Stop ONLY for a genuine blocker: an interactive credential/auth the
> owner alone can clear, an external precondition outside your control
> (quota exhausted, required data absent), or an ambiguity that would
> change the *verdict* and has no defensible highest-fidelity/widest-scope
> default. Report cost/outcome **after** the fact, not as a gate before
> it. Never fabricate a verdict — it must come from the real run; an
> honest negative is a valid outcome to surface, not a stall.

# Goal — `/task` harness feedback: one run machine, actors, validation, task UI

## Links

- SPEC: [`./spec/spec.md`](./spec/spec.md) — with
  [`context.md`](./spec/context.md), [`coverage.md`](./spec/coverage.md),
  [`scenarios.gherkin`](./spec/scenarios.gherkin),
  [`tasks.md`](./spec/tasks.md), [`definitions.json`](./spec/definitions.json).
  Provenance: [`./MANIFEST.md`](./MANIFEST.md).
- Architecture spine: [`./architecture/ARCHITECTURE-SPINE.md`](./architecture/ARCHITECTURE-SPINE.md) (AD-1..AD-20)
- UX: [`./ux/EXPERIENCE.md`](./ux/EXPERIENCE.md)
- Approved decisions: [`./decisions.md`](./decisions.md) (D1–D27)
- Acceptance contract: [`./ACs.md`](./ACs.md) (46 criteria: 29 approved, AC 30–46 appended in stage 2)
- Plan: [`./plan.md`](./plan.md) · Input: [`./task-questions.md`](./task-questions.md) (13 questions)
- Journal: [`./JOURNAL.md`](./JOURNAL.md) · State: [`./STATE.md`](./STATE.md)
- Contract review: [`./reviews/`](./reviews/)

## Intent (the input, preserved)

The owner ran `/task` on `release-notes.spec`. T1.4 exhausted its budget, and T1.5 and the parent T1
stayed in WAITING for ever with no reason. Four per-unit xstate machines joined by fold code, readiness
in the runner's `schedule`, and a polled "run done" check made that stuck state possible (question 13).

The owner's requirement: xstate holds every state, transition and state-reading decision of the
harness — no `MutableHashMap`, `Ref`, `let` counter, polled check or string list that encodes a
lifecycle. The durable run lifecycle stays a pure fold of stored facts; live supervision becomes xstate
actors whose outcomes are recorded as facts. Questions 1–12 ask what the harness checks before a run
and what the TUI shows: every validation failure, the spec title, reasons and blocked causes,
scenarios, per-task durations, the animated diamond, run cost, and a closing summary.

## Resolved decisions and owner answers

All 27 decisions are in [`./decisions.md`](./decisions.md) and bind this charter and the SPEC. They are
linked, not restated. Phases: D1–D5 one run machine; D6–D9 actors and the audit; D10–D15 validation and
the fault folders; D16–D24 the task UI; D25 the live check; D26 the merges; D27 the paused
`task-harness` goal stays separate.

Owner answers in stage 2 (2026-10-14; `journal/2026-10-14-04-architecture.md`,
`journal/2026-10-14-08-review.md`, spec "Owner rulings"):

1. **D3 acceptance → "failed".** All tasks trusted but a runnable scenario failed or rejected → the run
   ends `failed`, `acceptance not proved: <id> <state>`. This overrides the literal AC 4 text "done when
   every task is trusted"; AC 30 records the rule. The AC 4 evidence cites the ruling.
2. **AC 2 tests → "Rewrite, keep intent".** The old engine tests become fact sequences. The header of
   `engine-xstate.test.ts` classes each as ported, re-baselined or retired; the AC 2 evidence cites it.
3. **One live run per directory → "Accept"** (AD-19, AD-6). AC 33 records it. A refusal while another
   run is live answers in the session only and does not write that run's `status.json`; the AC 12
   evidence cites this ruling for that one case.
4. **AC 6 → "structurally impossible to become stuck … a linting or pre-processing should yield errors
   … fixed order + check".** The graph walk in one fixed event order with the small-plan reduction check
   (AD-7, RM22) is the accepted reading of "every reachable state". AC 39 adds the generator's totality
   check, which refuses a config with a gap before any run starts.
5. **A stopped server → "Show it as still"** (was default 6). AC 40 records it; it narrows AC 23 and
   AC 25 for a server that has stopped.
6. **Bun scenario evidence → "Use the adapter".** See "Verification" below.
7. **RM22 "same set of stuck states" → same stuck unit configurations (owner, 2026-10-17).** The negative-control canonical walk has 27 raw stuck keys and the full walk has 39 because the `dead:` key field records the state of the first task-death entry. For the RM22 reduction check, compare the sets after removing that field; keep the raw canonical-subset check and the guard-read key check. This clarifies the accepted fixed-order reduction in ruling 4. It does not waive the full stale walk or its seven-test verification.
8. **RM19 walk bound → 180 seconds (owner, 2026-10-18: "Increase the timeout").** The shared host's load made the release-notes walk take 68.8 s against the 60 s bound in a full `packages/opencode` run; the same walk takes about 28 s alone. RM19's "within 60 seconds" reads as "within 180 seconds", and the test's own timeout rises above that bound. The walk's edge `limit` (the deterministic hang guard of AD-7) does not change. RM20 keeps its 60 s bound.
9. **Push the goal branch (owner, 2026-10-19: "Commit everything. Create a handover document and put it in the repo to complete this. Then push").** The branch `goal/task-harness-feedback` is pushed to `origin` (github.com/eque2/opencode). This overrides D26's "no push" for the goal branch only. `dev` is not pushed: the AC 28 merge into `dev` still pushes nothing unless the owner says so.

Prepare-goal defaults (the owner may overrule): default 4 (a stop finishes the waiting tasks and
scenarios, AC 31) and default 5 (the D1 and D6 shapes). Where the spine's stop-first outcome rule
disagreed with approved AC 4, AC 4 wins: a task that died before a stop gives the end state (AC 31).

## Work list (from the SPEC)

Four phases, 54 tasks, 108 scenarios and 5 build checks — full detail in [`./spec/tasks.md`](./spec/tasks.md):

- **P1 — one run machine (T1.1–T1.15).** The two live-check folders first (T1.15, so AC 6 walks them
  before the AC 7 checkpoint), port conformance probes, the generated machine, readiness and
  cascade rows, the outcome region, history and spans, the snapshot engine API, the rewritten engine
  tests, the graph proof, the phase-1 runner and status seam, H1–H16 at the checkpoint.
- **P2 — live supervision as actors (T2.1–T2.14).** The D9 audit first, new fact members, the AD-13
  status contract, the Recorder, the `TaskHarness` service with leases, hooks routing, workers and
  supervisors beside the old runner, one cut-over (T2.11), then the old code deleted (T2.12).
- **P3 — validation and fault folders (T3.1–T3.11).** `ensures` required, every failure listed, the
  `spec.checked` warning, external regions and the subtree refusal, six fault folders and their command
  test, scripted live-check runs, `task-demo.sh`, the README "Validation" section.
- **P4 — task UI (T4.1–T4.14).** The `taskView` machine, tag classification, the shared region in every
  expanded view, reasons, scenarios, durations, the hint removed, the animated diamond, the run header,
  the closing summary, run cost, the final audit and quality gate.

Scenario tests: `packages/opencode/test/task/verify-spec-<ID>.spec.ts`, each title starting with its
scenario id; TUI tests under `packages/tui/test/task-ui/`.

## Ready-to-execute commands

```
# 1. Phases 1–4, paused once after phase 1
/eque2-code-develop-spec _bmad-output/goals/task-harness-feedback.goal/spec

# 2. Checkpoint (AC 7, AC 46) — when state.mjs next first recommends a T2.x action:
#    a. AC 2–6 evidenced and the quality gate (AC 29) green on the branch (see "The checkpoint" below).
#    b. Merge dev into the branch first; resolve conflicts on the branch.
#    c. Untrack the goal folder (files stay on disk), commit, then merge from the main checkout:
git rm -r -q --cached _bmad-output/goals/task-harness-feedback.goal && git commit -m "chore(goal): untrack the goal record before the checkpoint merge"
git -C /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode merge --no-ff goal/task-harness-feedback
#    d. Re-add the folder without key files, commit, then re-invoke step 1:
git add -f -- _bmad-output/goals/task-harness-feedback.goal && git rm -q --cached --ignore-unmatch -- ':(glob)**/.signer-key' ':(glob)**/.evidence-key'
#    (an exclude pathspec with add -f silently adds nothing — tested 2026-10-14; unstage the keys instead)

# 3. After every scripted criterion and the quality gate pass: the live check (AC 27), in tmux
mkdir <new empty folder> && cd <it> && bash <worktree>/packages/opencode/script/task-demo.sh

# 4. After every other criterion passes: the final merge (AC 28, AC 46) — repeat 2b and 2c. No push.
```

_Agent note — other agents: drive `state.mjs` / `tests-cli.mjs` directly against
`_bmad-output/goals/task-harness-feedback.goal/spec`._

## Notes for the builder

### Before you start

- **The gate's turn bound.** `goal-gate-stop.sh` ends the loop WITHOUT completion after
  `GOAL_GATE_MAX_ITERATIONS` blocked stops (default 50). This goal runs for days, so the owner raised it
  to 500 on 2026-10-14 in this worktree's `.claude/settings.local.json` (gitignored). It loads only in a
  session started with the worktree as its working directory. If the bound trips, open a fresh context on
  this folder; `[DS]` resumes from the state CLI.
- **`[DS]` setup.** Answer **N** to its worktree question: this is already the goal's worktree, and a
  nested `feature/*` branch never reaches `dev`. Run without `--parallel` until one scenario has verified
  through the adapter; after that `--parallel` is allowed, with at most 5 verifiers at a time.
- **Iteration cap.** 54 tasks plus 108 scenarios exceed the default `[DS]` cap of 100 iterations.
  Re-invoke `[DS]` when it stops on the cap.
- **No `[ET]`, no `[PR]`.** `[DS]`'s completion text suggests them; the plan declined both, and a PR
  pushes, which D26 forbids. When `[DS]` is done, go to the live check (step 3).

### Verification (owner ruling 6)

- Every scenario test is a `bun test` file in `packages/opencode/test/task/`; its `workingDirectory` is
  `packages/opencode`. After any `[CS]` regeneration, run `python3 spec/scenario-workdir.py spec` (the
  generator writes an empty value). Run each file from its package, never the root:
  `bun test --timeout=30000 --reporter=junit --reporter-outfile=<run dir>/junit.xml <file>`.
- The `eque2-verifier` builds a small adapter in its own scratchpad that passes each JUnit result
  unchanged to `scenario-state-reporter.mjs`'s public Vitest hook `onTestRunEnd(files)`. Recipe and
  refusal rules: the log-proxy goal's S6 journal,
  `/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/log-proxy/_bmad-output/goals/log-proxy.goal/spec/journal/S6.md`.
- Verify ONE scenario first (the canary). Scale only after it records evidence and a verdict.
- Never edit the reporter, the state CLI or any enforcement program; never read evidence or key files.
- Commit every `verify-spec-*.spec.ts` file the verify step writes, before AC 29 and before each merge.
- Run long commands (BUILD-4, conformance BUILD-6, a whole package suite) in the background with a log
  file and poll it; run conformance only when no builder or verifier is active.

### The checkpoint (AC 7)

`[DS]` runs build checks and scenarios only after every task is trusted, so at the checkpoint no RM
scenario has a verdict yet. AC 2–6 count as passed at the checkpoint when: T1 and its review are trusted
in the state CLI; the AC 2–6 test files pass in a real `bun run test` run in `packages/opencode`, quoted
in the evidence; and the quality gate passes on the branch. Tick AC 2–6 with that evidence; the scenario
verdicts add to it later.

### The live check (AC 27)

- At most 4 live runs and $5 in total, canaries and re-runs included. Approving `ACs.md` approved that
  spend. Past the cap, stop and ask.
- Each run gets a new empty folder and its own `tmux` session (`task-demo.sh` `exec`s the TUI; a re-run
  in the same folder resumes the earlier run). Capture panes with `tmux capture-pane -e` so bold text shows.
- Measure spend from the stored assistant-message costs of the run's sessions, not from the cost display
  that AC 27 tests.

### Merges and commits

- `_bmad-output/` is gitignored, so goal-folder files need `git add -f`. A forced add also takes the
  gitignored `spec/.signer-key`: always add with the add-then-unstage form of step 2d, and check that
  `git ls-files | grep -E '(^|/)\.(signer|evidence)-key$'` prints nothing before each commit and merge.
- Before each merge: the main checkout is on `dev` and clean (stop if not); merge `dev` into the branch
  first; untrack the goal folder (AC 46). Nothing is pushed.

### Evidence notes per criterion

- **AC 29:** run each package's `test` script (`bun run test`, which sets the timeout), not bare
  `bun test`. A test that fails also on `dev` at the base commit is still yours to fix.
- **AC 8, AC 14, AC 20** name `core/runner.ts`, which T2.12 deletes or empties. Evidence names the file
  that now holds the behaviour (`core/supervise/run.ts`, `core/supervise/*`, `core/ops.ts`) and shows
  that `runner.ts` holds no state.
- **AC 10:** an obligation never blocks, so it carries no blocked cause (spec defect 9).
- **AC 35:** show that the shared fixture did not change in the verifying run (no `UPDATE_FIXTURE=1`).
- **AC 4, AC 12, AC 23, AC 25:** cite owner rulings 1, 3 and 5 where they narrow the text.
- Backticked references in `ACs.md` evidence must not contain `mock`, `stub`, `fake`, `dummy`,
  `surrogate`, `stand-in`, `standin`, `placeholder`, `sample`, `example`, `simulated` or `toy` (which
  matches `destroy`). Name the live-check folders in prose, or cite the test file that loads them.
- Read `spec/spec.md` "Defects found in the inputs" before phase 1. Each names how the SPEC builds it.

### Other

- Run tests only from `packages/opencode` and `packages/tui`; the root `bunfig.toml` blocks a root run.
- The conformance guard fingerprints both spec trees, the seed and the suite: commit edits there before a
  conformance run.

## Contract review

Phase R ran an adversarial and edge-case review of this charter, the criteria and the SPEC. Findings and
their resolution are in [`./reviews/`](./reviews/).

## What this preparation did NOT do

- It did not build, test or change any product code.
- It did not start the loop. A fresh context starts it.
- It did not reword, remove, reorder or tick an approved criterion. AC 30–46 are appended; each names
  its source. Phase R reworded AC 31 and AC 37, which this stage appended and nobody approved.
- It did not merge into `dev`, push, or touch the paused `task-harness` goal (D27).

## Done when

The acceptance contract for this workstream is [`./ACs.md`](./ACs.md)
(46 criteria). It is the file the gate reads; this charter does not
restate it. A criterion tagged `[D<n>]` proves an approved technical
decision in [`./decisions.md`](./decisions.md) — build to the decision,
do not re-decide it.

> **An unchecked box is a question, not a verdict.** If an item is still
> `[ ]`, say plainly *why* — then ask whether there is *truly* nothing you
> can do about it. A blocker you didn't create (a pre-existing repo defect,
> a flaky dependency, a broken fixture) is a reason to FIX it, not a licence
> to stop. Almost always there is a next action: investigate it, repair it,
> route around it. Exhaust the autonomous options and complete the item;
> escalate only the genuine blockers listed in this charter's stop rules.

**To drive this hands-off**, open a fresh context and refer to this
folder — naming the path is enough to start it:

```
/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal
```

Or open it as the working directory (`cd <this folder> && claude`, or
`codex`) and it starts itself. The explicit forms —
`/eque2-code-pursue-goal <this folder>` or `pursue-goal <this folder>` —
do the same thing for anyone who wants to be unambiguous.

That binds the stop gate to this folder's `ACs.md` and refuses to let the
run end while any criterion is outstanding. It is the ONLY supported way to
execute this charter — do not paste the criteria into a host agent's
built-in goal command, which judges a conversation rather than an evidenced
checklist and leaves no record of what it judged.
