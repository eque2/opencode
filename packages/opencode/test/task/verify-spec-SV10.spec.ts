import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer, Option, Semaphore } from "effect"
import path from "path"
import { createActor, SimulatedClock } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { TaskRecorder } from "@/task/core/recorder"
import { RunSupervisor } from "@/task/core/supervise/run"
import type { TaskWorkers } from "@/task/core/workers"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { facts, loadPlan } from "./lib/machine"
import { BASE, boundary, deltaOf, eventually, hang, settle, storedFacts, storedTypes } from "./lib/supervise"

// Scenario SV10 (spec task-harness-feedback, D7, AD-8, AD-10, conformance H12; tasks T2.7, T2.8): a stalled builder
// stream is cancelled and prompted again in the same attempt.
//
//   Given a building task whose model stream goes quiet with no tool running
//   When the stream idle time passes
//   Then the turn is cancelled and task.stalled is recorded
//   And the builder is prompted again with the continue message in the same attempt
//   And no nudge and no attempt is spent
//
// The run supervisor is the real machine, a root actor on a SimulatedClock; it spawns the real task supervisor of T1.1
// and sends it `unit.moved` for each new entry, so the prompt after the stall comes from the real dispatch. The plan is
// the T1.1 subtree of release-notes, resumed with T1.1 building. The Recorder and the event store are real; the
// session side is the scripted boundary of lib/supervise, whose prompts never end. Stream activity is a real part
// delta on the event bus, which the real `sessionEvents` relay turns into `turn.activity`. streamIdle is the scripted
// bound, 2 s.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SPEC_DIR = path.resolve(import.meta.dir, "../../../../task-formats/blend/release-notes.spec")

// The continue message, as D7 and the conformance suite (H12) word it.
const CONTINUE = "Continue the task from where you stopped. When it is done, call task_ready once and end your turn."

let runs = 0

it.live(
  "[SV10] a quiet builder stream is cancelled after streamIdle, task.stalled is recorded, and the builder continues in the same attempt",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec", "T1.1")
      const f = facts()
      const events = yield* EventV2Bridge.Service
      const id = `task_sv10run${(runs++).toString(16).padStart(4, "0")}`
      const recorder = yield* TaskRecorder.make({
        plan,
        runID: id,
        directory: "/root",
        stored: [f.runStarted(plan.path), f.started("T1.1")],
        events,
        write: () => Effect.void,
      })
      const { env, seen } = boundary([hang, hang, hang, hang])
      const run: TaskWorkers.Run = {
        env,
        id,
        directory: "/root",
        base: BASE,
        specDir: SPEC_DIR,
        plan,
        root: SessionID.make("ses_sv10_root"),
        model: { providerID: "test", modelID: "test" },
        limits: TaskLimits.scripted,
        locks: { checkout: yield* Semaphore.make(1), git: yield* Semaphore.make(1) },
        recorder,
        claim: (claim) => Effect.sync(() => seen.claims.push(claim)),
      }
      const clock = new SimulatedClock()
      const supervisor = yield* createActor(RunSupervisor.machine, {
        input: {
          run,
          events,
          resumed: true,
          path: plan.path,
          trusts: Effect.succeed([]),
          externals: [],
          release: Effect.void,
          writer: recorder.writer,
        } satisfies RunSupervisor.Input,
        clock,
      })
      yield* supervisor.start
      const view = Effect.map(recorder.actor.getSnapshot, (snapshot) => TaskEngineXState.view(snapshot))
      const taskSupervisor = Effect.flatMap(supervisor.system.get(`task:${id}:T1.1`), (ref) =>
        Option.match(ref, {
          onNone: () => Effect.die(new Error("no task supervisor of T1.1")),
          onSome: (actor) => actor.getSnapshot,
        }),
      )
      const prompted = (count: number) =>
        eventually(
          Effect.sync(() => seen.prompts.length === count),
          `${count} builder prompts`,
        )

      // Given a building task: the run supervisor spawned T1.1's supervisor, whose first turn is in flight.
      yield* prompted(1)
      yield* settle
      expect((yield* view).tasks["T1.1"]).toMatchObject({ state: "building", attempts: 1 })
      expect(seen.prompts[0]).toMatchObject({ session: "ses_T1.1", agent: "task-builder" })
      expect(seen.prompts[0]?.text.split("\n")[0]).toBe("task-harness role=builder task=T1.1")
      expect(seen.claims).toEqual([{ session: "ses_T1.1", owner: `task:${id}:T1.1`, watch: true }])
      // Stream activity before streamIdle restarts the timer: 1.5 s, a part delta, 1.5 s more, and nothing stalls.
      yield* clock.increment(1_500)
      yield* deltaOf(events, "ses_T1.1")
      yield* settle
      yield* clock.increment(1_500)
      yield* settle
      expect(yield* storedTypes(id)).toEqual(["run.resumed"])
      expect(seen.cancels).toEqual([])

      // When the stream stays quiet, with no tool running, until streamIdle passes.
      yield* clock.increment(500)
      yield* eventually(
        Effect.map(storedTypes(id), (types) => types.includes("task.stalled")),
        "task.stalled",
      )

      // Then the turn is cancelled and task.stalled is recorded.
      expect(seen.cancels).toEqual(["ses_T1.1"])
      expect((yield* storedFacts(id)).at(-1)).toMatchObject({
        type: "task.stalled",
        task: "T1.1",
        reason: "stall: no stream activity for 2 s",
      })
      // And the builder is prompted again with the continue message, in the same session and the same attempt.
      yield* prompted(2)
      expect(seen.prompts[1]).toEqual({ session: "ses_T1.1", agent: "task-builder", text: CONTINUE })
      // And no nudge and no attempt is spent.
      expect((yield* view).tasks["T1.1"]).toMatchObject({ state: "building", attempts: 1 })
      expect(yield* storedTypes(id)).toEqual(["run.resumed", "task.stalled"])
      expect((yield* taskSupervisor).context.nudges).toBe(0)

      // A second quiet stream does the same: one more stall, one more continue prompt, still attempt 1 and no nudge.
      yield* settle
      yield* clock.increment(2_000)
      yield* prompted(3)
      expect(seen.cancels).toEqual(["ses_T1.1", "ses_T1.1"])
      expect(seen.prompts[2]).toEqual({ session: "ses_T1.1", agent: "task-builder", text: CONTINUE })
      expect(yield* storedTypes(id)).toEqual(["run.resumed", "task.stalled", "task.stalled"])
      expect((yield* view).tasks["T1.1"]).toMatchObject({ state: "building", attempts: 1 })
      expect((yield* taskSupervisor).context.nudges).toBe(0)
      // Each turn claimed the same builder session first.
      expect(seen.claims.map((claim) => claim.session)).toEqual(["ses_T1.1", "ses_T1.1", "ses_T1.1"])
    }),
  60_000,
)
