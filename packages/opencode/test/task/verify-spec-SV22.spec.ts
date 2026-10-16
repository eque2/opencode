import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Deferred, Duration, Effect, Layer, Option, Predicate, Semaphore } from "effect"
import path from "path"
import { createActor, SimulatedClock } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { TaskHarness } from "@/task/core/harness"
import { TaskRecorder } from "@/task/core/recorder"
import { RunSupervisor } from "@/task/core/supervise/run"
import type { TaskWorkers } from "@/task/core/workers"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { facts, loadPlan } from "./lib/machine"
import { BASE, boundary, eventually, repository, storedFacts, type Turn } from "./lib/supervise"

// Scenario SV22 (spec task-harness-feedback, AD-8, D7; task T2.8): the task wall clock fails only its own task.
//
//   Given a building task and an independent task that also builds
//   When the first task's wall clock expires
//   Then its supervisor records task.failed with the wall-clock reason
//   And the independent task keeps building
//
// Everything that runs is the real code: the real run supervisor (a root actor on a SimulatedClock, as
// supervise-run.test.ts runs it, so its timers and its children's move only when the test moves the clock), the REAL
// task supervisors it spawns for the building tasks, a real Recorder over the real event store, the real
// release-notes spec for the run's stale checks, and a scratch git repository as the run's directory. The session
// side is scripted: a builder prompt runs until it is stopped, except the first turn of T1.2, which ends (without
// task_ready) when the test releases it.
//
// The run resumes a slice in which the independent leaves T1.1 and T1.2 both build. The task wall clock is 1 min and
// the stall bound is out of reach. Both clocks start at the resume. At 30 s T1.2's builder ends its turn without
// task_ready, so its supervisor nudges it and it builds on: its clock restarts at that latest building entry (the
// `clock` region and `taskClockStart`: one delayed transition from the latest building entry). T1.1's clock expires
// at 60 s; T1.2's at 90 s.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))
const engine = TaskEngineXState

const SPEC_DIR = path.resolve(import.meta.dir, "../../../../task-formats/blend/release-notes.spec")
// The scripted bounds with a 1-min task wall clock, and a stall bound no test reaches.
const LIMITS: TaskLimits.Limits = {
  ...TaskLimits.scripted,
  streamIdle: Duration.hours(24),
  taskWallClock: Option.some(Duration.minutes(1)),
}
const REASON = "wall clock: the task took over 1 min"
const NUDGE = "Call task_ready when the task is done."
const T1_1 = "ses_T1.1"
const T1_2 = "ses_T1.2"

// Lets the relays, the supervisors and the record workers take what the clock just fired.
const settle = Effect.sleep(300)

it.live(
  "[SV22] the wall clock of a building task fails only that task, while an independent task keeps building",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const root = yield* repository()
      const events = yield* EventV2Bridge.Service
      const harness = yield* TaskHarness.make
      const clock = new SimulatedClock()
      const id = "task_sv22wallclock"
      const f = facts()

      // Given a building task and an independent task that also builds: T1.1 and T1.2, leaves with no `after`.
      expect(plan.tasks.find((task) => task.id === "T1.1")?.after).toEqual([])
      expect(plan.tasks.find((task) => task.id === "T1.2")?.after).toEqual([])
      const stored = [f.runStarted(plan.path), f.started("T1.1"), f.started("T1.2")]
      const recorder = yield* TaskRecorder.make({ plan, runID: id, directory: root, stored, events })
      const idle = yield* Deferred.make<void>()
      const turns = new Map<string, number>()
      const turn: Turn = (prompt) => {
        const count = (turns.get(prompt.session) ?? 0) + 1
        turns.set(prompt.session, count)
        // T1.2's first turn ends without task_ready once the test releases it; every other turn runs until stopped.
        return prompt.session === T1_2 && count === 1 ? Deferred.await(idle) : Effect.never
      }
      const { env, seen } = boundary(Array.from({ length: 40 }, () => turn))
      const run: TaskWorkers.Run = {
        env,
        id,
        directory: root,
        base: BASE,
        specDir: SPEC_DIR,
        plan,
        root: SessionID.make("ses_sv22_root"),
        model: { providerID: "test", modelID: "test" },
        limits: LIMITS,
        locks: { checkout: yield* Semaphore.make(1), git: yield* Semaphore.make(1) },
        recorder,
        claim: harness.claimSession,
      }
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

      const recorded = storedFacts(id)
      const promptsOf = (session: string) => seen.prompts.filter((prompt) => prompt.session === session)
      const supervisorOf = (task: string) => supervisor.system.get(TaskHarness.systemId.task(id, task))
      const building = (task: string) =>
        Effect.gen(function* () {
          const ref = yield* supervisorOf(task)
          if (Option.isNone(ref)) return false
          const snapshot: unknown = yield* ref.value.getSnapshot
          // The supervisor's `live.work` region is in `building` (a builder turn of the current attempt).
          return (
            Predicate.hasProperty(snapshot, "value") && JSON.stringify(snapshot.value).includes('"work":{"building"')
          )
        })

      // Both builders are prompted in their own sessions; both clocks run from the resume.
      yield* eventually(
        Effect.sync(() => promptsOf(T1_1).length === 1 && promptsOf(T1_2).length === 1),
        "both builders are prompted",
      )
      yield* settle
      expect((yield* recorded).map((fact) => fact.type)).toEqual(["run.resumed"])
      expect(yield* building("T1.1")).toBe(true)
      expect(yield* building("T1.2")).toBe(true)

      // At 30 s nothing has expired. T1.2's builder ends its turn without task_ready: it is nudged and builds on.
      yield* clock.increment(30_000)
      yield* settle
      expect((yield* recorded).map((fact) => fact.type)).toEqual(["run.resumed"])
      yield* Deferred.succeed(idle, undefined)
      yield* eventually(
        Effect.sync(() => promptsOf(T1_2).length === 2),
        "T1.2 is nudged",
      )
      yield* settle
      expect((yield* recorded).slice(1)).toMatchObject([{ type: "task.nudged", task: "T1.2", nudge: 1 }])
      expect(promptsOf(T1_2)[1]?.text).toBe(NUDGE)

      // When the first task's wall clock expires (60 s).
      yield* clock.increment(30_000)
      yield* eventually(
        Effect.map(recorded, (list) => list.some((fact) => fact.type === "task.failed")),
        "T1.1's clock expires",
      )
      yield* settle

      // Then its supervisor records task.failed with the wall-clock reason, and cancels only its own turn.
      expect((yield* recorded).slice(2)).toEqual([
        { type: "task.failed", at: expect.any(Number), task: "T1.1", reason: REASON },
      ])
      // The run actor folds the fact right after the store (one permit), and the turn's cancel runs as the supervisor
      // leaves its live work: under load either can trail the store read.
      yield* eventually(
        Effect.map(recorder.actor.getSnapshot, (snapshot) => engine.unitState(snapshot, "T1.1") === "failed"),
        "the run actor folds T1.1's failure",
      )
      yield* eventually(
        Effect.sync(() => seen.cancels.length > 0),
        "T1.1's turn is cancelled",
      )
      expect(seen.cancels).toEqual([T1_1])
      const failed = yield* recorder.actor.getSnapshot
      expect(engine.unitState(failed, "T1.1")).toBe("failed")
      // T1.1's dependants are blocked by it; the run waits, as T1.2 still builds.
      expect(engine.blockedBy(failed, "T1.3")).toEqual({ id: "T1.1", state: "failed" })
      expect(engine.ended(failed)).toBe(false)
      yield* eventually(Effect.map(supervisorOf("T1.1"), Option.isNone), "T1.1's supervisor stops")

      // And the independent task keeps building: its state, its live supervisor, its open turn, and no fact of its own.
      expect(engine.unitState(failed, "T1.2")).toBe("building")
      expect(yield* building("T1.2")).toBe(true)
      expect(promptsOf(T1_2)).toHaveLength(2)
      expect(seen.cancels).not.toContain(T1_2)
      yield* clock.increment(29_000)
      yield* settle
      expect((yield* recorded).map((fact) => fact.type)).toEqual(["run.resumed", "task.nudged", "task.failed"])
      expect(engine.unitState(yield* recorder.actor.getSnapshot, "T1.2")).toBe("building")
      expect(yield* building("T1.2")).toBe(true)

      // T1.2 fails only on its own clock, 60 s after its latest building entry, and the run then ends.
      yield* clock.increment(1_000)
      yield* eventually(
        Effect.map(recorded, (list) => list.filter((fact) => fact.type === "task.failed").length === 2),
        "T1.2's own clock expires",
      )
      expect((yield* recorded).slice(3)).toEqual([
        { type: "task.failed", at: expect.any(Number), task: "T1.2", reason: REASON },
      ])
      yield* eventually(
        Effect.sync(() => seen.cancels.length > 1),
        "T1.2's turn is cancelled",
      )
      expect(seen.cancels).toEqual([T1_1, T1_2])
      yield* eventually(
        Effect.map(recorder.actor.getSnapshot, (snapshot) => engine.ended(snapshot)),
        "the run ends once every task is final",
      )
      expect(engine.view(yield* recorder.actor.getSnapshot).run.state).toBe("failed")
    }),
  120_000,
)
