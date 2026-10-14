---
review: adversary
target: ../ARCHITECTURE-SPINE.md (status draft, updated 2026-10-14)
lens: construct two units one level down that obey every AD to the letter and still build incompatibly
inputs: ARCHITECTURE-SPINE.md, ../decisions.md (D1-D27), ../ACs.md, ../ux/EXPERIENCE.md, architecture/.memlog.md,
  packages/opencode/src/task/** and packages/tui/src/task-ui/** at 6c22d9e0e9,
  test/task-harness/conformance.test.ts (H1-H16), @jambudipa/xstate-effect 0.2.0 dist/Actor.d.ts and ActorRef.d.ts
date: 2026-10-14
---

# Adversarial review — task-harness-feedback architecture spine

## Verdict

The spine fixes the lifecycle well (AD-1 to AD-7 are tight), but the live shell (AD-8 to AD-12, AD-18) leaves the
seams between the Recorder, the run actor, the supervisors, the session hooks and the background job open enough that
letter-obeying units break three acceptance paths: crash-resume (H8, AC 29), subtree trust (D13, AC 15) and the final
status write (AC 10, AC 18). Do not freeze the spine until the three critical rules below land.

Counts: 3 critical, 7 high, 12 medium, 9 low. Each finding names the two units, quotes the AD text each unit obeys,
shows the clash, and proposes the rule that closes it.

The spine's Deferred section says: "AD-8 fixes the ownership, so the wiring cannot diverge in what it does." Findings
C3, H1 and H2 refute this: the wiring choice (subscription callback, invoked stream, action-side record) changes what
the units do, because of the port's documented `send` semantics.

---

## Critical

### C1 — A resumed builder session has no index entry, so every hook from it is dropped

**Units:** task supervisor (`core/supervise/task.ts`) and the harness root session index (`core/harness.ts`), against
`core/hooks.ts` + `session/prompt.ts`.

- The supervisor obeys AD-11: "A supervisor adds an entry when it creates a harness child session."
- The hooks obey AD-11: "A session with no owner is not watched. For that session, the tool records nothing and says
  so."
- The resume obeys AD-6: "A resume folds the latest slice, then records `run.resumed`", and AD-8: the run supervisor
  "spawns a task supervisor for each task tagged `ready` or `active`".

**Clash.** The builder session is created once, by `begin`, and is "kept across attempts" (`core/model.ts`,
`TaskModel.session`; `task.started.session`). After a server restart, the harness root is new and its index is empty.
The respawned task supervisor for a `building` task reuses `task.started.session`; it does not create it, so by the
letter it adds no entry. The builder's `task_ready` is then dropped ("records nothing"). The supervisor sees an idle
turn with no `ready`, spends both nudges, then records `task.ready` + a failed `task.proved`
(`the builder ended without task_ready`) and starts attempt 2.

**Concrete failure.** Conformance H8 ("crash and resume") kills the server while T1.3 builds and requires
`attempts === 1` for every leaf at the end (`happyEnd`, `conformance.test.ts`). Under the letter of AD-11, T1.3 ends with
attempts 2. AC 29 (the quality gate) fails, and every real resume burns paid attempts. Today's code avoids this only
because `build()` calls `TaskHooks.watch(session, …)` on every build ("the runner re-registers the sessions it
resumes", `core/hooks.ts` header).

**Second clash in the same seam.** AD-8 makes `begin`, `verifierRound` and `scenarioJudge` stateless workers, and today
those are the code paths that create the sessions (`begin`, `round` in `core/runner.ts`). "A supervisor adds an entry
when it creates" then has no actor that both creates the session and owns the index write. If the worker creates the
session and returns its id after the prompt starts, the hooks of the first turn arrive before the entry exists.

**Proposed rule (replace the AD-11 index bullet):**
> The owner registers a session in the index before the first prompt of every turn it runs in that session, whether
> the session is new or reused (a resumed builder, a respawned supervisor). Registration is a root event
> `session.claim { session, owner, watch }` that the worker awaits before it calls `Ops.prompt`. The harness root
> removes every entry whose owner belongs to a run when it removes `run:<runID>`. A test resumes a `building` task
> from stored facts and checks that its first `hook.ready` reaches the owner.

### C2 — A run slice is folded through a plan that did not write it

**Units:** `core/command.ts` (AD-15 trust read and the resume decision) and the run supervisor + Recorder (writers of
slices for subtree plans), through the engine fold.

- The command obeys AD-15: "The command reads the trust of each such task by folding the stored run slices through
  the full-spec machine (AD-6)", with "[ASSUMPTION] Such a task counts as trusted when the latest slice that moved it
  left it trusted."
- The run supervisor obeys AD-15: "If such a task is trusted, the run records `outside.trusted` for it directly after
  `run.started`", and AD-6: "A resume folds the latest slice, then records `run.resumed`."
- The fact schema obeys AD-10: "each of the 16 existing fact types keeps its shape" — `run.started` carries only
  `base?`.

**Brownfield fact the spine does not state.** `runID(directory, specPath)` hashes the spec folder, not the `/task`
path (`core/events.ts`). A whole-spec run and every subtree run of that spec share one aggregate, and their slices
interleave in it. No slice records which plan (path) wrote it.

**Clash 1 — legitimate run refused.** The user runs `/task spec/T1.1-…`, then `/task spec/T1.2-…` (T1.1 is an external
region there; its trust is recorded as `outside.trusted { id: "T1.1" }`), then `/task spec/T1.3-…` (after T1.2). The
command folds the T1.2 slice through the full-spec machine. In that machine T1.1 is a task region with no facts in
that slice, so T1.2 never leaves `waiting`, and `task.started` for T1.2 is ignored. "The latest slice that moved it" is
none. The command refuses T1.3 although T1.2 is trusted and merged. D13 and AC 15 fail on the normal subtree workflow.

**Clash 2 — the trust fact is never written on resume.** A whole-spec slice is unfinished (server stopped). The user
types `/task spec/T1.2-…`. `running(runID)` is false, the latest slice is not ended, so the run resumes it under the
T1.2 subtree plan and records `run.resumed`. AD-15 records the external `outside.trusted` only "directly after
`run.started`", so it is never recorded. T1.2 waits for ever on the untrusted external region T1.1, and the TUI tells
the user to type `/task trust T1.1` (see H7).

**Proposed rule (new AD-6 bullet, AD-15 rewrite):**
> A slice is bound to the plan that started it. `run.started` gains an optional `path` (additive; a stored slice
> without it is a whole-spec slice). A resume happens only when the stored slice's `path` equals the new `/task`
> path; otherwise the command starts a new slice. Every reader folds a slice through `machine(plan(slice.path))`,
> never through another plan. A folder task's trust is read from the latest slice whose plan holds it, as a task
> region or as an external region. The external `outside.trusted` facts are recorded after `run.started` and after
> `run.resumed`.

### C3 — The Recorder's three steps are not atomic under the port

**Units:** the Recorder (`core/recorder.ts`) and the run supervisor (`core/supervise/run.ts`), with the run actor.

- The Recorder obeys AD-9: "`record(fact)` holds the Recorder's single permit while it does three steps in order: it
  publishes the fact …, sends the fact to the run actor, and writes `status.json` from the run actor's snapshot."
- The run supervisor obeys AD-8: it owns "the run wall clock, as a delayed transition", and AD-10: `run.ended` is
  emitted by "run supervisor: run wall clock (`failed`)". The same holds for `run.started`, `run.resumed`,
  `outside.trusted` and the forwarded trust.

**Port semantics (`dist/Actor.d.ts`, `send`):** "From outside every actor's processing, a send to a running actor
completes after the event's macrostep commits … A send made from inside an actor's processing or callbacks, or before
`start`, only queues the event. A send to a stopped, done or errored actor is dropped with the upstream warning."

**Clash 1 — the final status is never written.** The natural, letter-obeying implementation of "the run wall clock, as
a delayed transition" records `run.ended` in the transition's action. That call runs inside the supervisor's
processing, so the Recorder's `send` only queues. Step 3 then writes `status.json` from the snapshot before the stop.
No later fact follows, so `status.json` says `running` for ever, while the run actor is `done` and the summary fires.
The same lag hits any record made from a `subscribe` callback, which the Deferred section allows as the wiring.

**Clash 2 — a fact stored but not folded.** Today's `record` is `Effect.uninterruptible` ("so the folded state never
lags a stored fact", `core/runner.ts`). AD-9 drops that word. In the actor design, task supervisors are stopped (and
their workers interrupted) whenever their unit leaves the supervised tags, which happens right after other units'
records (`run.cancelled`, a wall-clock `task.failed`). A worker interrupted between publish and send leaves a fact in
the store that the live run actor never saw. AD-5's own invariant ("the live run actor (`send`) and the fold (`apply`)
agree") breaks until the next resume.

**Proposed rule (AD-9):**
> `record` is uninterruptible from its first step to its last. It is called only from a worker fiber (a `fromEffect`
> or `fromStream` body) or from a plain Effect outside every actor, never from an action, a guard, a delayed
> transition or a `subscribe` callback. A supervisor that must record (the run wall clock, start-up, trust) invokes a
> one-shot `record` worker. After the send, the Recorder checks that the snapshot's `log` grew or that the fact was a
> no-op, and only then writes `status.json`. A test records `run.ended` from the run wall clock and reads `status.json`.

---

## High

### H1 — Unit supervisors act on a phase the run actor has already left

**Units:** task supervisor (and scenario supervisor) against the run supervisor and the machine generator.

- Task supervisor obeys AD-8: "A unit supervisor never reads the run actor to choose its phase", and it learns its
  phase only from "`unit.moved { unit, state, tags }`", sent by the run supervisor "on each snapshot change".
- The machine obeys AD-7: an active task phase takes "the stall, repetition, nudge, `needs_human` and `failed` facts"
  — the alphabet does not tie a fact to the phase that emitted it.

**Clash.** The `builderTurn` worker records `task.ready`; the run actor moves the task to `proving`; the run supervisor
forwards `unit.moved` asynchronously. In that window the task supervisor still holds `building`. Its `after:
streamIdle` stall transition, its spend-cap guard or its task wall clock can fire and record `task.stalled`,
`task.needs_human` or `task.failed` against a task in `proving` or `verifying`. If the generator accepts those facts in
every active phase (AD-7 allows that reading), a task whose merge already passed can be recorded `failed`: the base
branch holds the merge, and the cascade blocks the dependants of code that is merged. AD-7's supervisor test ("For a
unit in a given state, a supervisor records only facts in this alphabet") cannot catch this, because the supervisor
does not know the given state.

**Second clash — invisible same-state moves.** "On each snapshot change … sends `unit.moved`" does not say how the run
supervisor finds the units that moved. A diff of `snapshot.value` misses `building → building` (`task.repeated`,
`task.nudged`, `task.stalled`) and the `verifying → judging → verifying` settle that AD-13 says happens within a
macrostep. A supervisor that restarts work only on a phase change then never starts the next verifier round.

**Proposed rule (AD-8 and AD-10):**
> Every unit fact that a unit supervisor records carries `from`, the machine state key the supervisor acted in. The
> generator accepts a unit fact only when the unit is in `from`; otherwise the fact appends no entry (AD-5) and
> changes nothing. `unit.moved` is sent once for every history entry of the unit (not for a value diff) and carries
> the entry's index; the supervisor starts the phase's worker again on every new index. No delayed transition of a
> task supervisor fires while a `merge` worker runs.

`from` is an additive optional field; a stored fact without it is accepted as today.

### H2 — The normal end can stop the run supervisor before the summary is written

**Units:** the background job body and finalizer (`core/command.ts` / the job's Effect) and the run supervisor's
`summary` actor.

- The job obeys AD-8: "The run supervisor lives exactly as long as its background job, whose finalizer stops it."
- The supervisor obeys AD-18: "When the run actor's snapshot status is `done`, the run supervisor invokes the `summary`
  actor once."

**Clash.** The spine defines the cancel order (AD-18) but not what the job body awaits on a normal end. A job body that
awaits the run actor's `done` (the obvious `waitFor`) completes in the same instant the summary starts. Its finalizer
then stops the run supervisor and interrupts the `summary` actor, so AC 20 fails on every run that ends by itself.

**Related lifetime clash.** AD-18 says "The Recorder's scope outlives the run supervisor", and AD-8 says the run
supervisor owns "the reference to the run actor". If the run actor lives in the supervisor's scope, a record after
the supervisor stops is published and then dropped by the stopped actor (port: "A send to a stopped … actor is
dropped"). That is the "fact stored but not folded" that AD-9 claims to prevent.

**Cancel-path clash.** On cancel the user aborted the root session (`watch.tsx` stop → `session.abort`). AD-18 then
calls `Ops.say` into that same root session; the spine does not say whether `say` runs while the root's own prompt
loop is cancelling, or while the user has a turn in flight there. An assistant message appended in the middle of the
root's own turn can end that turn early: the prompt loop exits when the newest assistant message has a final `finish`,
no tool calls, and the latest user message as its parent (`session/prompt.ts`, the "exiting loop" branch). If `say`
uses any other parent, the next model step of that turn sees the summary as the newest assistant message instead.

**Proposed rule (AD-8, AD-18):**
> The job body awaits the run supervisor's own final state `closed`. The supervisor enters `closed` only after the
> `summary` actor succeeds, or fails, or exceeds `limits.cancelDeadline`. The run actor and the Recorder share one run
> scope, which the job opens before it spawns the supervisor and closes after the supervisor stops. `Ops.say` queues
> behind the root session's own turn (the session's prompt lock), uses the run header message as its parent, and
> survives a root abort.

### H3 — Directory resources have one owner per run, but the directory has one file and one checkout

**Units:** two Recorders (two runs in one directory), and `command.ts`'s refusal writer, against the TUI view machine;
and workers of two runs against the root checkout.

- Each Recorder obeys AD-9: "Each run has one Recorder … writes `status.json`."
- The command obeys AD-13: "`status.json` is `project(plan, snapshot)`, or the command's refusal form."
- The command obeys AD-8: `running(runID)` is per runID, and runID is per spec folder.

**Clash 1 — two writers of one file.** `status.json` is `<directory>/.opencode/task/status.json`, one per directory
(`TaskStatus.file`). Two specs can run at once in one directory; each Recorder rewrites the file after each of its
facts, so the TUI flips between two runs every second. Worse, D12's own scenario breaks it: the user edits the spec so
that it no longer validates, then types `/task <spec>` again. The command refuses (the `Blend.load` refusal comes
before the `running` check in `command.ts`) and writes the refusal form over the live run's file. The TUI's
`liveness` goes `ended` (`refused` is `ended`), the diamond stops, then the next fact of the live run flips it back.

**Clash 2 — locks scoped to the wrong owner.** The spine says "`Semaphore` only for resource locks" but names no owner
for the `checkout` and `git` locks that today live in the `Run` record. A worker author who creates them per worker or
per run gets no mutual exclusion between a `merge` (task supervisor) and `scenarioProof` (run supervisor), or between
two runs that merge into the same root checkout. D12 makes the effect visible: `staleCheck` reads the spec folder of
the root checkout mid-merge and records a transient `spec.checked` failure, and the user sees a warning toast that
clears on the next check.

**Proposed rule (new AD, "directory resources"):**
> The harness root holds one directory lease per directory: at most one live run per directory (the command refuses a
> second with a plain message), the root-checkout and git locks, and the only writer of that directory's
> `status.json`. A refusal never replaces the file of a live run: while a run is live in the directory, the command
> answers in the session only. `staleCheck` reads the spec under the checkout lock.

### H4 — Two `/task` commands can both start the same run

**Units:** `command.ts` (the `running` check) and the harness root (the spawn of `run:<runID>`).

- The command obeys AD-8: "`running(runID)` is true when `system.get("run:<runID>")` is `Some`."
- The harness root obeys AD-8: it "spawns one run supervisor for each live run, when `/task` starts or resumes the
  run", and the job's finalizer stops it.

**Clash.** The check and the spawn are separate steps with a background-job start between them. Two quick commands
(double submit, two TUI clients on one server) both see `None`, both start a job, and both resume or start the same
slice. Two Recorders then publish to one aggregate with two permits, so the store order and each actor's order differ
— the exact fault AD-9 lists under "Prevents". A duplicate systemId is a warning in xstate, not a refusal.

**Proposed rule (AD-8):**
> The command claims the run with one root event, `run.claim { runID } → claimed | busy`, before it starts the
> background job. The root registers `run:<runID>` in the same macrostep. Only a claimed command starts the job.

### H5 — The stale check records facts before the supervisors hold the new spec, and the obligation sets can drift

**Units:** the `staleCheck` worker and the run supervisor (spec owner), against the task supervisor and its `proof`
worker.

- `staleCheck` obeys AD-10: `obligation.stale` is emitted by "`staleCheck` (run supervisor)".
- The run supervisor obeys AD-12: "The current spec … is in the run supervisor's context. Only a stale-check reload
  that validates replaces it. Unit supervisors get it when they are spawned, and in a `spec.reloaded` event."

**Clash 1 — order.** The worker records `obligation.stale` inside its Effect (as `checkStale` does today). The run actor
moves the trusted task to `proving`; the run supervisor spawns its task supervisor with the spec in its context, which
is still the old one, because the worker has not returned. The `proof` worker proves the obligation against the old
text. The machine already holds the new hash from the stale fact, so the next stale check sees no change, and the
obligation ends trusted on text that the user replaced.

**Clash 2 — sets.** AD-12 fixes the plan and lets a valid reload replace the spec. Today's `proveLeaf` proves
`spec.obligations` of the current spec. A valid edit that adds or removes an `ensures` entry makes the proof results
and the machine's obligation regions disagree: a removed obligation stays in the machine and is never proved again,
so its task can never become trusted, and the builder loops to `budget_exhausted`. The graph proof (AD-7), built on
the fixed plan, cannot see this.

**Proposed rule (AD-12):**
> `staleCheck` records nothing. It returns `{ spec, stale[], failures }`. In one transition the run supervisor first
> assigns the new spec and sends `spec.reloaded`, then invokes a `record` worker for the facts. Workers prove and judge
> exactly the plan's obligation ids; the current spec supplies only the texts and hashes of those ids. A reload that
> adds or removes an obligation id of the plan is a `spec.checked` failure, and the run keeps the old text for it.

### H6 — `prompt.ts` must reach the harness root, but no allowed path exists

**Units:** `core/hooks.ts` + `session/prompt.ts` against the harness root service and the D9 audit.

- hooks.ts obeys AD-11: "`TaskHooks` keeps only its constants, `shellEnvironment`, and stateless functions. Each
  function resolves the owner through the index and `system.get`, then sends …"
- The audit obeys AD-17: "Each … module-level `let` … goes", and the allowlist is closed.
- The harness obeys AD-18 and the spine diagram: "The harness never imports `SessionPrompt`; it receives `Ops`."

**Clash.** A stateless function needs the root actor to call `system.get`. It cannot hold the root in module state
(the audit fails AC 11). `SessionPrompt` cannot depend on `TaskHarness` as a layer, because `TaskHarness` runs prompts
through `Ops`, which `SessionPrompt` implements (the cycle that `command.ts` already documents: "`SessionPrompt` cannot
depend on the harness layer-wise"). The tool `execute` in `createTaskHarnessTools` is plain JS, not an Effect.
`TaskHooks.watching(sessionID)` is read synchronously in the prompt loop. Two implementers will diverge: one adds a
module-level root handle (fails the audit), the other threads the root through `createTaskHarnessTools` and the loop.

**Proposed rule (AD-11):**
> `TaskHarness` is a service of the app runtime with no dependency on `SessionPrompt`. `SessionPrompt` resolves it with
> `Effect.serviceOption` at each turn (as `command.ts` resolves its environment) and passes a `HarnessHooks` value
> (`claimOf(session)`, `send(event)`, `repeated(session)`) into `createTaskHarnessTools(agent, sessionID, hooks)` and the
> repetition check. hooks.ts functions take that value as an argument. No module of `src/task/` holds a reference to
> the root.

### H7 — External folder dependencies are `outside` regions, so the TUI and the trust path accept a hand-written trust

**Units:** the machine generator and the projection, against the TUI view and the `/task trust` forwarding path.

- The generator obeys AD-1: `active` has a region for "each external folder dependency (AD-15)", with `meta.kind` in
  "`task | obligation | scenario | outside | run`" — no other kind exists for it.
- The projection obeys AD-13: "`waitingOnOutside` is `waitingOn` filtered to the keys of `outside`."
- The TUI obeys AD-16: an untrusted `outside` key "shows the D4 hint `waiting on <id> (outside) — run /task trust <id>`".
- The run supervisor obeys AD-8: it "records `outside.trusted` when its machine has an untrusted region `<id>`".

**Clash with a binding decision.** D13: "The command learns trust by folding the stored facts through the run machine,
not from a hand-written set." With the units above, whenever an external region is untrusted (the window before the
start-up fact, or C2's resume case), the board tells the user to type `/task trust T1.1`, and if they do, the
forwarded trust trusts a folder task by hand. The spine itself states the goal in AD-15 ("Prevents: … a trust read
from a set written by hand") and then provides the hand path.

**Proposed rule (AD-1, AD-13, AD-8):**
> An external folder dependency has its own kind, `external`. Its region takes `outside.trusted` only from the run
> supervisor's start-up derivation (C2), never from a forwarded `/task trust`. The status file lists it under a
> separate `external` map, which `waitingOnOutside` and the trust hint never read. Its hint is "waiting on T1.1 (outside
> this run) — run the whole spec, or a folder that holds T1.1".

---

## Medium

### M1 — `liveness: still` and the D4 live wait read the same silence differently

- TUI obeys AD-16: `liveness` "is `still` when the status is not ended and nothing moved within the window" (300 s).
- The run obeys D4 and AD-4: a run that waits on an outside precondition is `waiting`, "a live state that one event
  can move, not a stuck one".

**Clash.** A run that waits for `/task trust T9` records no fact and runs no session, so after 300 s it reads `still`,
the same as a dead server. EXPERIENCE says "The run does not end; the diamond keeps animating". If the owner answers
the AD-16 open question "yes, stop in `still`", the diamond of a healthy waiting run stops.
**Rule:** liveness reads whether the root session owns a live `task-harness` background job (the server knows), not
freshness. `still` = status not ended and no live job. The 300 s window goes.

### M2 — `run.reason` is one line in the machine and many lines in the TUI

- Machine obeys AD-4 row 2: dead and blocked tasks "joined with `; `".
- Projection and TUI obey the spine's own convention ("a list of failures joins lines with `\n`") and EXPERIENCE:
  "Run | Reason, one line for each dead or blocked task", read as "the first line … then (+N more)".

**Clash.** The TUI never shows "(+N more)" for an outcome and cuts one long line. **Rule:** every list-valued reason,
outcome reasons included, joins its items with `\n`; AD-4 rows 2 to 4 use one line per item.

### M3 — Two formats for one refusal

- `command.ts` obeys AD-14: each failure is "`<rule> <path>: <message>`" and "The refusal session message and
  `run.reason` carry the same text"; the D13 line is "`R12 <folder>: <task id> is after <other id>, which is outside
  this run and not trusted`".
- The transcript design obeys EXPERIENCE: a header line "Refused <path>: 3 failures. No work started.", D13 lines
  "T1.2 is after T1.1" and a hint line "Run the whole spec, or a folder that holds T1.1"; git refusals with no rule.

**Clash.** Whichever the command writes, either AD-14 or the UX contract (AC 12, AC 15) fails, and the TUI's "every
failure line" either does or does not include the header. **Rule:** `run.reason` holds only the failure lines in the
AD-14 format; the session message is one header line, then exactly `run.reason`, then an optional hint line. A failure
with no rule uses the rule `R0`. EXPERIENCE is amended to the AD-14 line text.

### M4 — The tag vocabulary cannot separate TRUSTED from STOPPED, so the display table classifies

- Views obey AD-16: "The only table keyed by state names in `task-ui` is the display table (state to glyph, tone and
  board column). Presentation reads that table: glyph, colour, board column, the severity sort order and counts by
  tone."
- EXPERIENCE: "A trusted task goes to TRUSTED. Every other task goes to STOPPED, whatever its tags", and the stopped
  count "is the number of tasks in the STOPPED column".

**Clash with D16** ("The task-ui classifies units only from the `status.json` tags"). `trusted` and `cancelled` both
carry only `ended`, so the board column, the STOPPED membership and the stopped count are a classification by state
name, the role of the old `ENDED` list under a new name. A new engine state silently lands in a default column.
**Rule:** add the class tag `stopped` (ended and not trusted) for tasks and scenarios. Board column = `waiting` →
WAITING; `active` → the phase column (state used only as a display key); `stopped` → STOPPED (groups by `dead`,
`blocked`, other); `ended` without `stopped` → TRUSTED.

### M5 — The Gantt reads spans that never close, and the UX reads start and end

- Machine obeys AD-5: "Each later move of the task closes its open span … and opens the next one" — the span of a
  final state has no later move, so it stays open.
- Gantt obeys AD-16: "The Gantt draws each task's lane from `tasks[].spans`. An open span runs to `now`. Before a
  task's first span, the lane is blank."
- EXPERIENCE (final, older than the span decision): lanes from start and end times; "cells after the end are blank";
  "░ before the start".

**Clash.** A trusted, blocked or dead task's lane keeps growing to `now` in the Gantt, against the UX rule. Per AD-5 every
task has a span from `run.started`, so "blank before the first span" contradicts "░ before the start". **Rule:** a move
into an `ended`-class state closes the open span and opens a span with `to = from`; the Gantt draws nothing after
`endedAt`. EXPERIENCE's Gantt lane is re-stated over `spans` (it answers its own Open Question 3).

### M6 — The status contract has two schemas and no shared test

- Projection obeys AD-13 in `core/status.ts`.
- TUI obeys "`packages/tui` never imports `packages/opencode`" and keeps its own `Status` schema (`task-ui/store.ts`,
  today `Reason = NullOr(String)`, states as open strings "so a state the harness adds later still renders").

**Clash.** A TUI author who decodes `tags` as the closed AD-13 literal set makes one added tag (M4 adds one) fail the
whole parse, and AD-16's feed then "keeps the last status" for ever. Old `status.json` files from before the change
(no `tags`, no `title`) also stop parsing. **Rule:** the TUI decodes `state` and `tags` as open strings and ignores an
unknown tag; every new field is optional on read. A committed fixture, written by `project` in an opencode test, is
decoded by the TUI schema in a TUI test.

### M7 — `unit.moved` has no defined field meanings

- Run supervisor obeys AD-8: it sends "`unit.moved { unit, state, tags }`".
- Supervisors obey AD-1: `meta.state` is "the status-contract name", in which task `ready` shows as `waiting` and
  scenario `ready` and `verifying` both show as `pending`.

**Clash.** If `state` is the contract name, a scenario supervisor cannot tell `ready` from `verifying`, and a task
supervisor cannot tell `waiting` from `ready`. If `tags` keep the `<unit>:` prefix in one unit and lose it in another,
the guards miss. **Rule:** `state` is the machine state key; `tags` are the unit's own class and phase tags without
the prefix; supervisors branch only on phase tags.

### M8 — "The run's sessions" differ between the summary, the TUI and a resumed run

- Summary obeys AD-18: "the summed tokens and cost of the root session's child sessions".
- TUI obeys D24 and EXPERIENCE: the children of the root on screen, `owns` = the session owns harness sessions.

**Clash.** A resume from a new root session (`start.root` is "the root session of the latest `/task`") reuses the old
builder session, whose parent is the old root: both readers miss its cost. Two runs in one root session sum each
other's cost. **Rule:** one shared query, `runSessions(root, slice)`: the root's children created at or after the
slice's `run.startedAt`, plus the sessions named in the slice's `task.started` facts.

### M9 — The verifier round needs the verdicts mid-worker, but they live in the owner

- Owner obeys AD-11: "The owner holds `ready`, `verdicts`, … in its context."
- Worker obeys AD-8: workers "hold no state", and only "a worker that needs a wider view reads the run actor's
  snapshot".

**Clash.** Today's `round` asks again in the same session for the ids the judge skipped, which needs the verdicts of
the first ask inside the worker. The verdicts are in the owner, not the run actor. **Rule:** the round is a sub-state
of the owner (`ask → collect → askMissing → collect`); the worker runs one prompt and returns; the owner clears
`verdicts` at the start of each ask.

### M10 — The D9 allowlist is closed, but the proof module has a polled loop

- Audit obeys AD-17: "The audit expects only these entries".
- The `proof` worker uses `proof/process.ts`, whose `awaitGroupGone` is `while (yield* signalGroup(pgid, 0)) yield*
  Effect.sleep(pollInterval)` — a polled loop (D9 names "polled loop") with no entry.

**Clash.** The audit fails on unchanged worker code, or the worker author rewrites process-group teardown. **Rule:**
add the entry `awaitGroupGone` (`proof/process.ts`, bounded by `Effect.timeoutOption`, no lifecycle state), or state
that the audit scans only `core/`, `engine-xstate/` and `task-ui/`.

### M11 — Callers stamp `at`, the Recorder orders, and the two can disagree

- Callers obey the convention "`at` in epoch ms from `Clock.currentTimeMillis`" (taken before `record`).
- The machine obeys AD-5 ("`at` is the `at` of the fact that triggered the macrostep") and AD-4 row 2 ("the state of
  the earliest such entry in the history").

**Clash.** Two workers stamp t=100 and t=101 and take the permit in the other order: the history is not monotonic, a
span can end before it starts, and "earliest" by `at` differs from "earliest" by position. **Rule:** the Recorder
stamps `at` inside its permit; callers pass a fact without `at`.

### M12 — Trust can land before `run.started` or between the start-up read and registration

- Run supervisor obeys AD-10 (`outside.trusted` "at start for each directory-recorded id … and on a forwarded
  trust") and AD-8 ("The harness root forwards it to every run supervisor").

**Clash.** A forwarded trust processed before the supervisor records `run.started` lands in the previous slice and is
lost from this run's fold, while the live actor took it (send and fold disagree after a restart). A trust published
after the start-up read of the directory aggregate and before the supervisor is registered reaches neither path, and
the run waits for ever. **Rule:** the supervisor's first state records `run.started`/`run.resumed` and defers every
other event; it is registered before it reads the directory aggregate; the region ignores a second trust.

---

## Low

- **L1 — AD-4 row 3 changes D3's outcome rule.** D3: "`done` when every task is trusted, otherwise the state of the task
  that died first". AD-4 row 3: all tasks trusted and a scenario `failed`/`rejected` gives `failed`. The spine marks it
  [ASSUMPTION]; it contradicts D3's text and needs the owner's word, not a note.
- **L2 — AD-13 contradicts itself.** "no task title is in the file" vs `run.task?: { id: string; title: string }`.
  State that `run.task.title` is the one task title in the file.
- **L3 — `run.warning` means "now" in the TUI and "during the run" in the summary.** AD-12 clears it on a valid reload;
  EXPERIENCE's summary line says "The spec stopped validating during the run". The summary must read the slice's
  `spec.checked` history entries, not `run.warning`.
- **L4 — "Fixed. It never changes again" (EXPERIENCE) vs AD-5's reopen**, which clears `endedAt` and restarts
  `startedAt`. The summary's task time then shows only the last reopen. State which one D21 means.
- **L5 — System ids are reused across slices.** `run:<runID>` and `task:<runID>:<taskId>` are per spec folder, so an
  index entry left from slice N resolves to slice N+1's supervisor. C1's rule (root removes by run) closes it; also
  add the slice start `at` to the ids.
- **L6 — A summary is lost when the server stops between the final fact and `say`.** The next `/task` sees an ended
  slice and starts a new one. Accept it in writing, or let `/task` on an ended slice with no summary entry write it.
- **L7 — The phase-1 merge into `dev` (D26) cannot read phase-2 facts.** A demo folder that ran phase-2 code holds
  `task.nudged`/`spec.checked`; `dev` at phase 1 fails to decode the aggregate (`FactSchema` is the validation
  boundary). Decide the Deferred "fact schema version" before D26's first merge, or decode unknown fact types as
  skipped.
- **L8 — D1 and D6 shapes differ from the spine.** D1: "Its root `active` state is `type: "parallel"`" vs AD-1's root
  `{ active, outcome }`; D6: the run supervisor "invokes the builder, verifier, proof and stale-check actors" vs AD-8's
  task supervisor. Both are memlog assumptions; get the owner's sign-off, because AC 2 and AC 8 quote the D text.
- **L9 — "id order" is not defined.** AD-1 orders scenario regions "in id order"; EXPERIENCE uses natural order
  (`S2` before `S10`). Region order sets microstep order, history order and AD-4's "earliest entry" for simultaneous
  moves. Use the natural collator (`byId` in `task-ui/store.ts`) everywhere.

---

## ADs that contradict or weaken a binding decision

| AD text | Decision text | Finding |
| --- | --- | --- |
| AD-15 + AD-1 + AD-8: external dependencies are `outside` regions; the root forwards `/task trust <id>` and the supervisor records it "when its machine has an untrusted region `<id>`" | D13: "The command learns trust by folding the stored facts through the run machine, not from a hand-written set." | H7, C2 |
| AD-15: "folding the stored run slices through the full-spec machine" | D13 (same sentence): trust through "the run machine" — the machine of the run that recorded the slice | C2 |
| AD-16: the display table sets "board column, the severity sort order and counts by tone" | D16: "The task-ui classifies units only from the `status.json` tags (D8)." | M4 |
| AD-4 row 3: all tasks trusted + a failed scenario → `failed` | D3: "`done` when every task is trusted" | L1 |
| AD-10: no idle fact; after the last nudge, `task.ready` records a turn that did not signal ready | D7: "It records each decision (stall, spend cap, idle, nudge) as a fact." | Low: `task.ready` gains a second meaning; name it in AD-10's reason text at least |
| AD-1 root `{ active, outcome }`; AD-8 task supervisor invokes the builder | D1 root `active` parallel; D6 run supervisor invokes the builder | L8 |

No AD weakens D2, D4, D5, D8, D9, D10, D12, D17, D18 or D24 in its text. D18, D21 and D24 are weakened in effect by
H2, L4 and M8.

## Order of work

1. Land C1, C2 and C3 as AD amendments; each has a one-line test named in its rule.
2. Land H1 (`from` on unit facts) and H2 (`closed` state) before any supervisor code; they set the supervisor shape.
3. Land H3 and H4 together as one "directory lease" AD in the harness root.
4. Re-issue EXPERIENCE.md sections for M2, M3, M5 and the Gantt, so the UX and the spine read one contract.
