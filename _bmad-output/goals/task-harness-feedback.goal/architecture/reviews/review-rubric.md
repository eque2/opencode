# Rubric review: ARCHITECTURE-SPINE.md (task-harness-feedback)

- **Reviewer:** the rubric walker (the good-spine checklist, items 1–8)
- **Spine:** `architecture/ARCHITECTURE-SPINE.md`, 707 lines, status `draft`, dated 2026-10-14. All line numbers below refer to it.
- **Inputs read:** `decisions.md` (D1–D27), `ACs.md`, `plan.md`, `task-questions.md`, `ux/EXPERIENCE.md`, `architecture/.memlog.md`.
- **Code read:** `packages/opencode/src/task/**`, `packages/opencode/src/session/{prompt,run-state,status}.ts`,
  `packages/opencode/src/effect/runner.ts`, `packages/opencode/test/task-harness/conformance.test.ts`,
  `packages/tui/src/task-ui/**`, and the installed port source
  (`node_modules/.bun/@jambudipa+xstate-effect@0.2.0+…/src`). I checked the versions against the npm registry on 2026-10-14.

## Verdict

The spine is **not ready to bind [CS]**. The machine shape, finality, cascade, outcome, fact list and status contract
are fixed well. But the spine did not probe one port behaviour: SD-23 send semantics. That behaviour breaks two
load-bearing rules (AD-9 Recorder, AD-11 repetition stop). The spine also leaves these points open: the phase-1
checkpoint seam, `task.failed` while a task is `ready`, and the task-ui reads that are not the 1 s feed. One AD
overrides D3's text as an assumption. Fix the one critical item and the five high items. The other items are edits.

## Checklist

| # | Item | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Fixes the real divergence points and misses none | **Fail** | It misses the send semantics inside actors (C1), the phase-1 seam (H1), the `ready` failure path (H3), the task-ui reads other than the feed (H4), how the hooks reach the harness (M8), the D24 sum (M2) and the two copies of the status contract (M3). |
| 2 | Each Rule can be enforced and prevents its divergence | **Partial** | Most Rules can be tested. AD-9 and AD-11 do not prevent their stated divergence under the port (C1). AD-11 "creates" lets a resumed session lose its owner (H5). AD-17 is incomplete (M4). The soundness of AD-7's reduction has no test (M6). |
| 3 | Nothing in Deferred lets two units diverge | **Partial** | "Supervisor wiring" (694–696) decides whether sends wait, so it is part of C1. "D24 internals" (702) leaves the sum that the TUI and the summary share open (M2). The other deferrals are safe. |
| 4 | Named tech is verified-current | **Pass, with notes** | Every Stack row matches the root catalog. The port 0.2.0 and XState 5.33.2 are the npm latest. effect 4.0.4 exists, but the 4.0.3 pin is kept, which is correct. The graph API is as AD-7 says. The send semantics were not verified (C1). See L1. |
| 5 | Ratifies the brownfield code | **Pass, with gaps** | Most line and symbol claims hold (see "Claims checked"). The gaps are the task-ui reads other than the feed (H4), session reuse (H5) and a polled loop in `proof/process.ts` (M4). |
| 6 | Covers the decisions and contradicts none | **Partial** | One conflict: AD-4 row 3 against D3 (H2). One narrowing: AD-7 against D5 and AC 6 (M6). One wording gap: AD-8 against D6 and AC 8 (L7). The other D1–D24 capabilities have an owner. |
| 7 | Every dimension is decided, deferred or an open question | **Partial** | The operational envelope is in Deferred (703–706). The phase-1 interim state is missing (H1). The owner questions are scattered or left only in `.memlog.md` (M7). Compatibility with older builds is weak (L9). |
| 8 | Terse build substrate | **Partial** | The Rules are mostly decisions. About 15% is rationale or duplication that can go with no Rule lost (L8). |

## Critical

### C1: A read after a send fails inside actors (port SD-23), and AD-9 and AD-11 depend on that read

- **Location:** AD-9 (311–322); AD-11 (376–378); Deferred "Supervisor wiring" (694–696).
- **Evidence:**
  - Port `src/Actor.ts:244–250`: "From outside every actor's processing, a send … completes after the event's
    macrostep commits … A send made from inside an actor's processing or callbacks … only queues the event." `deliver`
    (`Actor.ts:1177–1183`) queues and returns when `ProcessingActors` is not empty.
  - A `fromEffect` worker runs its Effect in a fiber that is forked inside its own `start`
    (`actors/fromEffect.ts:166–189`, `Effect.forkScoped`). `start` and `logic.start` set `ProcessingActors` to the
    actor (`Actor.ts:1625`, `1691`). A forked fiber inherits that context, so every worker fiber counts as "inside".
  - AD-9 says "Supervisors and workers record facts only through the Recorder" and that `record` "sends the fact to
    the run actor, and writes `status.json` from the run actor's snapshot". When a worker or a supervisor action
    records, the send only queues, so the status write reads the snapshot from before the fact. The fact that makes
    the outcome final is then never written: `status.json` stays `running` for ever. Conformance H3 waits for
    `s.run.state === "done"` (`conformance.test.ts:304–307`). AC 10 and the critical AC 29 fail. AD-18 reads the
    actor, so the summary and the file also disagree.
  - AD-11: "`prompt.ts` sends `hook.calls`, then ends the turn if the owner's snapshot carries the tag `repeated`."
    The builder's session loop starts from the `builderTurn` worker: `ops.prompt` → `SessionRunState.ensureRunning`
    → `Runner.startRun`, which runs `Effect.forkIn(scope)` (`src/effect/runner.ts:95`, `122–137`). So the loop
    inherits the worker's `ProcessingActors`. The send queues, the tag read is stale, and the turn does not end.
    Conformance H15 (repetition, `conformance.test.ts:755`) is at risk, and AC 9 too.
- **Fix:**
  1. Add to AD-9: "The `TaskHarness` service forks one Recorder fiber outside every actor. `record(fact)` offers the
     fact to it and awaits completion. That fiber publishes the fact, sends it (the send then waits for the
     macrostep), reads the snapshot and writes `status.json`." An equivalent rule: "One status writer consumes the
     run actor's `changes` in a fiber outside every actor. `record` only publishes and sends, under the permit."
  2. Add to AD-11: "The repetition decision is a pure guard that the task-supervisor module exports. `prompt.ts`
     evaluates it on the owner's context and the calls, sends `hook.calls` to record the result, and ends the turn
     on the guard's result." Do not depend on a read after a send.
  3. Move "Supervisor wiring" out of Deferred, as far as it decides where a send is made from.
  4. Add a test: a fact recorded from inside a `fromEffect` worker shows in `status.json`, and a scripted
     repeated-call turn started from a worker ends at the limit.

## High

### H1: The phase-1 checkpoint seam is not defined

- **Location:** the whole spine. The only uses of "phase" are the tag names (90, 223, 411).
- **Evidence:** AC 4 is a phase-1 criterion: "follows is gone and the runner's done decision reads the machine". AC 5
  is a phase-1 criterion: "the readiness check in schedule and the runner's outside trust set are gone". AC 7 merges
  into `dev` when "AC 2–6 and the quality gate pass", and the quality gate includes conformance H1–H16. `plan.md`
  puts D6 (the supervisors) in phase 2. So at the checkpoint, the polled runner still exists but must read the new
  machine. The spine shows only the end state. The phase-1 tasks of [CS] have no Rule for these points:
  - what the old `schedule` reads (the `ready` tags);
  - whether the old loop still records `run.ended done` (AD-10 says it does not);
  - what `status.ts` projects in phase 1, when D8 is phase 2 but AD-6 removes `State` as an input;
  - how `trustActive` and the `outside` set (`runner.ts:96–101`, `859`) map to regions.
- **Fix:** Add "AD-19: phase-1 seam" with these Rules:
  - The runner keeps its loop until phase 2.
  - `schedule` starts a unit only when `tags(snapshot)` carries `<id>:ready`.
  - The loop ends when the snapshot status is `done`, and the runner records no `run.ended done`.
  - `outside.trusted` goes to the machine only, with no set.
  - `status.ts` writes `view(snapshot)` in today's contract shape, plus the state `blocked`.
  - Conformance H1–H16 passes at the checkpoint.
  - The Rule lists what phase 2 then removes.

### H2: AD-4 row 3 contradicts D3

- **Location:** AD-4 (157–159).
- **Evidence:** D3 (`decisions.md:55–57`): "The end-state names stay as they are: `done` when every task is trusted,
  otherwise the state of the task that died first". AC 4 says the same. AD-4 row 3: "If a scenario is `failed` or
  `rejected`, the outcome is `failed` … [ASSUMPTION] This keeps today's `checkDone` rule. It refines AC 4". Take a run
  where every task is trusted and S4 is rejected. D3 gives `done`, and the spine gives `failed`. The spine overrides
  a binding decision as an assumption. The verifier of AC 4 tests the literal D3 text.
- **Fix:** Do not settle this case as an assumption. Move it to an Open Questions section with two options:
  1. Keep `failed`. This needs a D3 amendment.
  2. Follow D3: the outcome is `done`, and the reason and the summary name the rejected scenarios.

  [CS] writes no scenario for this case until the owner answers.

### H3: No Rule says that `ready` takes `task.failed`, and the alphabet leaves it out

- **Location:** AD-2 table (104); AD-7 (221–229, 244–246); AD-8 (277–279); AD-10 (344).
- **Evidence:** AD-8: "After 3 worker failures in a row, the supervisor records `task.failed`". The leaf's `begin`
  worker and the parent's review proof both run while the task is `ready` (AD-10 rows `task.started` and
  `task.proved`). AD-7 gives a `ready` unit only "its start facts", and the supervisor test (246) allows only
  alphabet facts in each state. So a supervisor that records `task.failed` in `ready` fails that test. A generator
  that follows the alphabet gives `ready` no `task.failed` row, and AD-10 says only "to failed". Today `waiting`
  takes `task.failed` (`engine-xstate/index.ts:414`) for exactly this path. If `ready` ignores the fact, the fact
  changes nothing (AD-5). The supervisor has then spent its retries, and the task stays `ready` for ever. This is the
  stuck corner that this goal exists to remove, and the graph proof does not see it.
- **Fix:** In AD-2 or AD-10, write: "`task.failed` and `task.needs_human` move `ready`, `building`, `proving` and
  `verifying` to the state that they name." In AD-7, add `task.failed` to the `ready` alphabet. Do the same check for
  a `ready` scenario batch that fails.

### H4: The task-ui reads other than the feed have no owner

- **Location:** AD-16 (522–525, 533, 536–537); AD-17.
- **Evidence:** Today `poll()` (`Effect.repeat(Schedule.spaced)`, `store.ts:52–63`) reads four sources:
  - the status feed, every 1 s (`index.tsx:72`);
  - the harness sessions, every 2 s (`peek.tsx:73–74`), which feed `owns` and the liveness;
  - the session activity, every 1.5 s (`peek.tsx:75–82`);
  - the proof-log tail, every 500 ms (`watch.tsx:274`).

  AD-16 bans `Effect.repeat`, `Schedule` and `Effect.sleep` in task-ui, and names only the `feed` region. The event
  `sessions.changed { owns, updated }` (533) has no named producer. D9 and AC 11 are CRITICAL. Each builder will
  choose one of three paths: put every read into the 1 s feed (which slows the 500 ms tail), add regions ad hoc, or
  keep the polls and add allowlist entries.
- **Fix:** In AD-16, list each periodic read with its cadence, its region and when it runs:
  - `feed`: status, mtime, logs and clock, every 1 s.
  - `sessions`: the children of `root`, every 2 s. It raises `sessions.changed`.
  - `activity`: the messages of the session that a Peek or a watch shows, every 1.5 s, only while one is open.
  - `tail`: the watched task's proof log, every 500 ms, only while the live proof panel shows.

  Each read is a delayed transition of `taskView`, or of a child actor that `taskView` spawns. A panel reads its
  slice from the view snapshot and has no timer of its own.

### H5: The session index gets an owner only when a supervisor "creates" a session

- **Location:** AD-11 (368–370).
- **Evidence:** "A supervisor adds an entry when it creates a harness child session." A builder session is reused
  across attempts and across a resume (`core/model.ts:42`: "The builder session, kept across attempts").
  `runner.ts:416–419` calls `TaskHooks.watch` at every build, whether it created the session or not. After a restart,
  the index is empty, and the resumed task supervisor does not create the session again. Its `task_ready` and verdict
  calls then find no owner, and "the tool records nothing". The task then goes through nudges to a failed proof.
  Conformance H8 (crash and resume) is part of the quality gate.
- **Fix:** Change the Rule to: "A supervisor adds an entry when it creates or reuses a harness child session, before
  it prompts that session. It removes the entry when it stops."

## Medium

### M1: The `waiting` guard of the run counts obligation states with the `active` class

- **Location:** AD-4 (148–150); the AD-13 class table (467).
- **Evidence:** "The run is `waiting` when no unit is in a state tagged `active` or `ready`". The obligation states
  `passed`, `failed` and `rejected` have the class `active`. Every obligation state is final (AD-2), so the
  obligations of a dead task stay in those states for ever. Take a run whose remaining tasks wait on an `outside`
  precondition that is not trusted. That run shows `running`, not the `waiting` that D4 asks to report, and the
  liveness and counts of the TUI over tags read it wrongly.
- **Fix:** "The guard between `running` and `waiting` reads only task `work` states and scenario states."

### M2: Two units compute the D24 run usage, and no Rule fixes the sum

- **Location:** AD-18 (583–586); Deferred (702); the D24 row of the map (688).
- **Evidence:** In AC 26, the footer, sidebar and task-ui (`packages/tui`) and the summary (`packages/opencode`) show
  one total: "the closing summary repeats the run total". The spine defers "D24 internals", and AD-18 says only
  "summed tokens and cost of the root session's child sessions". The only definition is a UX assumption
  (`EXPERIENCE.md`, Assumptions): input + output + reasoning tokens, no cache tokens. Nothing says whether the sum
  covers direct children only or all descendants.
- **Fix:** Add a Rule to AD-18: "Run usage is the sum over the assistant messages of the sessions whose `parentID` is
  the root. Cost is summed. Tokens are input + output + reasoning. The summary and the TUI both use this
  definition. One fixture goes through both, and a test compares the results."

### M3: The status contract has two copies, and no Rule keeps them equal

- **Location:** AD-13; Paradigm (66: "`packages/tui` never imports `packages/opencode`").
- **Evidence:** opencode encodes `Status` (`core/status.ts:62–68`). The TUI decodes its own `Status`
  (`task-ui/store.ts:38–49`). AD-13 gives the names in a TS block, but no Rule links the two schemas. Take a field
  that one side adds and the other does not (for example `spans`, `tags` or `outside`). The TUI decode gives `None`
  (`store.ts:49`), and the TUI keeps the last good status with no message (`index.tsx:69–83`).
- **Fix:** Add a Rule to AD-13: "Each contract case has one JSON fixture in `packages/tui/test/task-ui/`: running,
  waiting, blocked, refused, cancelled and subtree. An opencode test projects the matching facts and compares the
  result to the fixture. A TUI test decodes the fixture."

### M4: The AD-17 allowlist is incomplete, and the audit has no rule for a "list of lifecycle states"

- **Location:** AD-17 (559–575).
- **Evidence:** `proof/process.ts:222–225` has `awaitGroupGone`:
  `while (yield* signalGroup(pgid, 0)) yield* Effect.sleep(pollInterval)`. This is a polled loop. It is not on the
  list, and "The audit expects only these entries". Also, the spine does not say how the audit recognises a "list of
  lifecycle states": `peek.tsx:86–87` (`TOOL_GLYPH`, `TOOL_TONE`) has the tool states `pending` and `running`, which
  are also status names.
- **Fix:**
  1. Add an entry: `awaitGroupGone`, in `proof/process.ts`. Reason: it waits for a killed process group inside the
     scope of one proof, and it holds no lifecycle state.
  2. Define the match: "an array literal or object literal with two or more members from the AD-13 status
     vocabulary".
  3. Add an entry for the tool tables in Peek, or rename their keys.

### M5: The cancel has no step that refuses new work

- **Location:** AD-8 (259–261); AD-18 (587–591).
- **Evidence:** Today `stopWork` first sets `stopping`, so the runner refuses new turns from that point
  (`runner.ts:808–816`). In the spine, the finalizer first records `run.cancelled`. The unit supervisors stop only
  when the snapshot change reaches the run supervisor. A supervisor between `begin` and its first prompt can still
  send a builder request. Conformance H16 fails on any builder request after the abort
  (`conformance.test.ts:823–824`).
- **Fix:** "First, the finalizer sends `run.stop` to the run supervisor. In its `stopping` state, the run supervisor
  spawns nothing, and the unit supervisors start no new turn. Then the finalizer records `run.cancelled`." The
  `stopping` flag becomes a supervisor state, which D6 allows.

### M6: The graph walk narrows D5 by an assumption, and no test checks that the narrowing is sound

- **Location:** AD-7 (230–235, 247–248).
- **Evidence:** D5 says "walk every reachable state of the release-notes plan and of every fault-free fault-folder
  plan", and AC 6 says the same. AD-7 walks one canonical interleaving: "[ASSUMPTION] D5's 'every reachable state'
  means every state reachable under this alphabet". The soundness claim is prose only: "the facts of two units
  commute", and no fact of one unit disables a fact of another unit. The negative control checks one known state. It
  does not check the reduction.
- **Fix:**
  1. Move this reading to Open Questions for the owner.
  2. For each plan that the limit allows (the cascade plan, the scenarios plan, the T1.2 subtree of outside-run),
     also run the full interleaving.
  3. Assert that both walks find zero stuck states and the same set of serialized final states.

### M7: The owner questions are not in the spine

- **Location:** the whole spine; `.memlog.md`.
- **Evidence:** The spine has four inline [ASSUMPTION]s (158, 247, 494, 507), one inline open question (552) and no
  Open Questions section. The memlog records three owner questions that the spine drops:
  - AC 2 says "the existing engine tests pass on it", but AD-6 (204) rewrites those tests to "assert through `view`".
  - `run.cancelled` now moves waiting and ready units to `cancelled`, which changes the board.
  - How the Gantt lanes are drawn.
- **Fix:**
  1. Add `## Open Questions`. For each item, give the default that the spine assumes and the AC that the item
     touches.
  2. For AC 2, add a Rule: "In an existing engine test, only the call shape changes (`state` becomes
     `view(snapshot)`). No assertion is removed or loosened. Each test whose behaviour D2 or D3 changes is listed by
     name."

### M8: No Rule says how the hooks reach the harness

- **Location:** AD-8 (255–257); AD-11 (371–374).
- **Evidence:**
  - `createTaskHarnessTools` returns AI SDK tools whose `execute(args)` is a synchronous callback
    (`prompt.ts:1715–1750`).
  - `TaskHooks.watching` and `TaskHooks.checkRepetition` are synchronous calls inside the loop
    (`prompt.ts:1215–1216`).
  - AD-11 makes them "resolve the owner through the index and `system.get`". Those calls are Effects (port
    `llms.txt`: `system.get(systemId)` → `Effect<Option<ActorRef>>`).
  - The root lives in "a scoped service (`TaskHarness`) in the app runtime". Nothing says how the loop or a tool
    callback gets that service, or which runtime runs the send. A module-level singleton would fail the D9 audit.
- **Fix:** Add to AD-11: "`SessionPrompt` resolves `TaskHarness` with `Effect.serviceOption` and passes a bound
  `hooks` value into `createTaskHarnessTools`. `execute` is async and runs `hooks.ready(...)`. When the service is
  absent, no session has an owner." Run the send on the runtime that the fix for C1 names.

### M9: The `Ops.say` contract leaves open two points that other units depend on

- **Location:** AD-18 (592–594).
- **Evidence:** D18 expects the user to ask follow-up questions in the root session, so the root can be busy when
  the run ends. The UX sidebar rule needs the summary to have zero output tokens (`EXPERIENCE.md`, Run usage: "The
  closing summary has none"). The spine fixes only the signature `say({ sessionID, text }): Effect<void>` and "no
  model call".
- **Fix:** "`say` appends one assistant message with zero tokens and zero cost. The message is parented on the latest
  user message, and `say` does not start the session loop. When the session is busy, `say` waits for idle, with a
  bound, and then appends."

## Low

- **L1: The Stack table (611–621) gives no "latest" column.** The pins are correct for brownfield code. Add a note
  that newer releases exist and that this goal does not upgrade them: effect and @effect/platform-node 4.0.4,
  solid-js 1.9.17, @opentui 0.6.4, TypeScript 7.0.2. Also add `opentui-spinner` 0.0.7, which D23 and AD-16 use.
- **L2: The frontmatter is not consistent.** `scope` (7) lists D1–D9, D12, D13, D16–D18 and D20. `binds` (11) also
  has D10, D19, D21 and D24. `companions: []`, but AD-16 and the map depend on `../ux/EXPERIENCE.md`, so add it to
  `companions` or `sources`.
- **L3: The events of the root actor have no names.** AD-11 adds and removes session-index entries but names no
  event. Add `session.owned { session, owner, watch }` and `session.released { run }` to the internal events
  (Conventions, 604).
- **L4: AD-14 can overlap D27.** D13 refusals use the label R12 (494). D27 keeps "Its R12 command report (its
  AC 38)" in the paused goal. Ask the owner whether the label collides with that report.
- **L5: A resume can use a slice that a different plan recorded.** `runID` is one aggregate for each spec path
  (`events.ts:76`), so full-run slices and subtree slices share it. AD-6 resumes "the latest slice", whichever plan
  wrote it. AD-15 records `outside.trusted` for external dependencies only "directly after `run.started`". A subtree
  `/task` that resumes a full-run slice then never trusts its external region, and it waits for ever. Fix: resume
  only a slice whose `run.started` has the same path (add an optional `path`, which is additive), or record the
  external trust after `run.resumed` too.
- **L6: AD-15 regions and the `outside` map.** Say whether external folder dependencies are keys of the status
  `outside` map. If they are, do not show the `/task trust <id>` hint for them (545–546).
- **L7: AC 8 wording.** Add a line to AD-8: "AC 8's 'run supervisor invokes the builder, verifier and proof actors'
  is met through its task supervisors (D7)." This stops a literal verifier from rejecting AC 8. Add one line for
  D1's "root `active` state" too: `active` is now the child of a parallel root, and a probe supports this (memlog).
- **L8: Bloat that can go with no Rule lost.**
  - The Paradigm flowchart repeats the layer table, and the AD-8 mermaid repeats the AD-8 bullets.
  - The Structural Seed mermaid repeats AD-1 and AD-2.
  - These rationale sentences can move to the memlog: AD-7's soundness paragraph (233–235), "The reuse … is
    deliberate" (360–361), the scenario-title note (476–477), the stopped-server paragraph (549–552, apart from the
    open question) and the "(verified 2026-10-14)" notes.
  - Line 274 is longer than the other lines in the file.
- **L9: Older builds and the new facts.** The deferred schema version (692–693) leaves out the real risk. A `dev`
  build without phase 2 shares the user database with the worktree build. Its `TaskEvents.read` cannot decode
  `task.nudged` or `spec.checked`, so the read of that aggregate fails. State the rule: accept the risk and say so,
  or bump the version.
- **L10: The durations include server downtime.** In AD-5, `startedAt` is the time of the fact. Today's task wall
  clock starts at the later of `building` and the resume (`runner.ts:653–659`). After a restart, the D21 durations
  and the task wall clock therefore disagree. Say which start time the task wall clock uses.

## Claims checked

These spine claims were checked against the code or the port, and they hold:

| Claim | Where checked |
| --- | --- |
| 16 fact types; `run.ended` takes only `done` and `failed` | `core/events.ts:31–54` |
| `active` registry (90), `checkDone` (691), `STALE_EVERY` and `tick` (792–801), `failures` and `MAX_FAILURES` (716–735), `stopping` and `children` (809–814), nudge counter (434) | `core/runner.ts` |
| Hook maps `ready`, `verdicts`, `repeated` and `limits` | `core/hooks.ts:28–31` |
| `Ref` values and the `while (true)` watch loop | `core/sessions.ts:256–309` |
| `runState` and the `waitingOn` derivation from the plan | `core/status.ts:86–105` |
| Only the first failure is reported; scenarios are dropped without a message; the start text | `core/command.ts:164–165`, `106`, `224–226` |
| `ACTIVE` and `ENDED` lists; view signals; 300 s live window | `task-ui/store.ts:161–164`, `286–289`, `81` |
| `armed` and `disarm`; `target` signal; `root` signal | `task-ui/watch.tsx:306–307`, `359`; `index.tsx:88` |
| The Gantt lane derives state from history and defaults to `waiting` | `designs/5-gantt.tsx:24–29` |
| `appender` (proof-log flush) exists | `proof/process.ts:274–275` |
| `SessionStatus` publishes status events, so `sessionEvents` can subscribe | `session/status.ts:41–43` |
| task-ui imports nothing from `packages/opencode`; the TUI already depends on `effect` | `packages/tui/package.json`, a grep of `task-ui` |
| Root pins: effect 4.0.3, the port 0.2.0, @opentui 0.4.5, solid-js 1.9.10, TypeScript 5.9.3, Bun 1.3.14 | root `package.json` catalog and `packageManager`; `bun --version` |
| The port is an Effect port of XState 5.33.2 with peer `effect ^4.0.0`; it exports `./graph` | port `package.json`, `llms.txt` |
| `getAdjacencyMap` takes `events` as a function, `limit` and `serializeState`, and fails with `TraversalLimitError` | port `src/graph/adjacency.ts:44–76`, `errors.ts:19` |
| `#id` is split on `.`, so the ids must have no dots | port `src/stateUtils.ts:955–959` (`toStatePath`) |
| `actor.changes` is a Stream; `system.get` is an Effect | port `llms.txt` (Key APIs) |
