import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Fiber, Layer, Option } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact } from "@/task/core/model"
import { RunSupervisor } from "@/task/core/supervise/run"
import { testEffect } from "../lib/effect"
import { facts, fold, loadPlan, trustLeaf, unitState } from "./lib/machine"
import { type Jobs, jobsOf, refusalOf, runTask, SPEC, seed } from "./lib/command"
import { eventually, runOf } from "./lib/supervise"

// Scenario VF7 (spec task-harness-feedback, D13, AD-15, SV20): a subtree run whose outside folder task is trusted
// runs, and /task trust cannot trust a folder task.
//
//   Given a stored run in which T1.1 ended trusted
//   When /task runs on the T1.3 task folder
//   Then the run starts and its external region for T1.1 is trusted directly after run.started
//   And /task trust T1.1 never moves an external region
//
// The spec is a committed copy of release-notes.spec in a git instance. `/task` is the real `TaskCommand.run` with
// the real harness root, loader, event store, Recorder, run machine and run supervisor; the job registry runs the
// real job on its own fiber, and the session side is a scripted boundary. `/task trust <id>` is the same real
// command. `/task trust T9` and `/task trust T8` (outside preconditions of the spec) are the positive controls: they
// prove the trust reaches the live run, and, sent after `T1.1`, that the run handled the `T1.1` trust first.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const T13_FOLDER = "T1-release-notes.task/T1.3-markdown-render.task"
const T13 = `${SPEC}/${T13_FOLDER}`
const R12 = `R12 ${T13_FOLDER}: T1.3 is after T1.1, which is outside this run and not trusted`
const STARTED = "Implementing **T1.3 Render the release notes as Markdown** from spec"
const TRUST_REPLY = (id: string) => `Task harness: recorded the outside precondition ${id} as trusted.`

// The facts on the run's aggregate, and its newest slice.
const storedOf = (aggregate: string) =>
  Effect.gen(function* () {
    const db = yield* Database.Service
    return yield* TaskEvents.read(db.db, aggregate)
  })
const newestSlice = (aggregate: string) =>
  Effect.map(storedOf(aggregate), (stored) =>
    Option.getOrElse(TaskEvents.latestRun(stored), (): ReadonlyArray<Fact> => []),
  )

const trustedIds = (list: ReadonlyArray<Fact>) =>
  list.flatMap((fact) => (fact.type === "outside.trusted" ? [fact.id] : []))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

// The run supervisor `run:<runID>` is in its `running` state and holds the run actor's first snapshot: from then on
// it handles a forwarded trust in its `running` state, so the controls below do not race its start-up.
const supervising = (harness: TaskHarness.Interface, runID: string) =>
  eventually(
    Effect.gen(function* () {
      const ref = yield* harness.system.get(TaskHarness.systemId.run(runID))
      if (Option.isNone(ref)) return false
      const snapshot: unknown = yield* ref.value.getSnapshot
      if (!isRecord(snapshot) || !isRecord(snapshot.value) || !("running" in snapshot.value)) return false
      const latest = isRecord(snapshot.context) ? snapshot.context.latest : undefined
      return Option.isOption(latest) && Option.isSome(latest)
    }),
    "the run supervisor running with the run's snapshot",
  )

// A whole-spec slice in which T1.1 ended trusted, stored on the run's aggregate.
const storeTrustedSlice = (directory: string) =>
  Effect.gen(function* () {
    const whole = yield* loadPlan("release-notes.spec")
    const f = facts()
    const slice = [f.runStarted(SPEC), ...trustLeaf(whole, f, "T1.1")]
    const events = yield* EventV2Bridge.Service
    for (const fact of slice) yield* TaskEvents.publish(events, TaskEvents.runID(directory, SPEC), fact)
    return { whole, slice }
  })

// Ends the jobs the registry ran, as a cancel would.
const stopJobs = (jobs: Jobs) =>
  Effect.gen(function* () {
    jobs.status = "cancelled"
    for (const fiber of jobs.fibers) yield* Fiber.interrupt(fiber)
  })

it.instance(
  "[VF7] after a stored run in which T1.1 ended trusted, the T1.3 subtree run starts and trusts its external region T1.1 directly after run.started",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const runID = TaskEvents.runID(directory, SPEC)

      // Given: a stored whole-spec run whose fold has T1.1 trusted.
      const { whole, slice } = yield* storeTrustedSlice(directory)
      expect(unitState(fold(whole, slice), "T1.1")).toBe("trusted")
      expect(yield* storedOf(runID)).toHaveLength(slice.length)
      const subtree = yield* loadPlan("release-notes.spec", "T1.3")
      expect(subtree.external).toEqual(["T1.1"])

      // When /task runs on the T1.3 task folder.
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      jobs.mode = "run"
      const replies = yield* runTask(harness, T13, jobs)

      // Then the run starts: the run header, one job, the directory's lease.
      expect(replies).toHaveLength(1)
      expect(replies[0]).toStartWith(STARTED)
      expect(jobs.starts).toHaveLength(1)
      expect(Option.map(yield* harness.live(directory), (live) => live.path)).toEqual(Option.some(T13))

      // A new slice: run.started with the T1.3 path, then outside.trusted T1.1 as its very next fact.
      yield* eventually(
        Effect.map(newestSlice(runID), (list) => {
          const first = list[0]
          return first?.type === "run.started" && first.path === T13 && list.length >= 2
        }),
        "the new slice's first two facts",
      )
      const fresh = yield* newestSlice(runID)
      expect(fresh.slice(0, 2)).toMatchObject([
        { type: "run.started", path: T13 },
        { type: "outside.trusted", id: "T1.1" },
      ])
      // The stored whole-spec slice is untouched: the new facts are a new slice.
      expect((yield* storedOf(runID)).slice(0, slice.length)).toEqual([...slice])
      // Folded through the T1.3 plan, the external region T1.1 is untrusted after run.started and trusted after the
      // next fact.
      expect(unitState(fold(subtree, fresh.slice(0, 1)), "T1.1")).toBe("untrusted")
      expect(unitState(fold(subtree, fresh.slice(0, 2)), "T1.1")).toBe("trusted")

      yield* stopJobs(jobs)
    }),
  { git: true },
)

it.instance(
  "[VF7] /task trust T1.1 during the live T1.3 subtree run records nothing in the run: only the outside preconditions T9 and T8 move",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const runID = TaskEvents.runID(directory, SPEC)
      yield* storeTrustedSlice(directory)
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      jobs.mode = "run"
      expect((yield* runTask(harness, T13, jobs))[0]).toStartWith(STARTED)
      yield* eventually(
        Effect.map(newestSlice(runID), (list) => trustedIds(list).includes("T1.1")),
        "the start-up trust of the external region T1.1",
      )
      yield* supervising(harness, runID)

      // /task trust T9, T1.1, then T8 through the real command, while the run is live.
      for (const id of ["T9", "T1.1", "T8"]) expect(yield* runTask(harness, `trust ${id}`)).toEqual([TRUST_REPLY(id)])
      yield* eventually(
        Effect.map(newestSlice(runID), (list) => trustedIds(list).includes("T8")),
        "the trust of T8 in the run",
      )

      // The directory aggregate holds all three trusts; the run holds the start-up T1.1 once, then T9 and T8 only.
      expect(trustedIds(yield* storedOf(TaskEvents.directoryID(directory)))).toEqual(["T9", "T1.1", "T8"])
      expect(trustedIds(yield* newestSlice(runID))).toEqual(["T1.1", "T9", "T8"])

      yield* stopJobs(jobs)
    }),
  { git: true },
)

it.instance(
  "[VF7] /task trust T1.1 never moves an untrusted external region of the live run, while /task trust T9 moves the outside region T9",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      // A live T1.3 subtree run whose external region T1.1 was not trusted at the start: the real run supervisor,
      // spawned in the harness and holding the directory's lease, over a real Recorder and the real event store.
      const plan = yield* loadPlan("release-notes.spec", "T1.3")
      const setup = yield* runOf({ plan, directory: path.join(directory, SPEC), stored: [] })
      const harness = yield* TaskHarness.make
      const claimed = yield* harness.claim({ directory, runID: setup.id, spec: SPEC, path: T13 })
      expect(claimed.kind).toBe("claimed")
      yield* harness.spawnRun(setup.id, RunSupervisor.machine, {
        run: setup.run,
        events: setup.events,
        resumed: false,
        path: T13,
        trusts: Effect.succeed([]),
        externals: [],
        release: harness.release(directory, setup.id),
        writer: setup.recorder.writer,
      } satisfies RunSupervisor.Input)
      yield* eventually(
        Effect.map(storedOf(setup.id), (list) => list[0]?.type === "run.started"),
        "run.started",
      )
      yield* supervising(harness, setup.id)
      const state = (id: string) => Effect.map(setup.recorder.actor.getSnapshot, (snapshot) => unitState(snapshot, id))
      expect(yield* state("T1.1")).toBe("untrusted")
      expect(yield* state("T9")).toBe("untrusted")

      // /task trust T9, T1.1, then T8 through the real command; the run handles them in that order.
      for (const id of ["T9", "T1.1", "T8"]) expect(yield* runTask(harness, `trust ${id}`)).toEqual([TRUST_REPLY(id)])
      yield* eventually(
        Effect.map(setup.recorder.actor.getSnapshot, (snapshot) => unitState(snapshot, "T8") === "trusted"),
        "the outside region T8 trusted",
      )

      // The outside regions moved; the external region T1.1 did not, and no fact names it.
      expect(yield* state("T9")).toBe("trusted")
      expect(yield* state("T1.1")).toBe("untrusted")
      const recorded = yield* storedOf(setup.id)
      expect(trustedIds(recorded)).toEqual(["T9", "T8"])
      expect(unitState(fold(plan, recorded), "T1.1")).toBe("untrusted")
      // T1.3 still waits on T1.1.
      expect(yield* state("T1.3")).not.toBe("ready")

      yield* harness.removeRun(setup.id)
      yield* harness.release(directory, setup.id)
    }),
  { git: true },
)

it.instance(
  "[VF7] /task trust T1.1 with no trusted slice does not stand in for the folder task: the T1.3 subtree is still refused",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const harness = yield* TaskHarness.make
      expect(yield* runTask(harness, "trust T1.1")).toEqual([TRUST_REPLY("T1.1")])
      expect(trustedIds(yield* storedOf(TaskEvents.directoryID(directory)))).toEqual(["T1.1"])

      const jobs = jobsOf()
      expect(yield* runTask(harness, T13, jobs)).toEqual([
        [`Refused ${T13}: 1 failure. No work started.`, R12, "Run the whole spec, or a folder that holds T1.1."].join(
          "\n",
        ),
      ])
      expect(jobs.starts).toEqual([])
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", path: T13, reason: R12 })
    }),
  { git: true },
)
