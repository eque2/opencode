# Decisions — `/task` harness feedback

Input: [`./task-questions.md`](./task-questions.md) (13 questions). The answers to the factual questions (1, 3, 4,
6, 9) are in **Research** below. The decisions close the gaps that the answers found, and carry out the owner's
requirement in question 13: **xstate holds every state, transition and state-reading decision of the harness.**

The work runs in four phases, engine first, because the engine fixes the observed stuck run (see `plan.md`):

| Phase | Areas | Decisions |
|---|---|---|
| 1 | One run machine | D1–D5 |
| 2 | Live supervision as actors | D6–D9 |
| 3 | Validation and fault folders | D10–D15 |
| 4 | Task UI | D16–D24 |
| — | Delivery | D25–D27 |

## One run machine (phase 1)

### D1: one machine per plan holds the whole run

**Choice** — `initial(plan)` generates one machine config for each plan. Its root `active` state is
`type: "parallel"`, with one region for each task. Each task region nests its obligations, and the scenarios and
the `outside` preconditions are regions too. This replaces the four per-unit machines (obligation, task, scenario,
run) and the fold code that joins them (`stepTask` → `stepRun`, `cancel`, `staleAlone`). The durable lifecycle
stays a pure fold of stored facts through this machine.

**Justification** — The plan is fixed for a run, so a generated config is static for that run. The engine header's
reason for one machine per unit ("a run's tasks come from its spec") does not hold once the config is generated
from the plan. With one machine, every rule that spans units is a statechart rule that a test can walk (D5).

**Alternatives** — Keep the per-unit machines and have the fold send `task.blocked` to the dependants (about 2–3
hours). Rejected by the owner: the cascade stays in the hand-written fold code that missed it, and nothing proves
that no other stuck state exists.

**Verified by** — AC 2.

### D2: a task blocks when anything it needs is dead

**Choice** — Each task region gets a final `blocked` state. Its `waiting` state has an eventless row:
`always: { guard: or(stateIn(<each after task and child>, exhausted | failed | needs_human | blocked)), target:
"blocked" }`. The machine settles eventless rows in one macrostep, so T1.4 → T1.5 → T1 block in the same fold step.
Each block writes a history entry that names the upstream cause ("blocked by T1.4: budget exhausted").

**Justification** — This is the observed bug: T1.4 exhausted its budget, and T1.5 and T1 waited for ever with no
reason. `blocked` is derived from existing facts, so stored runs fold and resume with no new fact type. The owner's
prototype on the release-notes plan: 7 stuck states out of 36 without the cascade, 0 out of 29 with it.

**Alternatives** — The `task.blocked` event from the fold (D1 alternatives). Rejected for the same reason.

**Verified by** — AC 3.

### D3: the run ends only when every region is final; independent work finishes

**Choice** — The run's outcome comes from `active.onDone`. A parallel state is done only when every region is
final, so the run cannot end while a task waits. When one task dies, every task that does not depend on it runs to
its end. The end-state names stay as they are: `done` when every task is trusted, otherwise the state of the task
that died first (`needs_human`, `budget_exhausted` or `failed`), and the reason lists every dead and blocked task.
This replaces `follows` (`engine-xstate/index.ts:567`) and the done decision in `checkDone` (`core/runner.ts:691`).

**Justification** — This answers the owner's first open decision. `onDone` gives this behaviour with no extra rule.
Today's behaviour stops at once and strands the in-flight siblings, so paid builder work is lost. Each task's spend
is still capped by its own budget.

**Alternatives** — Stop at once: every non-final region blocks when any task dies. Rejected: it throws away
in-flight work, and it needs one more guard on every region. A spec policy value can add it later if a user asks.

**Verified by** — AC 4.

### D4: dependencies, readiness and `outside` preconditions live in the machine

**Choice** — A task region becomes ready only when every `after` task and every child is trusted, through
`stateIn` guards. Two siblings with no `after` between them become ready in the same step. Each `outside`
precondition is a region that the `outside.trusted` fact moves to trusted. A task that waits on an untrusted
`outside` task stays `waiting` — a live state that one event can move, not a stuck one — and the board says
"waiting on T9 (outside) — run /task trust T9". The readiness check in `schedule` (`core/runner.ts:768`) and the
runner's `outside` trust set go.

**Justification** — Today the dependencies live only in the runner, so no machine knows that T1.5 depends on T1.4.
This answers question 3 (order) structurally, and the owner's second open decision: yes, report the `outside` wait
explicitly.

**Alternatives** — Keep `schedule` and add a runner test for the order. Rejected: it breaks the requirement.

**Verified by** — AC 5.

### D5: a graph test proves that no run can get stuck

**Choice** — A test uses `getAdjacencyMap` from `@jambudipa/xstate-effect/graph` to walk every reachable state of
the release-notes plan and of every fault-free fault-folder plan (D15). It fails on any state that is not done and
that no event can move. A negative control removes the cascade rows from a copy of the config and checks that the
test then finds the observed stuck state.

**Justification** — The owner's method step 4. The negative control proves the test can see the fault it guards
against.

**Alternatives** — The random-fact fold test that exists (`engine-xstate-random.test.ts`). Rejected as the proof:
a sample of paths cannot show the absence of a stuck state. It stays as a regression test.

**Verified by** — AC 6.

## Live supervision as actors (phase 2)

### D6: one run supervisor actor replaces the runner's hand-written state

**Choice** — A run supervisor is an xstate actor. It reads the run machine's tags (for example `ready`,
`verifying`, `proving`) and invokes the builder, verifier, proof and stale-check actors. It records each actor's
outcome as a fact, which the run machine folds. The fold itself invokes nothing. These go from `core/runner.ts`:
the polled `loop` with its `tick` counter and `STALE_EVERY` (795), `checkDone` (691), the `failures` map and
`MAX_FAILURES` (716–735), `stopping` and `children` (809–814), and the process-wide `active` registry (90), which
the actor system (`system.get`) replaces.

**Justification** — The owner's split: the durable lifecycle is a pure fold of stored facts, and live process
supervision is xstate actors whose outcomes become facts. A run resumes by folding its facts, then the supervisor
starts what the folded state asks for.

**Alternatives** — Keep the polled loop and move only the decisions into guards. Rejected: the loop's tick and
counters are state outside xstate.

**Verified by** — AC 8.

### D7: one supervision actor for each running task

**Choice** — One xstate actor for each running task holds what the session watch and the hooks hold today. Stall,
idle and the spend cap become delayed transitions and guards. The builder nudge counter (`core/runner.ts:434`) and
the hook maps `ready`, `verdicts`, `repeated` and `limits` (`core/hooks.ts:28-31`) become its context, fed by
events from the tool hooks. It records each decision (stall, spend cap, idle, nudge) as a fact. The `activity`,
`outcome` and `busy` Refs and the polled `while (true)` loop in `core/sessions.ts:256-290` go.

**Justification** — The session watch and the hooks hold one task's turn state between them; one actor owns it in
one place.

**Alternatives** — Two actors, one for the session watch and one for the hooks. Rejected: they share the same turn
state, so two actors would pass it back and forth.

**Verified by** — AC 9.

### D8: `status.json` is a projection of the machine snapshot

**Choice** — The status projection reads only the run machine's snapshot. Each task, obligation and scenario
carries its state, its tags (`active`, `ended`, `blocked`, `waiting`), its blocked cause, and its start and end
times, which the machine's context takes from the fact timestamps. `runState` (`core/status.ts:97`) and the
`waitingOn` derivation from the plan go.

**Justification** — The TUI then reads the classification instead of encoding it again (D16), and the per-task
times (D21) come from the machine, not from a second derivation of the history.

**Alternatives** — Keep `runState` and add the tags beside it. Rejected: two sources for the run's state.

**Verified by** — AC 10.

### D9: an audit test keeps state inside xstate

**Choice** — A test scans `packages/opencode/src/task/` and `packages/tui/src/task-ui/` and fails on any
`MutableHashMap`, `Ref`, `SynchronizedRef`, `setInterval`, polled loop, module-level mutable `let`, or list of
lifecycle states. An allowlist names each permitted exception with its reason (for example the one adapter that
turns a machine snapshot into a Solid signal).

**Justification** — "Exhaustively" needs a check that keeps holding after this goal. Without one, the next fix
can add a counter beside the machine again.

**Alternatives** — A code review at the end only. Rejected: it does not hold for later changes.

**Verified by** — AC 11.

## Validation and fault folders (phase 3)

### D10: a refusal lists every failure

**Choice** — `/task` on a spec that fails validation lists every failure that `Blend.load` returns, one line each
as `R<n> <path>: <message>`, in the session message and in `status.json` `run.reason`.

**Justification** — The format says "Report every failure with its file and its rule"
(`task-formats/blend/README.md` §Parse step 7). The command reports only the first one
(`core/command.ts:164-165`), so a spec with three faults needs three runs to find them.

**Alternatives** — Keep the first failure and add a count ("and 2 more"). Rejected: the user still cannot see the
other two.

**Verified by** — AC 12.

### D11: every `VERIFY.md` has `ensures`

**Choice** — `ensures` becomes required in the `VERIFY.md` schema (`blend/schema.ts:152`), so a task with no
obligation is an R3 failure.

**Justification** — The README calls `ensures` required, but the schema makes it optional and R8 does not check it.
A task with no obligation is trusted on nothing. Every `VERIFY.md` in the two shipped specs already has `ensures`.

**Alternatives** — Change the README to call `ensures` optional. Rejected: a task with no obligation defeats the
verifier.

**Verified by** — AC 13.

### D12: a spec that stops validating during a run is reported

**Choice** — When the stale-check actor (D6) reloads a spec that no longer validates, the run keeps the plan it
loaded. The actor records the failures as a fact, and the TUI shows them as a run warning.

**Justification** — Today the failure is ignored without a message (`core/runner.ts:634-635`). Ending the run would
throw away in-flight work for an edit that the user can undo.

**Alternatives** — End the run as refused. Rejected: it loses in-flight builder work. Hold new starts until the
spec validates again. Rejected: a run that waits for ever if the user does not see why.

**Verified by** — AC 14.

### D13: a subtree run with a dependency outside it is refused at the start

**Choice** — `/task <spec>/<task folder>` is refused at the start when a task in the run is after a folder task
outside the run that is not trusted. The command learns trust by folding the stored facts through the run machine,
not from a hand-written set. The refusal names both tasks. A subtree run that leaves scenarios out, because their
`needs` fall outside it, names them in its start message.

**Justification** — Today that run waits for ever (`core/status.ts:86-90`) and drops the scenarios silently
(`core/command.ts:106`). With D2 it would block at once; a refusal at the start saves the run. These are the only
"orphan" faults that this format can have: the folder nesting gives each parent, and R6 refuses an unknown id.

**Alternatives** — Pull the missing dependency into the run. Rejected: it runs work that the user did not ask for.

**Verified by** — AC 15.

### D14: six fault folders, run through the real `/task` command

**Choice** — Add six spec folders under `task-formats/blend/`. Each is a small, otherwise valid spec with planted
faults:

| Folder | Planted fault | Expected response |
|---|---|---|
| `example-format-faults.spec` | a stray file, a `TASK.md` with no H1, an unknown front-matter key | refused, all three listed (R1, R4, R3) |
| `example-cycle.spec` | T1.1 after T1.2, T1.2 after T1.1 | refused, R7 names the cycle |
| `example-self-after.spec` | T1.1 after T1.1 | refused, R7 |
| `example-unknown-after.spec` | `after` names T7, which does not exist | refused, R6 |
| `example-no-ensures.spec` | a leaf `VERIFY.md` with no `ensures` | refused, R3 (D11) |
| `example-outside-run.spec` | valid; T1.2 after T1.1, run as the T1.2 subtree | refused at the start (D13) |

A test in `packages/opencode/test/task/` runs `TaskCommand.run` on each folder and checks that the refusal names
every planted rule.

**Justification** — The 38 golden negatives test `Blend.load` against one-file changes to the T2 tree. The user
asked for whole spec folders, run through the harness. A spec folder cannot hold its own expected result (R1
refuses a stray file), so the expected results live in the test.

**Alternatives** — More golden negatives. Rejected: they do not go through the command or the TUI.

**Verified by** — AC 16.

### D15: two small valid specs for the live check

**Choice** — Add two valid spec folders that target the demo seed:

- `example-scenarios.spec` — one leaf task (a small pure function and its test), and one scenario S1 proved by a
  test titled `[S1]`. It reaches the acceptance stage and runs a scenario.
- `example-cascade.spec` — leaf T1.1, whose proof is a gate that always exits 1, with a budget of one attempt; leaf
  T1.2, after T1.1; and leaf T1.3, with no `after`. A run ends with T1.1 exhausted, T1.2 blocked by T1.1, and T1.3
  trusted.

`task-demo.sh` copies every `example-*.spec` folder into the demo folder.

**Justification** — The release-notes spec reaches its acceptance stage only after every task is trusted, and T1.5
waits on the outside task T9, so a demo run often ends before any scenario runs. The cascade folder makes the
question-13 fault happen on purpose, for the cost of two builder attempts, and shows D2 and D3 in the real TUI. A
gate that always fails does not depend on a model's judgement.

**Alternatives** — Use the release-notes spec for the live check. Rejected: about $1–3 and up to 30 minutes for each
run, and its failure is not certain.

**Verified by** — AC 17.

## Task UI (phase 4)

### D16: the task-ui reads the machine's classification; its view state is a machine

**Choice** — The task-ui classifies units only from the `status.json` tags (D8). The `ACTIVE` and `ENDED` lists
(`task-ui/store.ts:161-164`) and the Gantt's own state derivation from the history (`designs/5-gantt.tsx:29`) go.
The view state — `design`, `chosen`, `expanded`, `watching` (`store.ts:286-289`) and the watch's `armed` /
`disarm` (`watch.tsx:306`) — becomes one xstate machine. This adds `@jambudipa/xstate-effect` to
`packages/tui/package.json` (the root catalog already pins 0.2.0). The Board shows `blocked` tasks with their
upstream cause; `bmad-ux` sets the column.

**Justification** — The owner's requirement names the TUI. The TUI cannot drift from the engine when it reads the
engine's classification.

**Alternatives** — Keep Solid signals for the view state. Rejected: the requirement names them.

**Verified by** — AC 18.

### D17: the run header uses the spec title

**Choice** — Keep the format as it is: the spec id is the folder name and the title is the `SPEC.md` H1 (R4 already
requires it; `BlendModel.Spec` already has both). The first message becomes "Implementing spec **\<title\>**". The
TUI draws "Implementing spec" in muted text and the title in bold, from a structured field, not by parsing text. A
subtree run reads "Implementing **\<task id\> \<task title\>** from spec **\<title\>**". If the title is empty, the
spec id is the fallback. `status.json` `run` gains `title`.

**Justification** — The format has the rule "each fact once": the H1 gives the title. A front-matter `title` would
be a second source that can disagree with the H1. R4 makes the H1 required, so the fallback rarely applies.

**Alternatives** — An optional `id` and `title` in the `SPEC.md` front matter. Rejected: two sources for one fact,
and a format change for every spec. A tracker key (for example a Jira key) that differs from the folder name is
not part of this goal.

**Verified by** — AC 19.

### D18: a summary in the main body when the run ends

**Choice** — When the run machine reaches a final state, the supervisor writes one assistant-role text message to
the root session. It is markdown, built from the final `status.json` with no model call: the outcome; each failed,
exhausted or blocked task with its reason or upstream cause; each rejected scenario with its verdict reason; each
task's duration; and the run's cost.

**Justification** — Today the end of the run goes only to the background job's output (`core/command.ts:219-222`).
The reasons are already model text (the verifier's verdicts), so the summary reads as feedback from the model. As an
assistant message, it renders as markdown, and the user can ask a follow-up question with the summary in the
model's context.

**Alternatives** — Ask a model to write the summary. Rejected: it costs tokens and can misstate a verdict. A
`noReply` user message. Rejected: user messages render as plain text.

**Verified by** — AC 20.

### D19: failure reasons appear in the task views

**Choice** — A failed, exhausted or blocked task shows its reason or upstream cause in every design's expanded view
and in Peek's BUILDER heading. Collapsed views keep the glyph. `bmad-ux` sets the layout.

**Justification** — The reasons are in `status.json` (`tasks[].reason`), but only the Board shows them; the other
views show a cross and "failed · attempt N".

**Alternatives** — Show the reason only in the D18 summary. Rejected: the user needs it during the run, to decide
whether to stop it.

**Verified by** — AC 21.

### D20: scenarios appear in the TUI

**Choice** — `status.json` scenario entries gain `title`. Every design's expanded view lists the run's scenarios
with glyph, id, title and state, and a rejected scenario's reason. `bmad-ux` sets the layout.

**Justification** — Only the full-screen Matrix shows scenarios, as glyph and id. Scenario rejection text is shown
nowhere.

**Alternatives** — The Matrix only, with titles added. Rejected: most users never open the Matrix.

**Verified by** — AC 22.

### D21: per-task timings

**Choice** — Each task shows a live duration while it runs and its final duration once it ends, from the start and
end times in `status.json` (D8). `bmad-ux` chooses the designs and positions. The candidates with room are the
Gantt right column, the Matrix rows, the Board cards, the HUD selected-task line and the Peek heading; the Ledger,
Ticker and Dock are tight.

**Justification** — The machine's context holds the times (D8), so the TUI derives nothing. The user asked for UX
design for the placement.

**Alternatives** — Derive the times in the TUI store from `history[].at`. Rejected: a second derivation of state
outside the machine (D16).

**Verified by** — AC 23.

### D22: remove the `/task-design switch` hint

**Choice** — Delete the `{ key: "/task-design", label: "switch" }` entry from the shortcut bar
(`task-ui/ui.tsx:136`).

**Justification** — The user asked for it. `/task-design` stays in the command list.

**Alternatives** — None credible.

**Verified by** — AC 24.

### D23: the diamond grows and melts

**Choice** — While the run is active, the diamond in "◆ In the Flow" plays the frames `· ⬩ ⬪ ⬥ ◆ ⬥ ⬪ ⬩` in a loop,
at about 120 ms each, through the `opentui-spinner` element that `component/spinner.tsx` uses. It is a static `◆`
when the run's tags say it has ended, or when the `animations_enabled` setting is off. The plain-text uses (the Peek
title, the toast title) stay static.

**Justification** — The same shape as the Claude Code spinner: one glyph that grows, then shrinks. The diamond
glyphs already render in this TUI (the "diamonds" spinner style, `ui/spinner.ts:316-321`). The existing element
owns the frame timer, so the task-ui adds no timer of its own (D9).

**Alternatives** — Drive the frames from the task-ui's once-a-second clock. Rejected: too slow. A colour pulse with
no change of shape. Rejected: the user asked for growth.

**Verified by** — AC 25.

### D24: the run's tokens and cost are shown

**Choice** — For a `/task` root session, the prompt footer, the sidebar and the task-ui show the summed tokens and
cost of the run's harness sessions (the child sessions whose parent is the root), live from the synced session
data. The D18 summary sums the same sessions from the session store when the run ends.

**Justification** — The builder and verifier run in child sessions (`core/runner.ts:209-212`). Nothing adds a
child's cost to its parent (`core/session/projector.ts:90-114`), and the root session has no assistant message, so
its indicators show nothing or $0.00. A sum over stored session data is a query, not lifecycle state, so it does
not need a machine.

**Alternatives** — Add child costs to the parent for every session. Rejected: it changes the cost of every subagent
session in opencode, not only `/task` runs. Record usage as facts. Rejected: a new fact type for data that the
session store already holds.

**Verified by** — AC 26.

## Delivery

### D25: two paid live checks in the real TUI

**Choice** — After every scripted criterion and the quality gate pass, seed a new folder with `task-demo.sh` inside
`tmux` and run `/task` on the two D15 folders with the TUI's configured model. Capture the pane at the end of each
run. **Spend cap: 4 live runs, re-runs included, and $5 in total.** Past the cap, stop and ask the user.

**Justification** — Questions 6, 8, 9, 12 and 13 are about what the user sees in a real run. A scripted model cannot
show a real cost. `tmux` is installed (`/opt/homebrew/bin/tmux`), so an agent can drive the real TUI.

**Alternatives** — Only scripted TUI tests against a fixture status. Rejected: no real cost, no real verdict. The
release-notes spec. Rejected: see D15.

**Verified by** — AC 27.

### D26: merge into `dev` after phase 1, and again at the end

**Choice** — Merge `goal/task-harness-feedback` into `dev` with `git merge --no-ff` in the main checkout twice: once
when the phase-1 criteria and the quality gate pass, and once at the end. Never push.

**Justification** — The owner asked for the engine first because it fixes the observed bug. The phase-1 merge puts
that fix on `dev`, where the user runs demos, days before the rest is done.

**Alternatives** — One merge at the end. Credible, and simpler; say so at approval to choose it instead.

**Verified by** — AC 7, AC 28.

### D27: the paused `task-harness` goal stays separate, and must re-plan

**Choice** — This goal does not edit the paused `task-harness` goal or its criteria. Its R12 command report (its
AC 38) and its T2-scale task-ui check (its AC 34) stay there. Its engine and runner criteria assume the per-unit
machines that D1 removes, so that goal must re-plan through `eque2-code-plan-goal` after this goal merges.

**Justification** — That goal is re-planned and unapproved. Folding this work into it would hold these fixes behind
its 43 open criteria.

**Alternatives** — Add these questions to the `task-harness` goal. Rejected: see above.

**Verified by** — none — a scope boundary; it has no observable result in this goal.

## Research

No external research needed: the codebase and the port's own documentation answer every question.

- **Port capability** (`@jambudipa/xstate-effect` 0.2.0, `llms.txt` lines 7–12 and 57–60): parallel and history
  states, eventless (`always`) and delayed (`after`) transitions, final states, `invoke` and `spawnChild`, actors
  from Effects and Streams, `stateIn` / `and` / `or` guards, persisted snapshots through a `Schema` codec, an actor
  system with `system.get`, and `./graph` with `getAdjacencyMap`. Every mechanism in D1–D9 exists in the port.
- **Owner's prototype** (question 13): the release-notes plan in the real port, about 80 lines — 36 reachable
  states and 7 stuck without the cascade; 29 and 0 with it.

Two read-only code surveys on `dev` at `03bc3afb82`, 2026-10-14, found:

- **Q1 — checked before execution?** Yes. `TaskCommand.run` calls `Blend.load` (`core/command.ts:163`) before the
  git check, the plan and the background job. R1–R11 and R13 are implemented (`blend/index.ts`, `blend/rules.ts`);
  R12 is runtime only. All 38 golden negatives run in `test/task/blend.test.ts:100-119`. Not exhaustive: only the
  first failure is reported (D10), `ensures` is not enforced (D11), and a mid-run reload hides a failure (D12).
- **Q2 — how a failure appears.** A refusal is a `noReply` session message plus `run.reason`. A failed task is a ✗
  and "failed · attempt N"; only the Board shows its reason; scenario rejection text is shown nowhere (D18–D20).
- **Q3 — order honoured?** Yes, but only by the runner's `schedule`; no machine knows the order and no test proves
  it (D4, D5).
- **Q4 — graph checks.** Cycles (R7, depth-first search, `blend/rules.ts:113-150`), ancestor and descendant order,
  and unknown references (R6) are refused. Self-reference is caught as the cycle "T → T", with no test. A missing
  parent cannot occur. Gaps: a subtree run can wait for ever on a task outside it and drops scenarios silently
  (D13); a dead task strands its dependants (D2).
- **Q6 — scenarios.** They run as `bun test` tests titled `[S<n>]`, after all their `needs` are trusted. In the
  release-notes demo, T1.5 waits on T9, so the acceptance stage often never starts. Only the full-screen Matrix
  shows them (D15, D20).
- **Q7 — title.** Already in the format: the folder name gives the id, the H1 gives the title (D17).
- **Q9 — tokens and cost.** The harness agents run in child sessions; no cost rolls up to the root session, and the
  root session has no assistant message, so its indicators show $0.00 (D24).
- **Run end states today** (`engine-xstate/index.ts:623-628`): `refused`, `done`, `cancelled`, `needs_human`,
  `budget_exhausted`, `failed`. D3 keeps these names.
- **Overlap.** The paused, unapproved `task-harness` goal (`.claude/worktrees/task-harness`) covers the R12 command
  report and the T2-scale task-ui check, and its engine criteria assume per-unit machines (D27).
