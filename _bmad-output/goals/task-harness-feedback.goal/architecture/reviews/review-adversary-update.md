---
review: adversary (update)
target: ../ARCHITECTURE-SPINE.md (status final, updated 2026-10-14, after the owner answers and prepare-goal defaults)
scope: the changed ADs only — AD-4 (rules 3 and 4), AD-6 (test rewrite), AD-19 (busy line, lease contents), the
  heartbeat (AD-8, AD-9, AD-13, AD-16) — and their interaction with AD-7 and AD-18
lens: construct two units one level down that obey every AD to the letter and still build incompatibly
inputs: ARCHITECTURE-SPINE.md, ../decisions.md (D1-D27), ../ACs.md, ../.approved, ../ux/EXPERIENCE.md,
  architecture/.memlog.md, reviews/review-adversary.md, packages/opencode/src/task/** and packages/tui/src/task-ui/**
  at 6c22d9e0e9, packages/core/src/background-job.ts, packages/opencode/src/session/run-state.ts,
  packages/opencode/src/cli/cmd/tui.ts, test/task-harness/conformance.test.ts and arms/*, test/task/engine-xstate.test.ts,
  @jambudipa/xstate-effect 0.2.0 src (Actor.ts, ActorRef.ts, ActorSystem.ts), one Effect 4.0.3 Schema probe
date: 2026-10-14
---

# Adversarial review (update) — task-harness-feedback architecture spine

## Verdict

The outcome amendment (AD-4 rules 3 and 4) is sound against AD-7, and the conformance suite H1–H16 does not read
`status.json` timing, so the heartbeat itself breaks no scripted check. But the heartbeat and the lease are specified
as intents, not as protocols. Two letter-obeying builds break the feature in normal use: a claim that a later refusal
never releases (C1), and a heartbeat timer that the stale-check cadence resets before it fires (C2). Three high
findings tie the heartbeat to the run's end, name the cross-process gap that the heartbeat now makes visible, and route
four narrowings of frozen, approved text (D3, D21, D23, AC 2, AC 4, AC 23, AC 25) to the owner. Land C1, C2 and H1
before `[CS]` writes the supervisor and command tasks.

Counts: 2 critical, 3 high, 9 medium, 9 low. Each finding names the two units, quotes the AD text that each unit
obeys, shows the clash and its concrete failure, and proposes the rule that closes it.

---

## Critical

### C1 — A claim taken before a later refusal is never released, so the directory answers "busy" until a restart

**Units:** `core/command.ts` (the check order) and the harness root's lease (`core/harness.ts`).

- The command obeys AD-19: "The command claims the run with one root event, `run.claim { directory, runID }` … Only a
  claimed command starts the background job." AD-19 fixes no position for the claim among the command's checks.
- The harness root obeys AD-19: "The lease ends when the job closes the run scope."

**Clash.** A literal port puts the claim where today's `TaskRunner.running(id)` check sits (`command.ts:179`). Three
refusals come after that point today: the git readiness check ("the checkout has uncommitted changes or untracked
files", `command.ts:182-185`), the unfinished-base refusal (`command.ts:196-200`), and, new in this goal, the D13
subtree refusal, which must fold stored slices and so needs the session runtime that today resolves only after the
readiness check ("The services are resolved only once nothing refuses", `command.ts:188`). Each of these refusals
returns without starting a job. No job means no run scope, so by AD-19's letter the lease never ends.

**Concrete failure.** The user types `/task` on a dirty checkout (the most common refusal). The command claims,
refuses, and leaks the lease. Every later `/task` in that directory answers the busy line, which names a run that
never started, and its advice "stop it in its own session" (EXPERIENCE.md, Busy reply) is impossible. Only a server
restart clears it. The core-command tests run each case in a fresh instance, so no scripted test sees the leak; the
first place it shows is the D25 live check.

**Second clash in the same seam — precedence.** EXPERIENCE.md says "While a run is live, a refusal answers in the
session only" (so a refusal runs while a run is live), and also "A `/task` while a run is live in the directory starts
nothing and answers with one plain line" (the busy line). For `/task broken.spec` during a live run, one command
answers the D10 failure lines and another answers the busy line. Both obey AD-19.

**Proposed rule (replace the AD-19 claim bullets):**
> - The harness root answers two events from outside every actor. `run.live { directory }` reads the lease and
>   returns `none` or `{ runID, spec, path }`; it changes nothing. `run.claim { directory, runID, spec, path }`
>   returns `claimed` or `busy { runID, spec, path }`.
> - The command runs in this order: usage, loader (D10), task-folder (R2), `run.live` → busy line, git readiness,
>   unfinished base, D13, then `run.claim`, then `BackgroundJob.start`. A loader or R2 refusal while `run.live` is
>   not `none` answers its failure lines in the session only and writes no file.
> - The claim is the last step before `BackgroundJob.start`. If the start does not run the job (an error, or a job
>   of that id already running), the command sends `run.release { directory, runID }` in the same `Effect.onExit`.
> - Test: claim, then fail the start; a second `/task` in the same harness root is not busy.

### C2 — The 5 s heartbeat can share a state with the stale-check cadence and never fire

**Units:** the run supervisor (`core/supervise/run.ts`) and the task-ui `liveness` region (`task-ui/machine.ts`).

- The supervisor obeys AD-8, which lists three timers side by side: "the run wall clock, as a delayed transition that
  invokes a `record` worker; the heartbeat, a delayed transition every 5 s that invokes a `touch` worker …; the
  stale-check cadence, as a delayed transition that invokes `staleCheck`". AD-8 sets no cadence for the stale check
  and no state shape for the three timers.
- The TUI obeys AD-16: "`live` while the status is not ended and `now - run.aliveAt <= 15 s`", and AD-13: "The run
  supervisor asks for a write every 5 s".

**Clash.** The most direct xstate shape puts all three `after` rows on one `running` state, with `checking` and
`touching` as states that invoke their workers and return to `running`. A delayed transition is cancelled when its
state exits and restarted on re-entry. Today's stale check runs about once a second (`TICK` 250 ms, `STALE_EVERY` 4,
`runner.ts:791-802`). If the supervisor keeps that cadence, each stale cycle exits `running` before 5 s pass, so the
heartbeat never fires. In the same shape, while `staleCheck` waits for the checkout lock (AD-12, AD-19: a merge, a proof
on the base branch or a scenario proof holds it for minutes), no timer of `running` runs at all. The same reset also
stops the run wall clock from ever firing.

**Concrete failure.** `run.aliveAt` then moves only when a fact is recorded. A builder turn records no fact for
minutes, so 15 s into every real turn the TUI goes `still`: the D23 diamond stops, the D21 durations freeze (AC 23,
AC 25), and, because today's `live` gates the keys (`ui.tsx:123-151`, `watch.tsx:439`), Tab-select and the `esc`-twice
stop go away while the run is healthy. The D25 live check (AC 27) captures exactly this.

**Proposed rule (AD-8, run supervisor shape):**
> The run supervisor is `type: "parallel"`. The heartbeat, the run wall clock and the stale-check cadence are each
> their own region. No transition in another region targets a state of these regions, and none of them uses
> `reenter`. The heartbeat region is `beating` (`after` 5 s → `touching`) and `touching` (invokes `touch`; `onDone`
> and `onError` → `beating`). Each timer region moves to a final `stopped` state when the run actor's status is
> `done`. `closed` is the final state of the main region. Test: hold `staleCheck` on the checkout lock, advance the
> TestClock by 5 s, and require one touch.

---

## High

### H1 — The heartbeat outlives the Recorder, and the writer's end is not tied to the run's end

**Units:** the run supervisor's heartbeat (AD-8, in the harness root's actor tree), the status writer and Recorder
(AD-9, in the run scope), and the background job's finalizer (AD-8).

- AD-8 places the heartbeat in the run supervisor, which the harness root spawns: it is not in the run scope.
- AD-9 claims: "When the run scope closes, the heartbeat stops." It also says the writer "consumes
  `runActor.changes` and the Recorder's `touch` requests. It writes `status.json` for each committed macrostep, the
  final one included, and for each `touch`."
- AD-8 orders the cancel path: "The job body waits for the run supervisor's final state `closed`, then closes the run
  scope. … The job's finalizer records `run.cancelled` only when the job's status is `cancelled`, then waits for
  `closed` within the same bound, then stops the supervisor."

**Clash 1 — cancel order.** "The job's finalizer" reads as a finalizer of the job effect, outside the run scope. On
`BackgroundJob.cancel` (which a root-session abort calls, `session/run-state.ts:132`), the job fiber is interrupted:
`Effect.scoped` closes the run scope first (Recorder, run actor, writer), and only then does the outer finalizer run.
Its `record(run.cancelled)` meets a closed Recorder, so the fact is lost and the file never says `cancelled`. Meanwhile
the supervisor, still alive in the harness root, invokes `touch` against the closed Recorder every 5 s until the
finalizer's bound expires. AD-9's sentence is therefore false in this order, and H16 ("T1.1, T1.2 and the run
cancelled … within 2 s") fails, which fails AC 29.

**Clash 2 — the writer's end.** The port's `changes` stream "ends when the actor is done or stopped" (port
`src/Actor.ts:236`). Writer A merges `changes` and the touches with Effect's default halt strategy (`"both"`), so it
keeps rewriting the ended status every 5 s until the scope closes. Writer B halts with `changes`; its touch queue then
has no consumer. If B's Recorder uses a bounded queue and the `touch` worker awaits the offer or the write, the worker
never returns, and a heartbeat region that must be final for the supervisor to be done (C2) never is. The job then
waits for `closed` for ever, and C1's lease never ends.

**Clash 3 — touch failures.** AD-8 gives unit supervisors "After 3 worker failures in a row, the supervisor records
`task.failed` …" but says nothing for the run supervisor's workers. A builder who applies the same rule to `touch`
may record `run.ended { state: "failed", reason: "harness error: …" }` after three failed touches — ending a healthy
run because the status file could not be refreshed.

**Proposed rule (AD-8, AD-9):**
> - The heartbeat stops when the run actor's status is `done` (C2's `stopped`). Replace AD-9's last sentence with
>   "The writer writes the done snapshot, then ends with `changes`. No write follows it."
> - `touch` is fire-and-forget: the Recorder offers to a `Queue.sliding(1)` and returns. A touch after the run scope
>   closed returns `void`. A `touch` failure is logged, never counts toward a failure rule, and never records a fact.
> - The cancel finalizer is a finalizer of the run scope, added after the Recorder is built, so it runs before the
>   Recorder, the run actor and the writer close. The run scope closes only after the supervisor is `closed` or
>   stopped.
> - Test: cancel a job whose supervisor is mid-`staleCheck`; require `run.cancelled` in the store and in the file.

### H2 — The lease is per process, and the heartbeat makes two writers alternate for the whole run

**Units:** two opencode servers in one directory (each `opencode` TUI starts its own server in a `Worker`,
`cli/cmd/tui.ts:272-279`), each with its own harness root, lease and Recorder; the TUI `liveness` region.

- Each harness root obeys AD-19: "At most one run is live in a directory. Its Recorder is the only writer of that
  directory's `status.json`." The lease lives in the process-wide root (AD-8), so the rule holds per process only.
- Each writer obeys AD-9 and stamps `run.aliveAt` every 5 s.

**Clash.** Two terminals in one repository are two servers sharing one `status.json` and one event store. Before the
heartbeat, two runs overwrote the file only when each recorded a fact. Now each writer rewrites it every 5 s, so the
file, the TUI's Board and the liveness flip between two runs continuously, even when both are idle. If both runs use
the same spec, the second server finds the latest slice not ended with the same path and resumes it (AD-6), so two
Recorders publish to one aggregate — the fault AD-9 lists under "Prevents".

**Trap in the obvious fix.** "Busy when the file is not ended and `run.aliveAt` is fresh" breaks H8: the conformance
suite SIGKILLs the server and restarts it within seconds (`conformance.test.ts:451-453`), so the killed run's
`aliveAt` is still under 15 s old and the resume would answer busy. H8 fails, and AC 29 with it.

**Proposed rule (AD-19), one of:**
> - **A (smaller).** AD-19 states its scope: "one lease per opencode server process; two servers in one directory are
>   out of scope". The Deferred section records the effect above.
> - **B.** The claim also takes `.opencode/task/lease.json` `{ pid, runID, spec, path }`. A lease file whose `pid` is
>   alive (`process.kill(pid, 0)`) and is not this process answers busy; a dead `pid` is a stale lease and is
>   replaced. The run scope removes the file. Never decide cross-process liveness from `run.aliveAt` alone.

### H3 — A prepare-goal default narrows binding D23 and D21, and owner answers narrow approved text that cannot change

**Units:** the `[CS]` tests and the `eque2-verifier`, which judges each AC by its approved text; the spine.

`.approved` hash-locks `decisions.md` and `ACs.md` (`decisions-hash`, `acs-hash`), and prepare-goal refuses either
file edited after approval. The narrowings below therefore exist only in the spine, which the verifier does not
judge against.

| Spine text | Approved text | Status |
| --- | --- | --- |
| AD-16: "The D23 diamond animates and the D21 live durations count only while `liveness` is `live`. In `still` and `ended`, the diamond is static and the durations stop (prepare-goal default, 2026-10-14)." | D23: "While the run is active, the diamond … plays the frames … It is a static `◆` when the run's tags say it has ended, or when the `animations_enabled` setting is off." AC 25 repeats it. | A **default**, not an owner answer, adds a third static case. A `still` run carries the run tag `active` or `waiting`, not `ended`. |
| Same AD-16 sentence | D21: "Each task shows a live duration while it runs and its final duration once it ends". AC 23: "shows live while the task runs". | A `still` task is still `building` by its tags; its duration stops. |
| AD-4 rule 3: all tasks trusted and a scenario failed or rejected → `failed` (owner answer) | D3: "`done` when every task is trusted, otherwise the state of the task that died first". AC 4 repeats it. | Owner answer, frozen text unchanged. |
| AD-6: tests "are rewritten as fact sequences" (owner answer) | AC 2: "the existing engine tests pass on it" | Owner answer, frozen text unchanged. |

**Concrete failure.** A verifier that reads AC 25 checks a run whose heartbeat is stale and whose tags say `active`,
finds a static diamond, and fails AC 25. A verifier that reads AC 4 finds a test that expects `failed` with every task
trusted and fails AC 4. Neither verifier reads the spine.

**Proposed rule:**
> - Ask the owner one question before `[CS]`: "In `still` (no heartbeat for 15 s, run not ended), stop the diamond and
>   the live durations?" Until answered, AD-16 marks default 6 `[ASSUMPTION]`.
> - `[CS]` writes an "Owner rulings" section into the SPEC, which the verifier reads with the ACs: each ruling quotes
>   the owner's words and its date and names the ACs it narrows (AC 2, AC 4, and AC 23 and AC 25 once ruling 4
>   exists). Each affected test names the ruling in its title.

---

## Medium

### M1 — `run.claim` carries no spec or path, and `busy` carries no payload

- The harness root obeys AD-19: "A lease holds the live run's id, spec and path".
- The command obeys AD-19: "`run.claim { directory, runID }` … The result is `claimed`, or `busy`" and must answer
  "one line that names the live run's spec and path".

**Clash.** The claim event has no spec or path to put in the lease, and a bare `busy` gives the command nothing to
name. The run supervisor's context holds the current spec texts (AD-12) but not the `/task` path, and it does not
exist until after the job starts. Two letter-faithful units do not compile together. **Rule:** C1's
`run.claim { directory, runID, spec, path } → claimed | busy { runID, spec, path }`, where `spec` is the spec folder
relative to the directory (as `run.spec`) and `path` is the `/task` argument (as `run.path`).

### M2 — An `aliveAt` stamped outside `write` is stripped by the encoder, and the shared fixture never carries it

- `status.ts` obeys AD-13: "`status.json` is `project(plan, snapshot)`" and "The projection reads only the snapshot
  … The one exception is `run.aliveAt`, which the status writer stamps".
- The writer obeys AD-9: "On each write it stamps `run.aliveAt`".

**Clash.** Today `write` encodes through `Schema.encodeSync(Schema.fromJsonString(Status))` (`status.ts:70,173`).
A probe on Effect 4.0.3 shows that the encoder drops a key that the struct does not declare:
`encode({ run: { state: "running", aliveAt: 123 } })` gives `{"run":{"state":"running"}}`. A writer that spreads
`aliveAt` onto `project`'s output and a `status.ts` whose schema follows `project` produce a file with no `aliveAt`.
Every TUI then shows `still` for every live run (diamond, durations, stop key). The AD-13 fixture test cannot catch
it: "An opencode test writes a fixture with `project`", and `project` never emits `aliveAt`.
**Rule:** `TaskStatus.Status` declares `run.aliveAt` as optional. `write(directory, status, aliveAt?)` stamps it
inside `write`, so no caller spreads it and `project` stays pure (D8). The shared fixture is written by `write` with a
fixed clock, and the TUI test decodes `aliveAt` from it.

### M3 — A touch can write a newer snapshot before an older one, and the natural fix is a banned `Ref`

- Writer A obeys AD-9 and, on a touch, writes `runActor.getSnapshot()`.
- Writer B obeys AD-9 and D9 and keeps the last consumed snapshot in a `Ref`.

**Clash.** The port delivers every snapshot through an unbounded `PubSub` (`Actor.ts:1066`), so the writer may lag.
If A takes a touch while snapshots N and N+1 wait in the stream, it writes N+1, then N, then N+1: the file goes back
one step, and the TUI can draw a task as `trusted`, then `building`, then `trusted`. B avoids that, but D9 fails on
"any … `Ref`" and AD-17 says "Each `Ref` … goes", so AC 11 fails. A third writer that uses `Effect.forever(Queue.take)`
may match the audit's polled-loop rule, which AD-17 does not define. **Rule (AD-9, AD-17):** the writer is one
`Stream.runForEach` over `Stream.merge(changes, touches, { haltStrategy: "left" })` with a `Stream.scan` that holds
the last consumed snapshot; a touch rewrites exactly that snapshot and never reads `getSnapshot()`. AD-17 names the
polled-loop patterns: `while (true)`, `Effect.repeat`, `Effect.forever`, `Schedule.spaced`, `Schedule.fixed`,
`Stream.tick`, `setInterval`. An xstate `after` row and a `Queue` are not on the D9 list and need no entry.

### M4 — The summary lists rejected scenarios only, so a run failed by a `failed` scenario shows no cause

- The summary obeys AD-18: "each rejected scenario with its verdict reason".
- The machine obeys AD-4 rule 3: "a runnable scenario is `failed` or `rejected`" → outcome `failed`.

**Clash.** A scenario whose `[S<n>]` test fails is `failed` (`scenario.proved` with status failed), not `rejected`.
By AD-18's letter, its summary reads "failed: acceptance not proved" with no task in **Stopped** and no scenario in
**Rejected scenarios**. EXPERIENCE.md already says "Each rejected or failed scenario", so the summary built from the
spine and the summary built from the UX differ. **Rule (AD-18):** "each rejected or failed scenario with its reason";
the summary also prints `run.reason` under the outcome line.

### M5 — Rule 4 puts `not run` lines on a `done` run, and the UX draws the first reason line as an error

- The machine obeys AD-4 rule 4: "the outcome is `done`. Its reason has one line for each `parked` scenario".
- The TUI obeys EXPERIENCE.md, Run reason line: "The first line of `run.reason` in `{theme.error}` … Ledger,
  full-screen header, Dock, HUD, Ticker notification".

**Clash.** The release-notes happy path (H3: S13 parked on T8) ends `done` with `run.reason = "not run: S13 waits on
T8"`. Every surface then shows a red line, and the Ticker raises an error-toned notification, on a successful run.
**Rule (AD-13, EXPERIENCE):** the run reason line uses `{theme.error}` only when the run carries the `stopped` tag; on
a `done` run it uses `{theme.textMuted}`, and the Ticker raises no notification for it.

### M6 — Rules 3 and 4 derive parked lines from data the action cannot read as stated

- The action obeys AD-4: "The action computes the reason from `context.log` (the last entry of each unit …) and from
  static plan data (the outside ids). An action cannot read the configuration."
- The log obeys AD-5: "A move whose status name does not change appends no entry: the `waiting`, `ready` and
  `parked` toggles".

**Clash.** A parked scenario leaves no entry of its own, so the action must infer it: at settle, a scenario whose last
entry ends in `waiting`, or which has none, is parked (the only final scenario state shown as `waiting`). "Static
plan data (the outside ids)" gives every outside need, including ones already trusted, so action A writes `not run:
S13 waits on T8, T9` while the summary and the TUI, which read `waitingOnOutside`, show only `T8`. Rule 3 says "one
line for each `parked` scenario" with no format, and no rule sets the separator between ids.
**Rule (AD-4):** a scenario is parked at settle when its last log entry ends in `waiting` or it has none. Its line is
`not run: <id> waits on <ids>`, where `<ids>` are its outside needs whose last log entry is not `trusted`, in natural
order, joined with `, `. Rule 3 uses the same line.

### M7 — AD-6's rewrite list is too narrow, some intents cannot be kept, and the builder cannot write evidence

- `[CS]` obeys AD-6: "The engine tests for stop-at-once, waiting-on-cancel and hand-built `State` inputs are
  rewritten … Each keeps its intent. … The AC 2 evidence lists each rewritten test with its reason."
- The engine obeys AD-6: "the engine tests assert through `view`", "`apply` … dies when the snapshot was made by
  another machine", and "`initial(plan)` asserts that the status is `active`".

**Clash 1.** 26 of the 27 tests in the `XStateEngine` block of `engine-xstate.test.ts` read `State` fields from
`apply`'s output (only "is named xstate" does not), so nearly every test changes, not three classes. A list of three
classes leaves most changed tests with no listed reason.
**Clash 2.** Some hand-built inputs cannot exist under the new API: a unit in a state "its lifecycle does not name"
(`lost`, `engine-xstate.test.ts:559-603`), an obligation of a task the plan does not hold (547-557). No fact sequence
reaches them, so "keeps its intent" cannot hold.
**Clash 3.** Only `eque2-verifier` mints verdicts, and the project policy forbids an agent to write evidence, so the
builder cannot make "the AC 2 evidence" list anything.
**Rule (AD-6):** a committed list (for example, the header of `engine-xstate.test.ts`) puts each old test in one of
three classes: **ported** (same facts, same expectations, asserted through `view`), **re-baselined** (facts or
expectations changed, with the D2, D3 or ruling that changed them), or **retired** (its input is not representable;
the new guard that replaces it, for example "a foreign snapshot dies"). The AC 2 evidence cites that list.

### M8 — The liveness rows name ownership but never use it, and `still` can shadow `ended`

- View machine A obeys AD-16: "Eventless rows choose the state from the status tags, ownership and the heartbeat",
  and keeps today's `owns()` in `live` (`index.tsx:100-103`).
- View machine B obeys the same bullet's definitions, which use only the tags and `run.aliveAt`.
- Both list the rows in AD-16's order: `live`, then "`still` when the heartbeat is older or absent", then `ended`.

**Clash.** In a session that does not own the run, A's diamond is static and B's animates. Today `live` gates Tab and
the `esc`-twice stop, so the two also disagree on keys. In the listed order, a `refused` file or a `done` file whose
heartbeat is old satisfies `still` before it reaches `ended`, so the run span runs to `aliveAt` (EXPERIENCE "Run span …
to `run.aliveAt` while `still`") instead of `endedAt`. **Rule (AD-16):** the rows run in this order: `absent` (no
status), `ended` (the `ended` tag), `live` (fresh heartbeat), `still`. Liveness reads no ownership; each key that acts
on the run checks `owns` itself, as `registerTab` does today.

### M9 — The lease can end before the writer's last write lands

- The harness root obeys AD-19: "The lease ends when the job closes the run scope."
- The writer obeys AD-9 and is forked in the same scope.

**Clash.** If the lease release is a finalizer added after the writer, it runs first (finalizers run in reverse
order). In that gap a new command finds no lease and writes a refusal form; the old writer's in-flight write then
lands over it, so the TUI shows the old run's end and never the refusal. **Rule (AD-19):** the lease release is the
first finalizer added to the run scope, so it runs last, after the writer has stopped.

---

## Low

- **L1 — Two constants in two packages.** The 5 s cadence (server) and the 15 s window (TUI) live in packages that
  cannot import each other. A later change to one silently breaks liveness. **Rule:** AD-13 names both as contract
  constants with the ratio "window = 3 × cadence", and each package's test asserts its own value.
- **L2 — An interrupted write leaves a `.tmp`.** `write` is temp-then-rename (`status.ts:166-176`). A scope close
  between the two steps leaves `status.json.<n>.tmp`, which `core-status.test.ts:178` forbids. More writes make it
  more likely. **Rule:** `write` runs uninterruptibly.
- **L3 — Liveness compares two clocks.** `aliveAt` is the server's clock and `now` is the TUI's. Today the server is a
  `Worker` in the TUI's process, so the clocks agree; a separate `opencode serve`, or a server in a container whose
  clock drifts, makes `now - aliveAt` wrong in either direction. **Rule:** `live` while the observed `aliveAt` changed
  within the last 15 s of view time; on the first read, fall back to `now - aliveAt <= 15 s`.
- **L4 — The Gantt bullet lags the UX.** AD-16 says "An open span runs to `now`"; EXPERIENCE.md says "to now while
  `live`, and to `run.aliveAt` while `still`". A Gantt built from the spine keeps growing while the duration text has
  stopped. **Rule:** copy EXPERIENCE's sentence into AD-16.
- **L5 — Rule gaps in AD-4.** Rule 2 lists no parked scenarios, while rules 3 and 4 do; "runnable" has no definition
  (every failed or rejected scenario ran). **Rule:** drop "runnable", and say that rule 2 lists none by design (the
  summary's **Not run** section names them).
- **L6 — The AD-6 change source.** "An expected outcome changes only where D2 or D3 changes it", but the
  waiting-on-cancel change (`engine-xstate.test.ts:353-366`, T1 stays `waiting`) comes from default 4 through AD-4's
  cancel rows. **Rule:** "where D2, D3 or an AD-4 rule changes it".
- **L7 — AD-14 and the busy line.** AD-14 says "The refusal session message is one header line, then exactly the
  lines of `run.reason`, then one optional hint line". A busy answer writes no `run.reason`, and EXPERIENCE files it
  under the Refusal pattern. **Rule:** AD-14 exempts the busy line, which is one line (AD-19).
- **L8 — Presence is not progress.** The 300 s window measured movement (file, sessions, proof logs,
  `index.tsx:95-110`); the heartbeat measures only a live supervisor, so a wedged run whose supervisor lives still
  animates. The D7 stall watch and the proof timeout cover the cases that matter. Also, `mtime` stays in the AD-16
  context with no remaining reader. **Rule:** say so in AD-16, and drop `mtime` from the context.
- **L9 — The summary window.** Between `done` and `closed` (at most `cancelDeadline`, 5 s, `limits.ts:35`) the TUI
  shows `ended` while `/task` answers busy. **Rule:** none needed; EXPERIENCE's busy text may add "finishing" when the
  lease holder's run is done.

---

## Verified: no clash

- **Conformance H1–H16.** No check reads the status file's mtime or `aliveAt`. `until` polls every 200 ms, the write
  is an atomic rename, and `Adapter.reading()` filters by `run.path` (`arms/index.ts:116-127`). More frequent writes
  change no check. History `at` is compared with the scripted model's request `at` across two processes on one host
  (`conformance.test.ts:369-399, 559`), which the heartbeat does not touch.
- **Existing readers and the new key.** The TUI decodes with `Schema.Struct`, which ignores an unknown key on decode,
  and the conformance reader checks only the top-level shape (`arms/status.ts:69-77`). Only the encoder is a risk (M2).
- **AD-7 under rule 3.** The walk's alphabet gives scenarios the success path only, so rule 3 never fires in the
  walk, and AD-7 already requires unit tests for it. The outcome region is not in the key, but it is a function of the
  unit states plus the order of deaths, and every final outcome has status `done`. The soundness argument does not
  mention the outcome region and still holds.
- **A server stop records no fact.** `BackgroundJob.settle` runs after the job's own finalizers
  (`background-job.ts:128-172`), so a finalizer sees `running` on a server stop and `cancelled` only after `cancel()`
  (`background-job.ts:338-358`), which a root-session abort calls. The run stays resumable, and the TUI goes `still`
  15 s later, as AD-16 intends.
- **D9 and the heartbeat.** An xstate `after` row is not a polled loop, and a `Queue` is not on the D9 list. Only a
  `Ref`-held snapshot (M3) would fail the audit.

---

## ADs that contradict or weaken a binding decision

| AD text | Decision text | Finding |
| --- | --- | --- |
| AD-16: "In `still` and `ended`, the diamond is static and the durations stop (prepare-goal default)" | D23: "It is a static `◆` when the run's tags say it has ended, or when the `animations_enabled` setting is off." | H3 (needs an owner answer) |
| Same AD-16 sentence | D21: "Each task shows a live duration while it runs" | H3 |
| AD-4 rule 3: every task trusted and a scenario failed or rejected → `failed` | D3: "`done` when every task is trusted" | H3 (owner answer; frozen D3 and AC 4) |
| AD-6: engine tests rewritten as fact sequences | AC 2: "the existing engine tests pass on it" | H3, M7 (owner answer; frozen AC 2) |
| AD-13: "The one exception is `run.aliveAt`, which the status writer stamps" | D8: "The status projection reads only the run machine's snapshot." | Weak: keep `aliveAt` out of `project` (M2) so the projection stays pure; the file carries one non-lifecycle field. |
| AD-16: liveness reads `run.aliveAt` | D16: "The task-ui classifies units only from the `status.json` tags (D8)." | Weak: liveness is run ownership, not a unit class. Say so in AD-16. |

No changed AD weakens D2, D4, D5, D6, D7, D9, D10, D12, D13, D17, D18 or D24 in its text. D18 is weakened in effect
by M4.

## Order of work

1. Land C1 (claim protocol, check order, release) and M1 (claim payload) as one AD-19 amendment.
2. Land C2 and H1 as one AD-8/AD-9 amendment: the parallel supervisor shape, the heartbeat's end, the writer's end,
   the fire-and-forget touch and the cancel-finalizer placement. Then M3 and M9 in the same pass.
3. Ask the owner the H3 question for default 6, and have `[CS]` carry an "Owner rulings" section into the SPEC.
4. Land M2 in AD-13 (`write` stamps `aliveAt`; the fixture comes from `write`), then M8 in AD-16.
5. Re-issue the EXPERIENCE.md rows for M4 and M5, and copy L4's Gantt sentence into AD-16.
6. Decide H2 (option A or B) before the D25 live check.
