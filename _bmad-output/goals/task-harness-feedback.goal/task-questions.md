1. Does the spec file format, such as `.claude/worktrees/spike-task-harness/task-formats/blend/release-notes.spec` get verified in TypeScript before it is executed? Are the rules exhaustive?
2. How does a verification failure appear? UX
3. Does the harness respect the task ordering and dependencies specified?
4. Are these also validated in TypeScript, to make sure there are no circular dependencies, no orphaned tasks etc.?
5. Can you please produce example-*.spec folders exhibiting faults in all of these areas and check that the harness responds correctly?
6. At least one has to run scenarios: I see an acceptance folder in release-notes.spec, but these scenarios do not appear in the TUI?
7. Can we introduce an ID/title into a spec? And change the rather dull "Task harness o2" message at the top to be more succinct and beautifully formatted to use this title? "Implementing spec <b>Update dashboard</b>", for example? (with some default if this optional title/ID is not specified)
8. There does not appear to be any clear explanation for a failure in the TUI. Just a cross next to T1...can the main body of the TUI elaborate on the cause once execution has concluded? Either success or failure? In the manner of feedback from the LLM?
9. The token and cost indicators do not appear to be working. Is that because of spec execution? Are our agents not linked to this calculator?
10. Remove "/task-design switch" from the input box during tasks, takes up too much room and is not necessary
11. Can we have per-task timings? Particularly on some of the task views? Where they will fit? Use UX design for this.
12. The "In the Flow" text often has a diamond next to it. Where this appears, can this be animated in the same way as the Claude Code ASCII animation happens? Like it grows and melts and stuff?
13. A blocked task does not cascade, so the run sits in a dead state with no report. Can the xstate machine structurally preclude these stuck corners?

    **Observed** (`/Users/marknorgate/Projects/eque2/test`, `release-notes.spec`): T1.1–T1.3 trusted; T1.4 `budget_exhausted` after 3 attempts (T1.4.c7: the multiline-message test asserts only that "topic change" appears). The run header shows `run: budget exhausted`, but T1.5 (`after: [T1.3, T1.4, T9]`) and the parent T1 stay in WAITING for ever. Neither card says it is blocked, or by what. Nothing will ever move them.

    **Root cause.** xstate only decides how one unit moves on one fact. Every decision that spans units is hand-written code outside the machines:
    - Dependencies live only in the runner: `schedule` (`packages/opencode/src/task/core/runner.ts:768`) starts a waiting task when `afterEffective` and `children` are trusted. No machine knows T1.5 depends on T1.4.
    - The run machine follows a task into `budget_exhausted` / `failed` / `needs_human` (`follows`, `packages/opencode/src/task/engine-xstate/index.ts:567`) and goes final. Only `run.cancelled` cascades to the tasks (`cancel`, `index.ts:748`); the other end states do not.
    - The loop exits once the run has ended (`runner.ts:796`), so the dependants stay in `waiting`, which the task machine treats as a live state, with no history entry and no reason.
    - "Run done" is decided by `checkDone` (`runner.ts:691`), polled every tick, not by the machine.
    - The engine header states the design choice behind this: "A machine config is static, but a run's tasks … come from its spec, so the fold keeps one machine per unit." Four separate machines (obligation, task, scenario, run), each rebuilt per fact, are joined by fold code. The statechart features that would make the whole run checkable are unused.

    **General invariant violated:** the run can be final while a task is not, and a task can be non-final with no event that can ever move it.

    **Requirement (owner, 2026-10-14): xstate must be used EXHAUSTIVELY, wherever state is involved.** No state, state transition, or decision that reads state may live in hand-written code beside the machines: no `MutableHashMap`, `Ref`, `let` counter, polled check or string list that encodes a lifecycle. The durable run lifecycle stays a pure fold of stored facts through xstate; live process supervision (timers, stalls, retries) becomes xstate actors whose outcomes are recorded as facts. State held outside xstate today, all in scope:
    - Run engine (`engine-xstate/index.ts`): four per-unit machines joined by fold code (`stepTask` → `stepRun`, `cancel`, `staleAlone`). One plan-generated machine must hold the whole run: tasks, obligations, scenarios and the run.
    - Runner (`core/runner.ts`): dependency and scenario readiness in `schedule` (768); completion in `checkDone` (691); the polled `loop` with its `tick` counter and `STALE_EVERY` (795); worker failure counts in `failures` with `MAX_FAILURES` (716–735); `stopping` and `children` for shutdown (809–814); the `outside` trust set; the process-wide `active` run registry (90); the builder nudge counter (434).
    - Builder session watch (`core/sessions.ts:256–290`): `activity`, `outcome` and `busy` Refs in a polled `while (true)` loop that decides stall, spend cap and idle.
    - Hooks (`core/hooks.ts:28–31`): `ready`, `verdicts`, `repeated` and `limits` maps that carry a task's turn state between the tool hooks and the runner.
    - Status projection (`core/status.ts:97`): `runState` derives `waiting` vs `running` outside the machine; `waitingOn` derives blocking from the plan.
    - TUI (`packages/tui/src/task-ui/`): `store.ts` re-encodes the lifecycle in its own `ACTIVE` / `ENDED` lists (161–164) and holds view state in signals (`design`, `chosen`, `expanded`, `watching`, 286–289); `watch.tsx:306` holds `armed` / `disarm`; `designs/5-gantt.tsx:29` re-derives task state from history. The board should read state and its classification (active, ended, blocked) from the machine, and the view state should be a machine too.

    **Proposed method (structural):**
    1. Build one run machine per plan (the plan is fixed for a run, so `initial(plan)` can generate the config). The root `active` state is `type: "parallel"` with one region per task.
    2. Give each task region a final `blocked` state. In `waiting`, add an eventless row: `always: { guard: or(stateIn(<each after/child>, exhausted | failed | needs_human | blocked)), target: "blocked" }`. xstate settles eventless rows within one macrostep, so T1.4 → T1.5 → T1 block transitively in the same fold step, each with a history entry naming the upstream cause ("blocked by T1.4: budget exhausted").
    3. Derive the run outcome from `active.onDone`: a parallel state is done only when every region is final, so the run cannot end while a task waits. This replaces `follows` and most of `checkDone`. `blocked` is derived from existing facts, so stored runs fold and resume with no new fact type.
    4. Prove it with the port's graph module (`@jambudipa/xstate-effect/graph`, `getAdjacencyMap`): a test walks every reachable state of a plan and fails on any state that is not done and that no event can move.
    5. Show `blocked` on the board (STOPPED column or its own), with the upstream reason on the card.

    **Evidence (prototype, release-notes plan in the real xstate port, about 80 lines):** without the cascade, 36 reachable states, 7 stuck, including the exact observed state (`T1.1–T1.3 trusted, T1.4 exhausted, T1.5 waiting, T1 waiting`). With the cascade, 29 reachable states, 0 stuck.

    **Decisions for the plan:**
    - When one task exhausts its budget, should independent work (tasks that do not depend on it) run to completion, or should the run stop at once (today's behaviour, which also strands in-flight siblings)? `onDone` gives the first; the second needs every non-final region to block on any dead task.
    - T1.5 also waits on T9, an `outside` precondition. If T9 is never trusted, T1.5 waits for ever by design (run state `waiting`). Should the board report that case explicitly too?
    - Alternative with a smaller diff (about 2–3 hours): keep one machine per unit and have the fold send a `task.blocked` event to dependants after a task enters a dead state. Rejected: it breaks the requirement above. The cascade stays in hand-written fold code, the same place that missed it, and nothing proves the absence of other stuck corners.
    - Effort: the engine rewrite (method steps 1–5) is about 1 day on its own. The full requirement (runner, session watch, hooks, status, TUI) is several days; the plan should stage it, engine first, because the engine fixes the observed bug.
