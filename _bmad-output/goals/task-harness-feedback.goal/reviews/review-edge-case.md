# Phase R — edge-case-hunter review

- **Target:** `goal.md`, `ACs.md` (38 criteria), `spec/` (`spec.md`, `tasks.md`, `coverage.md`, `scenarios.gherkin`,
  `context.md`).
- **Reference inputs (read-only):** `decisions.md`, `plan.md`, `architecture/ARCHITECTURE-SPINE.md`,
  `ux/EXPERIENCE.md`, `task-questions.md`.
- **Method:** the `bmad-review` edge-case-hunter lens (path tracing). The lens walked the contract paths and checked
  the current code where the contract cites it (`blend/index.ts`, `core/runner.ts`, `core/events.ts`, `limits.ts`,
  `background-job.ts`, the conformance suite).
- **Date:** 2026-10-14.
- **Result:** 14 findings: 2 high, 7 medium, 5 low. One finding (EDGE-5) needs the owner. The other findings add a
  scenario, a task note or an appended criterion only.

## Findings

### EDGE-1 — high — An actor that goes to status `error` holds the job, the lease and the slice for ever

- **Edge case.** A unit supervisor, the run supervisor or the live run actor reaches xstate status `error`. Causes
  include an action or guard that throws, a defect inside an invoked Effect that nobody handles, and a
  `TransitionError` from `maxIterations` on a live `send`.
- **Evidence that it is open.**
  - AD-8 says "the job body waits for the run supervisor's final state". AD-9 says "once the run actor's status is
    `done`, `record` stores nothing". Neither one names `error`.
  - RM28 and AC 32 cover only `apply`, which is the fold. They do not cover the live actor that the Recorder sends
    to.
  - SV6 and AC 38 cover worker failures only, not a failure of a supervisor itself.
  - The spine Conventions say "a machine-definition error is a defect (`Effect.die`)". Inside an actor, a defect is
    an `error` status, and no rule handles that status.
  - Checked: RM28, SV4, SV6, SV21, SV25, UI23, T2.4, T2.8–T2.11. No scenario covers it.
- **Consequence.**
  - The job never ends, so the directory lease is never released. Every later `/task` gets the busy reply.
  - The heartbeat region dies with the run supervisor, so the TUI shows `still` and the run keys do nothing.
  - The Recorder keeps storing facts that no actor folds. The next `/task` folds that slice with `apply`, and
    `apply` dies (RM28). So every later `/task` on that spec dies with a defect.
- **Fix.** Append scenario **SV26 "An actor error ends the unit or the run, never freezes it"**, and add task notes to
  T2.4 and T2.8–T2.11:
  1. A unit supervisor in status `error` counts as 3 worker failures. The run supervisor records `task.failed`, or
     the scenario's fact, with `harness error: <defect>`.
  2. When the run supervisor or the run actor is in status `error`, the job's wait ends as it does on `closed`. The
     Recorder stores nothing more, the defect is logged, the lease is released, and the next `/task` is not busy.
  3. When the command folds a stored slice and `apply` dies, it treats that slice as ended. It logs the defect and
     starts a new slice, and the start message says so. It never fails with a defect that nothing handles.
- **Approved items.** D6 and AC 8 are unchanged. Optionally append a criterion: "an actor that fails ends its unit or
  run with a `harness error` reason; the job ends and the directory is free". Not OWNER.

### EDGE-2 — high — A graceful server stop during a run is not proved to leave the run resumable

- **Edge case.** The user quits the TUI while a run is live. This stops the server, which closes the instance scope.
  A SIGTERM does the same.
- **Evidence that it is open.**
  - `context.md` lists "a server stop leaves the run resumable (`runner.ts:819-827`)" as behaviour to preserve.
    Today the `interrupted` handler records `run.cancelled` only when the job status is `cancelled`
    (`runner.ts:825`).
  - No scenario or task test case pins this behaviour for the actors. SV4 and SV25 test only the cancel branch.
    H8 kills the server with SIGKILL (`arms/index.ts:150-153`), so no finalizer runs.
  - In the new design, a scope close also interrupts every worker. Nothing says that an interrupt is not a worker
    failure (AD-8, "3 worker failures in a row").
- **Consequence.** A supervisor can count the interrupts as failures and record `task.failed` with `harness error`.
  The cancel finalizer or the summary can also run. Then the slice ends. The next `/task` starts a new slice and pays
  for the work again, and the transcript gets a false summary.
- **Fix.** Append scenario **SV27 "A server stop leaves the run resumable"**:
  - Given: a live run with a building task and a verifying scenario.
  - When: the instance scope closes, without a job cancel.
  - Then: the store holds no `run.cancelled`, no `task.failed` and no `scenario.verified` from the stop. No summary
    is written, and the status file keeps the last snapshot (liveness becomes `still`).
  - And: the next `/task` with the same path records `run.resumed`.

  Task notes: T2.8 and T2.9, "an interrupted worker is not a worker failure". T2.10 and T2.11, "the cancel finalizer
  records only when the job status is `cancelled`; a stop records nothing".
- **Approved items.** None. Not OWNER.

### EDGE-3 — medium — The summary waits with no limit for a root-session turn, and the lease stays held

- **Edge case.** The run actor reaches `done` while the root session has a turn in flight. Examples are a long model
  turn and a turn that waits on a permission or question prompt.
- **Evidence that it is open.**
  - AD-18: "`say` waits behind any turn of the root session in flight".
  - AD-19: the lease release is the first finalizer, so it runs last, after the supervisor reaches `closed`.
  - UI8: "the summary waits for the turn and is then written once". It gives no limit.
  - T4.11 sets a limit only on the cancel path (the `cancelDeadline` case).
  - AC 33: "the claim is released when … the run ends".
- **Consequence.** `status.json` shows the run as ended, so liveness is `ended` and the run keys do nothing. But every
  `/task` in the directory gets the busy reply, which tells the user to stop the run "with ctrl+x w, then esc twice".
  The user cannot do that, so the directory stays blocked until the root turn ends. With a pending permission prompt,
  that can take any length of time.
- **Fix.** Append scenario **UI24**:
  - Given: a root turn that waits on a permission prompt.
  - When: the run actor reaches `done`.
  - Then: the lease is released after the writer writes the `done` snapshot and before the summary. The next `/task`
    is not busy. The summary is written once, when the turn ends. If the root session goes away, the failure is
    logged (as in UI23).

  The other option is to put a limit on the wait. Record this as a spec defect against the AD-19 order.
- **Approved items.** This fix agrees with AC 33. Not OWNER.

### EDGE-4 — medium — RM8 resumes an ended slice, and the real resume of a stored slice is untested

- **Edge case.** An old slice is resumed after this change.
- **Evidence that it is open.**
  - RM8 (`scenarios.gherkin:123-129`) uses a slice that ends with `run.ended { state: "done" }`, which is an ended
    slice. Then it says "the run resumes" and "the resume records only run.resumed". But AC 33, SV3 and AD-6 say that
    an ended slice starts a new slice.
  - Two paths that AC 3 needs have no scenario:
    - An old slice with no `run.ended` and no `path`, resumed by `/task <whole spec>`.
    - The observed stuck slice. It has no `run.ended`, and after the cascade its fold is `done` with
      `budget_exhausted`. The command decides "ended" by the fold, as `runner.ts:846-849` does today.
- **Consequence.**
  - The RM8 test can pass only by bypassing the command, so it proves a path that `/task` never takes.
  - Resuming a fold whose status is `done` would give an actor in which `record` stores nothing, so `run.resumed` is
    silently lost.
  - The owner's first `/task` after the upgrade is not pinned.
- **Fix.** Split RM8 into three scenarios:
  - **RM8a.** An old slice that ended folds with the stop's state. `/task` then records `run.started` (a new slice).
  - **RM8b.** An old slice with no end and no `path`, whose fold is not `done`, resumes on `/task <spec>` (also on
    `./<spec>/`). It records only `run.resumed { path }`.
  - **RM8c.** The observed facts with no `run.ended` fold to `done` (`budget_exhausted`, T1.5 and T1 blocked).
    `/task` starts a new slice and never resumes a `done` fold.
- **Approved items.** This is a scenario change for the evidence of AC 3. No change to an AC. Not OWNER.

### EDGE-5 — medium — AC 31 tells a cancel to move obligations to `cancelled`, but no obligation can do that

- **Edge case.** A cancel or a run wall-clock stop arrives while obligations are `pending` or `stale`.
- **Evidence that it is open.**
  - AC 31: "moves every unfinished task, obligation and scenario to cancelled".
  - AD-2: every obligation state is final.
  - AD-4: the cancel rows exist only for task and scenario states.
  - The AD-13 obligation vocabulary has no `cancelled` state.
  - RM14 and RM27 check only tasks and scenarios.
- **Consequence.** A verifier who reads AC 31 literally cannot find evidence for the obligation half. A builder can
  add an obligation `cancelled` state that no other part of the contract defines.
- **Fix.** Reword AC 31 to "every unfinished task and scenario", or have the owner approve this reading: "obligations
  keep their state because every obligation state is final". Then add a line to RM14: "obligations keep their states
  on a cancel".
- **Approved items.** AC 31 is in the hash-locked `ACs.md`. **OWNER.**

### EDGE-6 — medium — A spec with no task loads, then dies or never ends

- **Edge case.**
  - A `.spec` folder that holds only `SPEC.md`.
  - A `.spec` folder that holds only `outside` preconditions and scenarios that need only those preconditions.
- **Evidence that it is open.**
  - No rule from R1 to R13 needs a task (README Rules table, `blend/index.ts` layout).
  - `TaskCommand.plan` then gives `tasks: []` (`command.ts:88-110`).
  - With only `outside` regions and parked scenarios, every region is final in the first macrostep. Then `active`
    is done, the outcome is `done`, and `initial(plan)` dies, because it asserts that the status is `active` (AD-6).
  - With no unit at all, no final child enters, so `active` never raises its done event. The outcome then waits for
    ever. The live run ends only on the 30-min wall clock, and a scripted run never ends.
  - Checked: T1.2 "Empty / Null" (no scenarios and no outside, but tasks present), RM1, RM2, RM19–RM22, VF1–VF21. No
    plan with zero tasks is generated, walked or refused.
- **Fix.**
  - Add a command refusal "Refused <path>. No work started." with a plain line, for example "the spec holds no task".
    A loader rule can do the same.
  - Make the generator assert at least one task region.
  - Append scenario **VF22**, and state the rule in the README Validation section (T3.11).
- **Approved items.** This adds a refusal only. Not OWNER.

### EDGE-7 — medium — The refusal is not complete when a spec has a format fault and a graph fault

- **Edge case.** One spec has an R1–R4 failure and also an R5–R13 fault, for example an R3 front-matter error and an
  R7 cycle.
- **Evidence that it is open.**
  - When any R1–R4 failure exists, `Blend.load` skips the rules that check more than one file (`blend/index.ts:67-69`,
    `PER_FILE` at line 82).
  - The refusal says "1 failure" and lists only R3. The next `/task` shows the cycle.
  - VF1 and VF9 never mix the two kinds of fault. DOC1 and T3.11 do not say that the rules run in two stages.
  - Today's behaviour contradicts the goal statement ("every spec fault is refused with every failure listed") and
    the reason given for D10 ("a spec with three faults needs three runs").
- **Consequence.** The refusal looks complete, but it is not.
- **Fix.**
  - In DOC1 and T3.11, state the two stages: R1–R4 for each file, then R5–R13 only when every file passes.
  - Append scenario **VF23**: a spec with an R3 fault and an R7 cycle lists only the R3 line, and the README explains
    why.
  - Optionally, add a muted note to the refusal: "R5–R13 run once every file passes R1–R4". This changes the
    EXPERIENCE microcopy.
- **Approved items.** AC 12 is met as written ("every failure the loader returns"). The README fix and the scenario
  are not OWNER. The optional change to the refusal text changes the approved UX.

### EDGE-8 — medium — T2.8 sets the task wall clock on resume against `taskClockStart`

- **Edge case.** A task supervisor is spawned on resume for a task that was building before the server stopped.
- **Evidence that it is open.**
  - T2.8 (`tasks.md:481`) expects `task.failed` after 10 minutes for a task that started 50 minutes before the
    resume, with a 60-minute limit.
  - `taskClockStart` (`runner.ts:648-657`) is a preserved pure export. It never starts before the latest start or
    resume ("downtime does not count"). So the clock restarts at `run.resumed`, and the result is 60 minutes.
  - The run wall clock also restarts at the resume (`runner.ts:854-857`). T2.10 does not say this.
- **Consequence.** The builder must either break the kept `taskClockStart` tests, and then fail tasks just after a
  resume because downtime counts, or fail the T2.8 case.
- **Fix.**
  - Reword the T2.8 case: "across a resume, the task clock restarts at `run.resumed` (`taskClockStart`). A supervisor
    that is spawned again inside one job keeps the remaining time."
  - Add a note to T2.10: "the run wall clock counts from the `run.started` or `run.resumed` of this job".
- **Approved items.** None. Not OWNER.

### EDGE-9 — medium — T3.3 gives two conflicting rules for who records `spec.checked`

- **Edge case.** A reload that is valid, changes a hash and clears a warning. It produces `obligation.stale` and
  `spec.checked { failures: [] }`.
- **Evidence that it is open.** T3.3 holds conflicting test cases:
  - Line 629: "staleCheck … records nothing itself; the run supervisor records".
  - Line 630: "… recorded by one `record` worker in a fixed order".
  - Line 633: "the stale-check worker itself records `spec.checked`".
  - Spec defect 8 and T2.7 choose the worker.
- **Consequence.** The builder cannot meet all the test cases. The order of the two facts is not fixed, so the run
  history and the warning toggles can differ from run to run.
- **Fix.**
  - Delete lines 629 and 630.
  - Pin this order: the worker records `spec.checked`, only when the list differs from its input warning, before it
    returns. Then the run supervisor assigns the spec and records `obligation.stale`.
  - Add a test that asserts this order.
- **Approved items.** AC 14 is met as it is ("the stale-check actor records"). Not OWNER.

### EDGE-10 — low — A stored slice that does not load blocks subtree runs for ever

- **Edge case.** The user renames or deletes a task folder that an older subtree slice used.
- **Evidence that it is open.**
  - SD-13 and T3.4 (`tasks.md:655`) refuse with "one plain line that names the slice's path". The line gives no
    remedy.
  - The contract does not say that the D13 read walks the slices from the newest one back and stops at the first
    slice that loads and whose plan holds the task.
  - VF20 and VF21 have no slice that does not load.
- **Consequence.**
  - Every later subtree `/task` of that spec can be refused, also when a newer whole-spec slice already decides.
  - A walk over all slices loads and folds every slice on each subtree `/task`. That is about 1 s for each slice of a
    few hundred facts.
- **Fix.**
  - Pin the walk: start at the newest slice and stop early.
  - Refuse only when a slice that does not load is newer than the slice that decides.
  - Make the plain line give a remedy: "… run the whole spec once to record a newer run".
  - Append scenario **VF24**.
- **Approved items.** None. SD-13 is the spec's own judgment. Not OWNER.

### EDGE-11 — low — The closing summary puts model text into markdown with no escape

- **Edge case.** A reason, title or scenario title holds markdown or HTML characters. An example is a verifier
  reason such as "Type 'Promise<void>' is not assignable", or text with `*`, `_`, backticks or `|`.
- **Evidence that it is open.** The UI7, UI20 and T4.11 cases use plain reasons only. EXPERIENCE "Closing summary"
  says only "newlines in a reason become spaces".
- **Consequence.** The markdown renderer can drop `<void>` as an HTML tag, or change emphasis. Then the lasting record
  (D18) gives a reason that is not correct.
- **Fix.** Escape markdown characters, or put each reason in a code span. Add a UI7 case with `<`, `*`, a backtick
  and `|`.
- **Approved items.** None. Not OWNER.

### EDGE-12 — low — A status file from before this change decodes, but shows no units

- **Edge case.** The task-ui reads a `status.json` with no tags. Examples are the owner's stuck run in
  `/Users/marknorgate/Projects/eque2/test` and a file that the phase-1 code on `dev` wrote.
- **Evidence that it is open.**
  - SV17, AC 35 and T4.2 prove only that the file decodes.
  - UI1 and AD-16 classify only from tags. So a file with no tags gives no Board column, counts of 0/n, and an empty
    STOPPED list.
  - T4.2 deletes the old fixture, and no scenario draws the old file.
- **Consequence.** After the upgrade, the user sees a run with no tasks until a new `/task` runs.
- **Fix.** Add a TUI test that draws the pre-change fixture and pins the result. For example: liveness `still` and a
  muted line "status from an older harness — type /task to refresh". Another option is a documented fallback for
  units with no tags.
- **Approved items.** AC 35 is unchanged. Not OWNER.

### EDGE-13 — low — The traceability table has no rows for AC 30–38

- **Edge case.** A verifier or a fresh agent maps each criterion to its evidence.
- **Evidence that it is open.**
  - `coverage.md` "Acceptance traceability" (lines 112-142) ends at AC 29.
  - The `scenarios.gherkin` header says "29 criteria".
  - AC 30–38 have scenarios, but no row names them. For example: AC 31 → RM14 and RM27; AC 33 → SV3, SV8 and SV21;
    AC 36 → VF17, VF18 and T3.9; AC 37 → UI8, UI23 and T4.11; AC 38 → SV6, SV22, SV23 and T2.8.
- **Consequence.** For 9 criteria, the gate's checklist has no mapped scenario or task. The loop can then search
  without a result or tick a criterion without the right evidence.
- **Fix.** Append rows 30–38 to the table, and update the gherkin header.
- **Approved items.** None. Not OWNER.

### EDGE-14 — low — A paid cascade run can end `failed` and not `budget_exhausted`

- **Edge case.** In the paid live check (AC 27), the real builder of T1.1 in `example-cascade.spec` works past the
  live task wall clock of 10 minutes (`limits.ts:37`). It can also try to make the gate pass.
- **Evidence that it is open.**
  - T1.15 pins only that "the gate's command exits 1 on every run".
  - T1.15 does not pin that the command is inline, for example `exit 1`, and reads no file in the repo that the
    builder can change.
  - T1.15 does not pin that the goal of T1.1 is one small change, so that `task_ready` comes well inside the wall
    clock.
  - VF17 uses the scripted model, so it cannot show this case.
- **Consequence.** T1.1 ends `failed` (wall clock) and T1.2 reads "blocked by T1.1: failed", so the AC 27 panes do
  not match. If the gate runs a script that the builder can edit, T1.1 can even end trusted, and the cascade never
  happens. Each such run costs a paid re-run inside the cap of 4 runs and $5.
- **Fix.** Add to T1.15:
  - The gate command is inline and touches no file in the repo.
  - The `TASK.md` goal of T1.1 is a one-line change.
  - A test checks that the gate command names no path inside the seed.
- **Approved items.** None. Not OWNER.

## Edge cases checked and found covered

| Edge case | Covered by |
|---|---|
| A task dies while a sibling is mid-verification | RM10, VF17 |
| Cancel during the outcome step | The settle happens in the same macrostep (AD-4, RM27). A record after `done` stores nothing (SV7, T2.4) |
| Facts after `run.ended` | RM5, RM6 |
| Duplicate facts | RM17 (a second trust), SV20, T2.8 (an old `hook.ready`), T2.10 (two entries before the supervisor reads) |
| Two dead tasks in one fold step | One fact kills at most one task. A tie on `at` is decided by the log index (T1.4 Boundary) |
| A lease left by a crashed server | The lease is in memory for each process (AD-19). A failed start and a defect release it (T2.11, SV21) |
| A server crash (SIGKILL) mid-run, then resume | H8 in BUILD-6, SV3. A graceful stop is not covered: see EDGE-2 |
| The 5 s heartbeat and the 15 s limit | SV5, and T4.1 at 15 000 ms and 15 001 ms. The run keys do nothing while `still` (UI3), as accepted |
| A summary while the root session is busy or deleted | UI8, UI23. The wait has no limit: see EDGE-3 |
| `/task trust` before, during or after a run | SV20 (before the start, and deferred during the start step), VF7, VF21 |
| A fault folder that triggers rules other than the planted ones | T3.6: "names every planted rule and no other" |
| A spec edited back to valid during a run | VF5, UI16, UI20 |
| A very long failure list | VF1. The transcript and `run.reason` hold every line. The TUI clips the list, which is only cosmetic |
| No status file, or a half-written status file | UI3 (`absent`), UI2 (keeps the last good status) |
| Very long titles, and durations over an hour | EXPERIENCE rules for cutting and wrapping, UI6, UI11 ("1h 4m") |
| A run with no cost data | UI15 (hidden before any tokens; `$0.00` for a free model) |
| A plan with only scenarios or only `outside` preconditions | Not covered: see EDGE-6 |
| Resume of a slice stored before this change | Not covered as written: see EDGE-4 |
