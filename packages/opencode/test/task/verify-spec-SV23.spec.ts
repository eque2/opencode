import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer, Option, Predicate, Semaphore } from "effect"
import path from "path"
import { createActor, SimulatedClock } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { TaskHarness } from "@/task/core/harness"
import type { Fact } from "@/task/core/model"
import { TaskRecorder } from "@/task/core/recorder"
import { RunSupervisor } from "@/task/core/supervise/run"
import type { TaskWorkers } from "@/task/core/workers"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { facts, loadPlan } from "./lib/machine"
import { BASE, boundary, eventually, repository, storedFacts, type Turn } from "./lib/supervise"

// Scenario SV23 (spec task-harness-feedback, AD-11, D7; tasks T2.7, T2.8): a running tool is not a stall.
//
//   Given a building task whose tool runs longer than the stream idle time
//   When the clock passes the stream idle time while the tool runs
//   Then no task.stalled is recorded
//   And the stall timer starts again when the tool ends
//
// Everything that runs is the real code: the real run supervisor (a root actor on a SimulatedClock, so the stall
// timers move only when the test moves the clock), the REAL task supervisors it spawns, each with its real
// `sessionEvents` relay subscribed to the real event bus, a real Recorder over the real event store, the real
// release-notes spec for the run's stale checks, and a scratch git repository as the run's directory. The model side
// is the bus: the test publishes the MessageV2 tool-part updates a running tool makes (`running`, then `completed`)
// for the builder's session; every builder prompt runs until it is stopped. The bounds are the scripted ones:
// `streamIdle` is 2 s.
//
// The run resumes a slice in which T1.1 and T1.2 build. T1.1's builder runs a tool; T1.2's builder is silent, so it
// is the control on the same clock: it stalls once the clock passes the stream idle time.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SPEC_DIR = path.resolve(import.meta.dir, "../../../../task-formats/blend/release-notes.spec")
const LIMITS = TaskLimits.scripted
const STALL = "stall: no stream activity for 2 s"
const CONTINUE = "Continue the task from where you stopped. When it is done, call task_ready once and end your turn."
const T1_1 = "ses_T1.1"
const T1_2 = "ses_T1.2"

// The tool-part update a running tool publishes for its session, and the one it publishes when it ends.
const tool = (events: EventV2.Interface, session: string, status: "running" | "completed") =>
  events.publish(MessageV2.Event.PartUpdated, {
    sessionID: SessionID.make(session),
    part: {
      id: PartID.ascending(),
      sessionID: SessionID.make(session),
      messageID: MessageID.ascending(),
      type: "tool" as const,
      callID: "call_sv23",
      tool: "bash",
      state:
        status === "running"
          ? { status, input: { command: "bun test" }, time: { start: 1 } }
          : {
              status,
              input: { command: "bun test" },
              output: "ok",
              title: "bun test",
              metadata: {},
              time: { start: 1, end: 2 },
            },
    },
    time: Date.now(),
  })

// Lets the relays, the supervisors and the record workers take what was just published or fired.
const settle = Effect.sleep(300)

// Publishes a tool-part update until the supervisor's turn shows it. The relay subscribes on its own fiber when the
// turn starts, so a first update can come before it listens; a repeated update of the same kind changes nothing.
const publishUntil = Effect.fnUntraced(function* (
  publish: Effect.Effect<unknown>,
  turn: Effect.Effect<string, unknown>,
  wanted: string,
) {
  for (let tries = 0; tries < 100; tries++) {
    yield* publish
    yield* Effect.sleep(100)
    if ((yield* turn) === wanted) return yield* Effect.void
  }
  return yield* Effect.die(new Error(`the turn never reached ${wanted}`))
})

it.live(
  "[SV23] no task.stalled while the builder's tool runs past the stream idle time, and the stall timer starts again when the tool ends",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const root = yield* repository()
      const events = yield* EventV2Bridge.Service
      const harness = yield* TaskHarness.make
      const clock = new SimulatedClock()
      const id = "task_sv23tool"
      const f = facts()

      const stored = [f.runStarted(plan.path), f.started("T1.1"), f.started("T1.2")]
      const recorder = yield* TaskRecorder.make({ plan, runID: id, directory: root, stored, events })
      const hang: Turn = () => Effect.never
      const { env, seen } = boundary(Array.from({ length: 40 }, () => hang))
      const run: TaskWorkers.Run = {
        env,
        id,
        directory: root,
        base: BASE,
        specDir: SPEC_DIR,
        plan,
        root: SessionID.make("ses_sv23_root"),
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

      const promptsOf = (session: string) => seen.prompts.filter((prompt) => prompt.session === session)
      const stallsOf = (task: string) =>
        Effect.map(storedFacts(id), (list) =>
          list.filter(
            (fact): fact is Extract<Fact, { type: "task.stalled" }> =>
              fact.type === "task.stalled" && fact.task === task,
          ),
        )
      // The state of a task supervisor's builder turn: `watching` (the stall timer runs) or `tool`.
      const turnOf = (task: string) =>
        Effect.gen(function* () {
          const ref = yield* supervisor.system.get(TaskHarness.systemId.task(id, task))
          if (Option.isNone(ref)) return "none"
          const snapshot: unknown = yield* ref.value.getSnapshot
          const value = Predicate.hasProperty(snapshot, "value") ? JSON.stringify(snapshot.value) : ""
          if (value.includes('"turn":"tool"')) return "tool"
          if (value.includes('"turn":"watching"')) return "watching"
          return value
        })

      // Given a building task whose tool runs: T1.1's builder is prompted and its tool starts running.
      yield* eventually(
        Effect.sync(() => promptsOf(T1_1).length === 1 && promptsOf(T1_2).length === 1),
        "both builders are prompted",
      )
      yield* settle
      expect(yield* turnOf("T1.1")).toBe("watching")
      yield* publishUntil(tool(events, T1_1, "running"), turnOf("T1.1"), "tool")
      expect(yield* turnOf("T1.2")).toBe("watching")

      // When the clock passes the stream idle time while the tool runs: 10 s, five times the stream idle time.
      yield* clock.increment(10_000)
      // The silent T1.2 on the same clock stalls: the clock did pass the stream idle time.
      yield* eventually(
        Effect.map(stallsOf("T1.2"), (list) => list.length >= 1),
        "the silent control task stalls",
      )
      yield* settle

      // Then no task.stalled is recorded for the task whose tool runs; its turn goes on with no stall timer.
      expect(yield* stallsOf("T1.1")).toEqual([])
      expect(seen.cancels).not.toContain(T1_1)
      expect(promptsOf(T1_1)).toHaveLength(1)
      expect(yield* turnOf("T1.1")).toBe("tool")
      expect((yield* stallsOf("T1.2"))[0]).toMatchObject({ task: "T1.2", reason: STALL })

      // And the stall timer starts again when the tool ends.
      yield* publishUntil(tool(events, T1_1, "completed"), turnOf("T1.1"), "watching")
      yield* clock.increment(1_900)
      yield* settle
      expect(yield* stallsOf("T1.1")).toEqual([])
      expect(seen.cancels).not.toContain(T1_1)
      yield* clock.increment(200)
      yield* eventually(
        Effect.map(stallsOf("T1.1"), (list) => list.length === 1),
        "T1.1 stalls 2 s after its tool ended",
      )
      expect(yield* stallsOf("T1.1")).toEqual([
        { type: "task.stalled", at: expect.any(Number), task: "T1.1", reason: STALL },
      ])
      // The stall cancels the turn and prompts again with the continue message, in the same attempt.
      yield* eventually(
        Effect.sync(() => seen.cancels.includes(T1_1) && promptsOf(T1_1).length === 2),
        "T1.1's stalled turn is cancelled and continued",
      )
      expect(promptsOf(T1_1)[1]?.text).toBe(CONTINUE)
      expect(seen.cancels.filter((session) => session === T1_1)).toHaveLength(1)
    }),
  120_000,
)
