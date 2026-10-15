> **START NOW — do not wait to be asked.** This is a prepared goal folder.
> Invoke `eque2-code-pursue-goal` on the directory containing this file,
> as the first thing you do. Being pointed at this charter IS the request
> to execute it; there is nothing else one does with a `.goal` folder.
> Do not summarise this charter back, do not ask whether to proceed, and
> do not begin the work with no gate bound. If the starter refuses,
> report the refusal and stop.

# Acceptance criteria

Goal: the `/task` harness answers the thirteen questions in `task-questions.md` — one xstate machine holds the whole
run so that no run can get stuck, live supervision is xstate actors, every spec fault is refused with every failure
listed, and the TUI shows the run's title, reasons, blocked causes, scenarios, timings, cost and a closing summary.

## Done when

- [ ] The blend format README has a "Validation" section that answers questions 1, 3 and 4: what runs before any work starts, every rule R1–R13 with where it is enforced, how a refusal appears, how the run machine holds the order, and which graph faults are refused — `task-formats/blend/README.md`
      - explanation: not written yet.

Phase 1 — one run machine:

- [x] [D1] The engine builds one machine per plan from initial(plan), whose active state is parallel with one region per task, obligation group, scenario and outside precondition; the four per-unit machines and the fold code (stepTask, stepRun, cancel, staleAlone) are gone; the existing engine tests pass on it — `packages/opencode/src/task/engine-xstate/index.ts`
      - evidence: T1 is trusted in the state CLI (T1.2 generator, T1.6 engine API, T1.7 engine tests each trusted by the eque2-verifier; the T1 parent verified and trusted after its review, `spec/journal/task/T1-review.md`). `packages/opencode/src/task/engine-xstate/machine.ts` builds one machine per plan (a parallel root; `active` is parallel with one region per task, obligation group, scenario and outside or external precondition); `engine-xstate/index.ts` exposes initial and apply over snapshots; `packages/opencode/test/task/engine-api.test.ts` "RM3 the engine module no longer defines the four machines or the fold code" asserts that stepTask, stepRun, cancel and staleAlone are gone; `packages/opencode/test/task/engine-xstate.test.ts` holds the old engine tests rewritten as fact sequences (owner ruling 2). Run: the checkpoint quality gate on the branch: `bun run test` in packages/opencode (BUILD-4, 2026-10-15 04:46–05:05 BST, code at 6c8373d2ac, unchanged to 686e0c88dd) printed "4001 pass / 41 skip / 1 todo / 0 fail / Ran 4043 tests across 281 files" with exit 0 (`_bmad-output/goals/task-harness-feedback.goal/spec/journal/gate/checkpoint-build4-opencode.log`; the test script runs `bun test --only-failures`, so the passing files of test/task print no line); BUILD-1 typecheck, BUILD-2 lint, BUILD-3 build and the tui suite passed (`spec/journal/gate/checkpoint-build1-typecheck.log`, `checkpoint-build2-lint.log`, `checkpoint-build3-build.log`, `checkpoint-build4-tui.log`); BUILD-6 conformance guard passed at 686e0c88dd, o2 16/16 H1–H16, baseline 0/17 (`spec/journal/gate/checkpoint-build6-conformance.log`).
- [x] **CRITICAL** [D2] Folding the observed release-notes facts (T1.1–T1.3 trusted, T1.4 budget exhausted after 3 attempts) puts T1.5 and T1 in blocked in the same fold step, each with a history entry that names the upstream cause ("blocked by T1.4: budget exhausted"); a run stored before this change folds and resumes with no new fact type — `packages/opencode/src/task/engine-xstate/index.ts`
      - evidence: `packages/opencode/test/task/machine.test.ts` "RM7 blocks T1.5 and T1 in the macrostep that exhausts T1.4, with the named cause" and `packages/opencode/test/task/engine-xstate.test.ts` RM7 fold the observed release-notes facts: T1.5 and T1 go to blocked in one step with the reason "blocked by T1.4: budget exhausted" and one history entry each; `packages/opencode/test/task/engine-api.test.ts` RM8a folds every stored fact type of an old slice (no path, run.ended done) with no new fact type; `packages/opencode/test/task/core-runner.test.ts` RM8 resumes an old slice that has not ended. T1.3, T1.5 and T1.6 are trusted in the state CLI. Run: the checkpoint quality gate on the branch: `bun run test` in packages/opencode (BUILD-4, 2026-10-15 04:46–05:05 BST, code at 6c8373d2ac, unchanged to 686e0c88dd) printed "4001 pass / 41 skip / 1 todo / 0 fail / Ran 4043 tests across 281 files" with exit 0 (`_bmad-output/goals/task-harness-feedback.goal/spec/journal/gate/checkpoint-build4-opencode.log`; the test script runs `bun test --only-failures`, so the passing files of test/task print no line); BUILD-1 typecheck, BUILD-2 lint, BUILD-3 build and the tui suite passed (`spec/journal/gate/checkpoint-build1-typecheck.log`, `checkpoint-build2-lint.log`, `checkpoint-build3-build.log`, `checkpoint-build4-tui.log`); BUILD-6 conformance guard passed at 686e0c88dd, o2 16/16 H1–H16, baseline 0/17 (`spec/journal/gate/checkpoint-build6-conformance.log`).
- [x] [D3] The run ends only when every region is final; with one task dead, an independent task that is still building runs to its end first; the end state is done when every task is trusted, otherwise the state of the task that died first, and the reason lists every dead and blocked task; follows is gone and the runner's done decision reads the machine — `packages/opencode/src/task/engine-xstate/index.ts`
      - evidence: `packages/opencode/test/task/machine.test.ts` "the outcome region (AD-4)" (RM10 waits for an independent building task, RM11 the first death by history order with every dead and blocked line, done when every task is trusted, RM14 stop, RM27) and `packages/opencode/test/task/engine-xstate.test.ts` RM10, RM11 (both death orders) and RM12 (owner ruling 1: done needs the scenarios too); the source test in `packages/opencode/test/task/core-runner.test.ts` asserts that follows and checkDone are gone and that the loop ends on the machine's done. T1.4, T1.7 and T1.11 are trusted. Run: the checkpoint quality gate on the branch: `bun run test` in packages/opencode (BUILD-4, 2026-10-15 04:46–05:05 BST, code at 6c8373d2ac, unchanged to 686e0c88dd) printed "4001 pass / 41 skip / 1 todo / 0 fail / Ran 4043 tests across 281 files" with exit 0 (`_bmad-output/goals/task-harness-feedback.goal/spec/journal/gate/checkpoint-build4-opencode.log`; the test script runs `bun test --only-failures`, so the passing files of test/task print no line); BUILD-1 typecheck, BUILD-2 lint, BUILD-3 build and the tui suite passed (`spec/journal/gate/checkpoint-build1-typecheck.log`, `checkpoint-build2-lint.log`, `checkpoint-build3-build.log`, `checkpoint-build4-tui.log`); BUILD-6 conformance guard passed at 686e0c88dd, o2 16/16 H1–H16, baseline 0/17 (`spec/journal/gate/checkpoint-build6-conformance.log`).
- [x] [D4] A task becomes ready only when every after task and every child is trusted; two siblings with no after between them become ready in the same step; a task that waits on an untrusted outside task stays waiting and moves on its trust fact; the readiness check in schedule and the runner's outside trust set are gone — `packages/opencode/src/task/engine-xstate/index.ts`
      - evidence: `packages/opencode/test/task/machine.test.ts` "readiness and the cascade (AD-3)" (RM15 rows and guards, RM16 siblings in one snapshot, RM17 the outside wait and its trust) and `packages/opencode/test/task/engine-xstate.test.ts` RM15 (after and child halves), RM16 (two leaves made ready by one step), RM17 (not ready before the T9 trust); the source test in `packages/opencode/test/task/core-runner.test.ts` finds no readiness check and no outside trust set. T1.3, T1.7 and T1.11 are trusted. Run: the checkpoint quality gate on the branch: `bun run test` in packages/opencode (BUILD-4, 2026-10-15 04:46–05:05 BST, code at 6c8373d2ac, unchanged to 686e0c88dd) printed "4001 pass / 41 skip / 1 todo / 0 fail / Ran 4043 tests across 281 files" with exit 0 (`_bmad-output/goals/task-harness-feedback.goal/spec/journal/gate/checkpoint-build4-opencode.log`; the test script runs `bun test --only-failures`, so the passing files of test/task print no line); BUILD-1 typecheck, BUILD-2 lint, BUILD-3 build and the tui suite passed (`spec/journal/gate/checkpoint-build1-typecheck.log`, `checkpoint-build2-lint.log`, `checkpoint-build3-build.log`, `checkpoint-build4-tui.log`); BUILD-6 conformance guard passed at 686e0c88dd, o2 16/16 H1–H16, baseline 0/17 (`spec/journal/gate/checkpoint-build6-conformance.log`).
- [x] [D5] A graph test walks every reachable state with getAdjacencyMap for the release-notes plan and both valid live-check plans, finds 0 states that are not done and that no event can move, and finds the observed stuck state when a copy of the config has its cascade rows removed — `packages/opencode/test/task/engine-xstate-graph.test.ts`
      - evidence: `packages/opencode/test/task/engine-xstate-graph.test.ts` RM19 (release-notes: 338 keys, 0 stuck), RM20 (example-scenarios and example-cascade: 0 stuck), RM21 (a copy without the blocked rows: the observed stuck state is found), RM22 (the reduction check); the opt-in full-interleaving stale walk of the cascade plan: 33,944 keys, 331,133 edges, 0 stuck (`spec/journal/task/T1.10-stale-walk-head.log`); every walked plan first passes the totality scan in machine(plan) (owner ruling 4). T1.9 and T1.10 are trusted. Run: the checkpoint quality gate on the branch: `bun run test` in packages/opencode (BUILD-4, 2026-10-15 04:46–05:05 BST, code at 6c8373d2ac, unchanged to 686e0c88dd) printed "4001 pass / 41 skip / 1 todo / 0 fail / Ran 4043 tests across 281 files" with exit 0 (`_bmad-output/goals/task-harness-feedback.goal/spec/journal/gate/checkpoint-build4-opencode.log`; the test script runs `bun test --only-failures`, so the passing files of test/task print no line); BUILD-1 typecheck, BUILD-2 lint, BUILD-3 build and the tui suite passed (`spec/journal/gate/checkpoint-build1-typecheck.log`, `checkpoint-build2-lint.log`, `checkpoint-build3-build.log`, `checkpoint-build4-tui.log`); BUILD-6 conformance guard passed at 686e0c88dd, o2 16/16 H1–H16, baseline 0/17 (`spec/journal/gate/checkpoint-build6-conformance.log`).
- [ ] [D26] After AC 2–6 and the quality gate pass on the branch, it is merged into dev with git merge --no-ff in the main checkout, and nothing is pushed — `.git/refs/heads/dev`
      - explanation: not merged yet.

Phase 2 — live supervision as actors:

- [ ] [D6] The runner holds no polled loop, tick counter, STALE_EVERY, failures map, MAX_FAILURES, stopping flag, children list or active registry; a run supervisor actor invokes the builder, verifier, proof and stale-check actors from the run machine's tags and records each outcome as a fact; the fold invokes nothing — `packages/opencode/src/task/core/runner.ts`
      - explanation: not built yet.
- [ ] [D7] The session watch and the hooks hold no Ref, MutableHashMap or polled while loop; stall, idle and the spend cap are delayed transitions and guards of one xstate actor for each running task; the nudge counter and the hook maps (ready, verdicts, repeated, limits) are its context; each decision is recorded as a fact — `packages/opencode/src/task/core/sessions.ts`
      - explanation: not built yet.
- [ ] [D8] The status file is a projection of the run machine's snapshot: each task, obligation and scenario carries its state, its tags (active, ended, blocked, waiting), its blocked cause, and its start and end times from the fact timestamps; runState and the waitingOn derivation from the plan are gone — `packages/opencode/src/task/core/status.ts`
      - explanation: not built yet.
- [ ] **CRITICAL** [D9] An audit test fails on any MutableHashMap, Ref, SynchronizedRef, setInterval, polled loop, module-level mutable let, or list of lifecycle states in packages/opencode/src/task and packages/tui/src/task-ui, except allowlist entries that each carry a written reason, and it passes on the final branch — `packages/opencode/test/task/state-audit.test.ts`
      - explanation: not written yet.

Phase 3 — validation and fault folders:

- [ ] [D10] A refused /task lists every failure the loader returns, one line each as R-number, path and message, in the session message and in the status file's run reason — `packages/opencode/src/task/core/command.ts`
      - explanation: not built yet; the command reports only the first failure.
- [ ] [D11] A VERIFY.md with no ensures fails R3, and both shipped specs (release-notes, provider-ordering-admin) still load with zero failures — `packages/opencode/src/task/blend/schema.ts`
      - explanation: not built yet; ensures is optional in the schema.
- [ ] [D12] A spec edited during a run so that it no longer validates leaves the run on its loaded plan; the stale-check actor records the failures as a fact, and they appear in the status file and as a run warning in the TUI — `packages/opencode/src/task/core/runner.ts`
      - explanation: not built yet; the failure is ignored without a message.
- [ ] [D13] A subtree /task whose task is after an untrusted folder task outside the run is refused at the start, naming both tasks, with trust read from the run machine folded over the stored facts; a subtree run that leaves scenarios out names them in its start message — `packages/opencode/src/task/core/command.ts`
      - explanation: not built yet; the run waits for ever and drops the scenarios silently.
- [ ] [D14] Six fault folders under task-formats/blend (format-faults, cycle, self-after, unknown-after, no-ensures, outside-run) are each refused by the real /task command with every planted rule named, proved by a test that runs the command on each folder — `packages/opencode/src/task/core/command.ts`
      - explanation: not built yet.
- [ ] [D15] The scenario folder (one leaf, one scenario S1) and the cascade folder (T1.1 proved by a gate that always exits 1 with a one-attempt budget, T1.2 after T1.1, T1.3 independent) load with zero failures, and task-demo.sh copies every fault and live-check folder into the demo folder — `packages/opencode/script/task-demo.sh`
      - explanation: not built yet.

Phase 4 — task UI:

- [ ] [D16] The task-ui classifies units only from the status tags (no ACTIVE or ENDED lists; the Gantt no longer derives state from the history); its view state (design, chosen, expanded, watching, the watch arming) is one xstate machine; the Board shows each blocked task with its upstream cause — `packages/tui/src/task-ui/store.ts`
      - explanation: not built yet.
- [ ] [D17] The first message of a run reads "Implementing spec" in muted text and the spec's H1 title in bold (a subtree run adds the task id and title), falls back to the spec id when the title is empty, and the status file's run carries the title — `packages/opencode/src/task/core/command.ts`
      - explanation: not built yet; the message is "Task harness: running <args> in the background".
- [ ] [D18] When the run machine reaches a final state, the root session gets one assistant-role markdown message built from the final status with no model call: the outcome; each failed, exhausted or blocked task with its reason or cause; each rejected scenario with its reason; each task's duration; and the run's cost — `packages/opencode/src/task/core/runner.ts`
      - explanation: not built yet; the end of a run goes only to the background job output.
- [ ] [D19] A failed, exhausted or blocked task shows its reason or upstream cause in every task-ui design's expanded view and in the Peek BUILDER heading, in the layout the UX document sets — `packages/tui/src/task-ui/`
      - explanation: not built yet; only the Board shows a task's reason.
- [ ] [D20] The status file's scenarios carry their titles, and every task-ui design's expanded view lists every scenario of the run with glyph, id, title and state, and a rejected scenario's reason — `packages/tui/src/task-ui/`
      - explanation: not built yet; only the Matrix shows scenarios, as glyph and id.
- [ ] [D21] Each task's duration, from the start and end times in the status file, shows live while the task runs and fixed once it ends, in each design and position that the UX document names — `packages/tui/src/task-ui/`
      - explanation: not built yet; no per-task duration exists.
- [ ] [D22] The shortcut bar no longer shows the /task-design switch hint during a run, and /task-design still runs from the command list — `packages/tui/src/task-ui/ui.tsx`
      - explanation: not built yet.
- [ ] [D23] While the run is active, the In the Flow diamond plays the grow-and-melt frames through the opentui-spinner element; it is a static diamond once the run's tags say it has ended or when animations are off; the plain-text titles stay static — `packages/tui/src/task-ui/ui.tsx`
      - explanation: not built yet; the diamond is static text.
- [ ] [D24] For a /task root session, the prompt footer, the sidebar and the task-ui show the summed tokens and cost of the run's harness sessions, live, instead of nothing or $0.00, and the closing summary repeats the run total — `packages/tui/src/component/prompt/index.tsx`
      - explanation: not built yet; child session cost never reaches the root session.

Delivery:

- [ ] [D25] Live runs in a demo folder seeded by task-demo.sh, driven in tmux with the configured model: the scenario folder ends done with S1 trusted, and the cascade folder ends with T1.1 exhausted, T1.2 blocked by T1.1 and T1.3 trusted; the captured panes show the bold spec title, the scenario row, the task durations, a non-zero cost, the blocked card with its cause and the closing summary; at most 4 live runs and $5 in total — `packages/opencode/script/task-demo.sh`
      - explanation: not run yet; it runs last, after the scripted checks pass.
- [ ] [D26] After every other criterion passes, the branch is merged into dev with git merge --no-ff in the main checkout, and nothing is pushed — `.git/refs/heads/dev`
      - explanation: not merged yet.
- [ ] **CRITICAL** The quality gate passes on the final branch: with the scripts in the root `package.json`, bun lint and bun typecheck exit 0; bun test exits 0 in packages/opencode and in packages/tui; and the scripted conformance suite (bun run script/task-conformance.ts --arm o2 --runs 1, no --live) still passes H1–H16 — `package.json`
      - explanation: not run yet.

Added in stage 2 (prepare-goal) — each names its source; the approved AC 1–29 above are unchanged:

- [ ] [D3] With every task trusted, a run whose runnable scenario is failed or rejected ends failed with the reason "acceptance not proved: <id> <state>"; a scenario that waits only on an outside precondition is parked, adds "not run: <id> waits on <ids>" to the reason, and the run can still end done — `packages/opencode/src/task/engine-xstate/machine.ts`
      - explanation: not built yet. Appended in stage 2 from owner ruling 1 (2026-10-14), which overrides the literal "done when every task is trusted" in AC 4; spec RM12, RM13, UI20.
- [ ] [D3] A cancel or a run wall-clock stop moves every unfinished task and scenario to cancelled and keeps the finished ones (an obligation ends with its task), so every region is final and the run ends; the end state is cancelled unless a task died before the stop, and then AC 4's rule gives the end state and the reason adds the stop's reason — `packages/opencode/src/task/engine-xstate/machine.ts`
      - explanation: not built yet. Appended in stage 2 from prepare-goal default 4 (spec RM14, RM27): D3 ends a run only when every region is final, so a stop must finish the units that still wait. Reworded in Phase R (EDGE-5: obligations have no cancelled state; ADV-16: approved AC 4 outranks the spine's stop-first rule).
- [ ] [D1] Folding the stored facts, sending the same facts to a live actor, and restoring a folded prefix into an actor give equal snapshots for 40 seeded random sequences; a machine error makes apply die with a defect that names it, and apply never returns a snapshot whose status is error — `packages/opencode/src/task/engine-xstate/index.ts`
      - explanation: not built yet. Appended in stage 2 from the spec (RM5, RM28; AD-5, AD-6): a machine error must never become a frozen run.
- [ ] One run is live in a directory at a time: a second /task there starts nothing and answers one line that names the live run's spec and path; the claim is released when the background job does not start or the run ends; a run resumes only when its latest slice has not ended and the new /task path equals its path, and otherwise starts a new slice — `packages/opencode/src/task/core/harness.ts`
      - explanation: not built yet. Appended in stage 2 from owner ruling 3 (AD-19 and AD-6 accepted 2026-10-14); spec SV3, SV8, SV21.
- [ ] /task trust records outside.trusted once on the live run and moves only outside regions; it never moves an external region, and a typed trust never stands in for a folder task's own stored trust in the D13 subtree check — `packages/opencode/src/task/core/command.ts`
      - explanation: not built yet. Appended in stage 2 from the spec review (SV20, VF7, VF21).
- [ ] The TUI decodes the shared status fixture that the harness projection writes and a status file written before this change, and the fixture equals the projection of the observed facts byte for byte — `packages/tui/src/task-ui/store.ts`
      - explanation: not built yet. Appended in stage 2 from the spec (SV17): the status file is the contract between the harness and the TUI.
- [ ] Scripted runs with no paid model: the cascade folder ends with T1.1 budget exhausted after one attempt, T1 and T1.2 blocked by T1.1, T1.3 trusted, and the run budget_exhausted only after T1.3 ends; the scenarios folder ends done with T1.1 and S1 trusted — `packages/opencode/test/task/live-check-runs.test.ts`
      - explanation: not built yet. Appended in stage 2 from the spec (VF17, VF18): the outcome AC 27 checks live is first proved without spend.
- [ ] The closing summary of AC 20 is written once when a turn is in flight, after an abort and after a cancel; the directory is free for the next /task as soon as the run machine is final, whether the summary still waits for the root session or cannot be written; a summary that cannot be written is logged — `packages/opencode/src/task/core/ops.ts`
      - explanation: not built yet. Appended in stage 2 from the spec review (UI8, UI23). Reworded in Phase R (EDGE-3: the summary wait must not hold the directory).
- [ ] Three worker failures in a row fail the unit with a reason that starts "harness error:"; a task's wall clock fails only that task while an independent task keeps building; a tool that runs longer than the stream idle time is not a stall — `packages/opencode/src/task/core/supervise/task.ts`
      - explanation: not built yet. Appended in stage 2 from the spec review (SV6, SV22, SV23).
- [ ] [D5] The machine generator checks every generated config before any run starts: each non-final unit state has a row for every combination of final states of what it waits on, no non-final state lacks a way out other than an outside wait that a fact moves, and the outcome can settle when every region is final; a gap makes the generator die with an error that names the unit, the state and the uncovered outcome, and a test that removes one cascade row from a copy of the config gets that error — `packages/opencode/src/task/engine-xstate/machine.ts`
      - explanation: not built yet. Appended in Phase R from owner ruling 4 (2026-10-14): "it needs to be organised such that these states are structurally impossible to become stuck! A linting or pre-processing should yield errors". The same ruling accepts AC 6's walk in one fixed event order with the small-plan reduction check (AD-7, RM22).
- [ ] [D23] During a live run the status file's run.aliveAt is refreshed every 5 s; when it is older than 15 s and the run has not ended, the TUI shows the run as still: a static In the Flow diamond, frozen task durations and inert run keys — `packages/tui/src/task-ui/store.ts`
      - explanation: not built yet. Appended in Phase R from owner ruling 5 (2026-10-14, default 6 accepted: "Show it as still"); spec SV5, UI3, UI12. It narrows AC 23 and AC 25 for a server that has stopped.
- [ ] An xstate actor error never strands a run: a unit supervisor error records a "harness error" fact for its unit; a run supervisor or run actor error ends the background job and frees the directory; a stored slice that cannot be folded is treated as ended, its defect is logged, and the next /task starts a new slice — `packages/opencode/src/task/core/supervise/run.ts`
      - explanation: not built yet. Appended in Phase R (EDGE-1, spec SV26).
- [ ] A graceful server stop during a run records no run.cancelled, no task.failed and no closing summary, and the next /task with the same path resumes the slice — `packages/opencode/src/task/core/harness.ts`
      - explanation: not built yet. Appended in Phase R (EDGE-2, spec SV27).
- [ ] A spec that holds no task is refused at the start with one line that says so, and no run starts — `packages/opencode/src/task/core/command.ts`
      - explanation: not built yet. Appended in Phase R (EDGE-6, spec VF22): such a spec passes R1–R13 but would never end.
- [ ] The scripted conformance suite still runs all sixteen checks H1–H16 with none skipped or removed, and each check that phase 1 or phase 2 changed is listed with its reason in the journal of the task that changed it — `packages/opencode/test/task-harness/conformance.test.ts`
      - explanation: not built yet. Appended in Phase R (ADV-12): T1.14 and T2.14 may adapt the checks to the new engine, but never weaken them.
- [ ] [D9] The state-audit allowlist on the final branch holds only the AD-17 entries of the architecture spine, each with its written reason — `packages/opencode/test/task/state-audit.test.ts`
      - explanation: not built yet. Appended in Phase R (ADV-17): AC 11 alone accepts any allowlist with reasons.
- [ ] [D26] After each merge into dev (AC 7 and AC 28), dev tracks no path under _bmad-output/, and the goal folder stays on disk in this worktree — `.git/refs/heads/dev`
      - explanation: not merged yet. Appended in Phase R (ADV-6): dev tracks nothing under _bmad-output/ (.gitignore), and the earlier promotion goal untracked its folder before its merge (commit a1feaa7a84).

## Notes

- AC 1 answers questions 1, 3 and 4 in a lasting place. Questions 2, 6, 7, 8, 9, 11 and 12 are answered by what the
  TUI shows (AC 18–26) and by the live check (AC 27). Question 5 is AC 16 and AC 17; question 10 is AC 24;
  question 13 is AC 2–11.
- AC 7 is the phase-1 checkpoint merge. It needs the quality gate to pass on the branch at that point, not only at
  the end.
- The live check in AC 27 spends tokens on the configured model. Approving this file approves that spend, up to the
  cap it states. Past the cap, the loop stops and asks.
- AC 7 and AC 28 are the only steps that change `dev`. Neither pushes.
