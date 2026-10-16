import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Clock, Duration, Effect, Layer } from "effect"
import { createActor } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { TaskSessions } from "@/task/core/sessions"
import { TaskSupervisor } from "@/task/core/supervise/task"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { facts, loadPlan } from "./lib/machine"
import {
  eventually,
  hang,
  prompted,
  runOf,
  sent,
  settle,
  stored,
  storedFacts,
  storedTypes,
  type Turn,
  unitOf,
} from "./lib/supervise"

// Scenario SV11 (spec task-harness-feedback, D7, AD-8, AD-11; tasks T2.7, T2.8; conformance H14): a spend cap stops
// the task for a human before any nudge.
//
//   Given a building task
//   When a retry status or the turn's error names the spend cap
//   Then task.needs_human is recorded with a reason that starts "spend cap:"
//   And no nudge is recorded
//
// The task is T1.1 of the release-notes plan, building in a run actor folded from its stored slice. Everything that
// runs is the real code: the task supervisor machine, its builder-turn and record workers, its `sessionEvents` relay
// on the real event bus, and a real Recorder over the real event store, whose run actor folds each recorded fact.
// Only the model side is scripted (the session boundary of `lib/supervise.ts`): a turn either runs until it is
// stopped, or ends, leaving the assistant message the provider wrote. The stream idle time is longer than any test
// here, so no stall can stand in for the behaviour under test. Each "when" has a control beside it: a retry status
// that is not a spend cap records nothing, and a turn that ends on another error is nudged, so a missing nudge in the
// spend-cap cases is the cap's doing.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const LIMITS: TaskLimits.Limits = { ...TaskLimits.scripted, streamIdle: Duration.seconds(600) }
const SESSION = "ses_T1.1"
const NO_READY = "the builder ended without task_ready"

// A building T1.1 and its task supervisor, spawned as the run supervisor would spawn it for the unit's newest entry.
const building = Effect.fnUntraced(function* (turns: ReadonlyArray<Turn>, messages: Array<unknown> = []) {
  const plan = yield* loadPlan("release-notes.spec")
  const f = facts()
  const setup = yield* runOf({
    plan,
    directory: "/root",
    stored: [f.runStarted(plan.path), f.started("T1.1")],
    turns,
    messages,
    limits: LIMITS,
  })
  // The Given: T1.1 is building in the run actor, with its builder session.
  const before = yield* setup.recorder.actor.getSnapshot
  expect(TaskEngineXState.unitState(before, "T1.1")).toBe("building")
  expect(before.hasTag("T1.1:building")).toBe(true)
  const unit = unitOf(before, "T1.1")
  expect(unit.session).toBe(SESSION)
  sent.set(`${setup.id}:T1.1`, unit.entry)
  const task = plan.tasks.find((item) => item.id === "T1.1")
  if (task === undefined) throw new Error("no task T1.1")
  const actor = yield* createActor(TaskSupervisor.machine, {
    input: {
      run: setup.run,
      events: setup.events,
      task,
      spec: plan.spec,
      owner: `task:${setup.id}:T1.1`,
      entry: unit.entry,
      tags: unit.tags,
      session: SESSION,
      runStart: 0,
    } satisfies TaskSupervisor.Input,
  })
  yield* actor.start
  const quiet = eventually(
    Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches({ live: { work: "quiet" } })),
    "the supervisor is quiet",
  )
  const unitState = Effect.map(setup.recorder.actor.getSnapshot, (snapshot) =>
    TaskEngineXState.unitState(snapshot, "T1.1"),
  )
  return { setup, actor, quiet, unitState }
})

const retry = (events: EventV2.Interface, message: string) =>
  events.publish(SessionStatus.Event.Status, {
    sessionID: SessionID.make(SESSION),
    status: { type: "retry", attempt: 1, message, next: 0 },
  })

// The session's messages: filled by the turn that runs (one test at a time in this file).
const turnMessages: Array<unknown> = []

// The assistant message a provider leaves when the turn ends on an error opencode does not retry.
const assistantError =
  (message: string): Turn =>
  () =>
    Effect.flatMap(Clock.currentTimeMillis, (created) =>
      Effect.sync(() => {
        turnMessages.push({ info: { role: "assistant", time: { created }, error: { data: { message } } }, parts: [] })
      }),
    )

// Waits for a few more macrosteps of the supervisor and its workers, so that a fact that would follow has time to.
const longSettle = Effect.sleep(400)

it.live(
  "[SV11] a retry status that names the spend cap records task.needs_human with a 'spend cap:' reason, stops the turn, and records no nudge; a retry status that names no spend cap records nothing",
  () =>
    Effect.gen(function* () {
      const { setup, actor, quiet, unitState } = yield* building([hang])
      yield* prompted(setup.seen, 1)
      yield* eventually(
        Effect.map(actor.getSnapshot, (snapshot) =>
          snapshot.matches({ live: { work: { building: { turn: "watching" } } } }),
        ),
        "the builder turn is watched",
      )
      yield* settle

      // Control: a provider retry that is not a spend cap records nothing, and the turn goes on.
      yield* retry(setup.events, "Rate limited by the provider: retrying in 2 s")
      yield* longSettle
      expect(yield* storedTypes(setup.id)).toEqual([])
      expect(setup.seen.cancels).toEqual([])
      expect((yield* actor.getSnapshot).matches({ live: { work: { building: { turn: "watching" } } } })).toBe(true)

      // When a retry status names the spend cap.
      const capped = "You exceeded your current quota, please check your plan and billing details"
      expect(TaskSessions.SPEND_CAP.test(capped)).toBe(true)
      yield* retry(setup.events, capped)
      yield* stored(setup.id, 1)

      // Then task.needs_human is recorded with a reason that starts "spend cap:".
      const recorded = yield* storedFacts(setup.id)
      expect(recorded).toMatchObject([{ type: "task.needs_human", task: "T1.1", reason: `spend cap: ${capped}` }])
      const fact = recorded[0]
      expect(fact?.type === "task.needs_human" && fact.reason.startsWith("spend cap:")).toBe(true)
      // The turn was stopped, and the fact folded: T1.1 waits for a human.
      expect(setup.seen.cancels).toEqual([SESSION])
      yield* eventually(
        Effect.map(unitState, (state) => state === "needs_human"),
        "T1.1 needs a human in the run actor",
      )

      // And no nudge is recorded: the supervisor waits quietly, with no second prompt and no nudge spent.
      yield* quiet
      yield* longSettle
      expect(yield* storedTypes(setup.id)).toEqual(["task.needs_human"])
      expect(setup.seen.prompts).toHaveLength(1)
      expect(setup.seen.prompts.map((prompt) => prompt.text)).not.toContain(TaskSessions.nudgeMessage)
      expect((yield* actor.getSnapshot).context.nudges).toBe(0)
    }),
  90_000,
)

it.live(
  "[SV11] a turn that ends on a spend-cap error records task.needs_human with a 'spend cap:' reason and no nudge, where a turn that ends on another error is nudged",
  () =>
    Effect.gen(function* () {
      // Control: the turn ends on an error that names no spend cap. The builder did not call task_ready, so the
      // idle end is nudged.
      turnMessages.length = 0
      const control = yield* building([assistantError("overloaded_error: the provider is overloaded")], turnMessages)
      yield* stored(control.setup.id, 1)
      yield* control.quiet
      yield* longSettle
      expect(yield* storedFacts(control.setup.id)).toMatchObject([
        { type: "task.nudged", task: "T1.1", nudge: 1, reason: NO_READY },
      ])

      // When the turn's error names the spend cap.
      turnMessages.length = 0
      const capped = "insufficient_quota: You exceeded your current quota"
      const { setup, actor, quiet, unitState } = yield* building([assistantError(capped)], turnMessages)
      yield* stored(setup.id, 1)

      // Then task.needs_human is recorded with a reason that starts "spend cap:".
      const recorded = yield* storedFacts(setup.id)
      expect(recorded).toMatchObject([{ type: "task.needs_human", task: "T1.1", reason: `spend cap: ${capped}` }])
      const fact = recorded[0]
      expect(fact?.type === "task.needs_human" && fact.reason.startsWith("spend cap:")).toBe(true)
      yield* eventually(
        Effect.map(unitState, (state) => state === "needs_human"),
        "T1.1 needs a human in the run actor",
      )

      // And no nudge is recorded: the spend cap comes before the nudge the idle end would otherwise give.
      yield* quiet
      yield* longSettle
      expect(yield* storedTypes(setup.id)).toEqual(["task.needs_human"])
      expect((yield* actor.getSnapshot).context.nudges).toBe(0)
      expect(setup.seen.prompts).toHaveLength(1)
    }),
  90_000,
)
