# Acceptance criteria

Goal: the `/task` harness answers the thirteen questions in `task-questions.md` — one xstate machine holds the whole
run so that no run can get stuck, live supervision is xstate actors, every spec fault is refused with every failure
listed, and the TUI shows the run's title, reasons, blocked causes, scenarios, timings, cost and a closing summary.

## Done when

- [ ] The blend format README has a "Validation" section that answers questions 1, 3 and 4: what runs before any work starts, every rule R1–R13 with where it is enforced, how a refusal appears, how the run machine holds the order, and which graph faults are refused — `task-formats/blend/README.md`
      - explanation: not written yet.

Phase 1 — one run machine:

- [ ] [D1] The engine builds one machine per plan from initial(plan), whose active state is parallel with one region per task, obligation group, scenario and outside precondition; the four per-unit machines and the fold code (stepTask, stepRun, cancel, staleAlone) are gone; the existing engine tests pass on it — `packages/opencode/src/task/engine-xstate/index.ts`
      - explanation: not built yet; four per-unit machines are joined by fold code.
- [ ] **CRITICAL** [D2] Folding the observed release-notes facts (T1.1–T1.3 trusted, T1.4 budget exhausted after 3 attempts) puts T1.5 and T1 in blocked in the same fold step, each with a history entry that names the upstream cause ("blocked by T1.4: budget exhausted"); a run stored before this change folds and resumes with no new fact type — `packages/opencode/src/task/engine-xstate/index.ts`
      - explanation: not built yet; T1.5 and T1 wait for ever with no reason.
- [ ] [D3] The run ends only when every region is final; with one task dead, an independent task that is still building runs to its end first; the end state is done when every task is trusted, otherwise the state of the task that died first, and the reason lists every dead and blocked task; follows is gone and the runner's done decision reads the machine — `packages/opencode/src/task/engine-xstate/index.ts`
      - explanation: not built yet; the run goes final when any task dies.
- [ ] [D4] A task becomes ready only when every after task and every child is trusted; two siblings with no after between them become ready in the same step; a task that waits on an untrusted outside task stays waiting and moves on its trust fact; the readiness check in schedule and the runner's outside trust set are gone — `packages/opencode/src/task/engine-xstate/index.ts`
      - explanation: not built yet; readiness lives in the runner's schedule.
- [ ] [D5] A graph test walks every reachable state with getAdjacencyMap for the release-notes plan and both valid live-check plans, finds 0 states that are not done and that no event can move, and finds the observed stuck state when a copy of the config has its cascade rows removed — `packages/opencode/test/task/engine-xstate-graph.test.ts`
      - explanation: not written yet.
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

## Notes

- AC 1 answers questions 1, 3 and 4 in a lasting place. Questions 2, 6, 7, 8, 9, 11 and 12 are answered by what the
  TUI shows (AC 18–26) and by the live check (AC 27). Question 5 is AC 16 and AC 17; question 10 is AC 24;
  question 13 is AC 2–11.
- AC 7 is the phase-1 checkpoint merge. It needs the quality gate to pass on the branch at that point, not only at
  the end.
- The live check in AC 27 spends tokens on the configured model. Approving this file approves that spend, up to the
  cap it states. Past the cap, the loop stops and asks.
- AC 7 and AC 28 are the only steps that change `dev`. Neither pushes.
