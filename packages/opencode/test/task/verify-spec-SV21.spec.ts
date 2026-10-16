import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Predicate, Schema } from "effect"
import fs from "fs"
import type { Tool as AITool } from "ai"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import { TaskHooks } from "@/task/core/hooks"
import type { Fact, Plan } from "@/task/core/model"
import type { TaskOps } from "@/task/core/ops"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { git, type Jobs, jobsOf, SESSION, seed, services, SPEC, statusFile } from "./lib/command"
import { facts, loadPlan, trustLeaf } from "./lib/machine"
import { eventually } from "./lib/supervise"

// Scenario SV21 (spec task-harness-feedback, AD-9, AD-19, SD-19; tasks T2.4, T2.11): the directory lease is released
// when a run ends.
//
//   Given a run that ends done, and a run that is cancelled
//   When each run scope closes
//   Then the status writer stops before the lease is released
//   And the next /task in the directory is not busy
//
// Everything is the real `/task` path: TaskCommand.run, the real TaskHarness root (the directory lease), the real event
// store, a seeded git instance. The background-job registry is the project's test registry (lib/command) in "run" mode:
// it runs the job on its own fiber, so each run is a real run (its run scope, the Recorder and its status writer, the
// run supervisor and its unit supervisors). The harness's `release` is wrapped only to observe each call before it
// goes to the real root: the lease's state, whether the status writer has ended (the writer fiber is the one the job
// handed to the run supervisor, read from that supervisor's context), and the run state in status.json. The session
// side answers the command's own replies, lets the S7 judge call the REAL `verdict` tool (SessionPrompt's
// createTaskHarnessTools with the root's hooks), and holds every builder prompt open.
//
// The run that ends done is a resume of a stored, unended subtree slice of the leaf T1.1: T8 and T9 are trusted, T1.1
// is trusted, S2 is trusted, and S7 passed its tests and waits for its judge. The judge's verdict ends the run machine
// `done`. The run that is cancelled is a new slice of the whole spec whose two ready leaves build until the job is
// cancelled.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))
const engine = TaskEngineXState

const SUBTREE = `${SPEC}/T1-release-notes.task/T1.1-commit-parser.task`
const START = 1_700_000_000_000

const ToolResult = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
  metadata: Schema.Struct({ valid: Schema.Boolean }),
})

// Runs a harness tool's `execute` as the AI SDK does for a tool call, and reads its result.
const exec = (tool: AITool | undefined, input: unknown) =>
  Effect.promise(() => {
    if (tool?.execute === undefined) throw new Error("no such harness tool")
    return Promise.resolve(tool.execute(input, { toolCallId: "call_1", messages: [] }))
  }).pipe(Effect.map(Schema.decodeUnknownSync(ToolResult)))

const StatusRun = Schema.fromJsonString(Schema.Struct({ run: Schema.Struct({ state: Schema.String }) }))

// The run state that status.json holds now, if the file is there.
const stateOnDisk = (directory: string) => {
  const text = fs.existsSync(statusFile(directory)) ? fs.readFileSync(statusFile(directory), "utf8") : ""
  return Option.getOrUndefined(Option.map(Schema.decodeUnknownOption(StatusRun)(text), (status) => status.run.state))
}

// The status writer of a live run: the fiber the job gave its run supervisor, read from the supervisor's context.
const writerOf = (harness: TaskHarness.Interface, runID: string) =>
  Effect.gen(function* () {
    const ref = yield* harness.system.get(TaskHarness.systemId.run(runID))
    if (Option.isNone(ref)) return Option.none<Fiber.Fiber<unknown, unknown>>()
    const snapshot: unknown = yield* ref.value.getSnapshot
    const context = Predicate.hasProperty(snapshot, "context") ? snapshot.context : undefined
    const writer = Predicate.hasProperty(context, "writer") ? context.writer : undefined
    return Fiber.isFiber(writer) ? Option.some(writer) : Option.none<Fiber.Fiber<unknown, unknown>>()
  })

/** One call of the lease release, as it was seen before it reached the harness root. */
interface Released {
  readonly lease: "held" | "free"
  readonly writer: "ended" | "running" | "unknown"
  readonly state: string | undefined
}

// The real harness root, with each release observed first.
const observed = (real: TaskHarness.Interface, released: Array<Released>) => {
  const writers = new Map<string, Fiber.Fiber<unknown, unknown>>()
  const harness: TaskHarness.Interface = {
    ...real,
    release: (directory, runID) =>
      Effect.gen(function* () {
        const live = yield* real.live(directory)
        const found = yield* writerOf(real, runID)
        if (Option.isSome(found)) writers.set(runID, found.value)
        const writer = writers.get(runID)
        released.push({
          lease: Option.isSome(live) && live.value.runID === runID ? "held" : "free",
          writer: writer === undefined ? "unknown" : writer.pollUnsafe() === undefined ? "running" : "ended",
          state: stateOnDisk(directory),
        })
        yield* real.release(directory, runID)
      }),
  }
  // Keeps the writer of a run while its supervisor lives, for a release after the supervisor is gone.
  const capture = (runID: string) =>
    eventually(
      Effect.map(writerOf(real, runID), (found) => {
        if (Option.isSome(found)) writers.set(runID, found.value)
        return Option.isSome(found)
      }),
      "the run supervisor holds the status writer",
    )
  return { harness, capture }
}

// The session side of `/task`: the command's replies in the root session are recorded; the S7 judge calls the real
// `verdict` tool once `judge` is released; every builder turn never ends.
const opsOf = (
  harness: TaskHarness.Interface,
  state: {
    readonly replies: Array<string>
    readonly verdicts: Array<typeof ToolResult.Type>
    readonly judge: Deferred.Deferred<void>
  },
): TaskOps.Ops => {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the harness never reads the reply message, and a real WithParts needs a stored session
  const reply = {} as SessionV1.WithParts
  return {
    prompt: (input) => {
      if (input.sessionID === SESSION)
        return Effect.sync(() => {
          state.replies.push(input.parts.map((part) => part.text).join("\n"))
          return reply
        })
      if (input.agent === TaskHooks.VERIFIER)
        return Effect.gen(function* () {
          yield* Deferred.await(state.judge)
          const tools = yield* SessionPrompt.createTaskHarnessTools(TaskHooks.VERIFIER, input.sessionID, harness.hooks)
          state.verdicts.push(yield* exec(tools.verdict, { verdicts: [{ id: "S7", verdict: "trusted" }] }))
          return reply
        })
      return Effect.never
    },
    cancel: () => Effect.void,
    currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
    say: () => Effect.void,
  }
}

// `/task <args>` in the instance: the replies this call sent.
const task = (harness: TaskHarness.Interface, ops: TaskOps.Ops, replies: Array<string>, args: string, jobs: Jobs) =>
  Effect.gen(function* () {
    const before = replies.length
    yield* TaskCommand.run({ sessionID: SESSION, arguments: args }, ops, harness).pipe(Effect.provide(services(jobs)))
    return replies.slice(before)
  })

const storedOf = Effect.fnUntraced(function* (id: string) {
  const db = yield* Database.Service
  return yield* TaskEvents.read(db.db, id)
})

// The stored, unended subtree slice of T1.1: everything is trusted but S7, which passed its tests and waits for its
// judge.
const doneSlice = (plan: Plan, base: string): ReadonlyArray<Fact> => {
  const f = facts(START)
  return [
    { type: "run.started", at: START, base, path: SUBTREE },
    f.outside("T8"),
    f.outside("T9"),
    ...trustLeaf(plan, f, "T1.1"),
    f.scenarioProved("S2", "passed"),
    f.scenarioVerified({ id: "S2", verdict: "trusted" }),
    f.scenarioProved("S7", "passed"),
  ]
}

it.instance(
  "[SV21] a run that ends done: its status writer stops before each lease release, and the next /task is not busy",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
      const events = yield* EventV2Bridge.Service
      const id = TaskEvents.runID(directory, SPEC)
      const released: Array<Released> = []
      const { harness, capture } = observed(yield* TaskHarness.make, released)
      const replies: Array<string> = []
      const verdicts: Array<typeof ToolResult.Type> = []
      const state = { replies, verdicts, judge: yield* Deferred.make<void>() }
      const ops = opsOf(harness, state)
      const jobs = jobsOf()
      jobs.mode = "run"

      // Given a run that ends done: the stored subtree slice of T1.1 is not ended, and only S7's judge is left.
      const plan = yield* loadPlan("release-notes.spec", "T1.1")
      expect(plan.scenarios.map((item) => item.id)).toEqual(["S2", "S7"])
      const slice = doneSlice(plan, branch)
      const given = TaskEvents.fold(engine.XStateEngine, plan, slice)
      expect(engine.ended(given)).toBe(false)
      // S7 waits for its judge: the phase tag the run supervisor spawns a scenario supervisor for.
      expect(given.hasTag("S7:verifying")).toBe(true)
      expect(engine.unitState(given, "T1.1")).toBe("trusted")
      expect(engine.unitState(given, "S2")).toBe("trusted")
      for (const fact of slice) yield* TaskEvents.publish(events, id, fact)

      // /task on the T1.1 folder resumes the slice as a real job.
      const started = yield* task(harness, ops, state.replies, SUBTREE, jobs)
      expect(started).toHaveLength(1)
      expect(started[0]).toStartWith("Implementing **T1.1 ")
      expect(jobs.starts.map((start) => start.id)).toEqual([id])
      yield* eventually(
        Effect.map(storedOf(id), (list) => list.some((fact) => fact.type === "run.resumed")),
        "the run resumes",
      )
      yield* capture(id)
      expect(yield* harness.live(directory)).toEqual(Option.some({ runID: id, spec: SPEC, path: SUBTREE }))
      // While the run is live the directory is busy (the control for "not busy" below).
      expect(yield* task(harness, ops, state.replies, SPEC, jobs)).toEqual([
        TaskCommand.busyLine({ runID: id, spec: SPEC, path: SUBTREE }),
      ])
      expect(released).toEqual([])

      // The judge's verdict ends the run machine done; the job then closes its run scope.
      yield* Deferred.succeed(state.judge, undefined)
      const job = Option.getOrThrow(Option.fromNullishOr(jobs.fibers[0]))
      const exit = yield* Fiber.await(job).pipe(Effect.timeout(60_000))
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(state.verdicts).toEqual([{ title: "Verdict", output: "Recorded 1 verdicts.", metadata: { valid: true } }])
      const after = yield* storedOf(id)
      expect(after.slice(0, slice.length)).toEqual([...slice])
      expect(after.slice(slice.length).map((fact) => fact.type)).toEqual(["run.resumed", "scenario.verified"])
      expect(after.at(-1)).toMatchObject({ type: "scenario.verified", verdict: { id: "S7", verdict: "trusted" } })
      const end = TaskEvents.fold(engine.XStateEngine, plan, Option.getOrThrow(TaskEvents.latestRun(after)))
      expect(engine.ended(end)).toBe(true)
      expect(end.status).toBe("done")
      expect(engine.view(end).run.state).toBe("done")

      // Then the status writer had stopped before every release: the run supervisor's release once the run machine
      // was final (it freed the lease), and the run scope's last finalizer (the lease was already free). The writer's
      // last write, the done snapshot, was on disk at each.
      expect(released).toEqual([
        { lease: "held", writer: "ended", state: "done" },
        { lease: "free", writer: "ended", state: "done" },
      ])
      expect(stateOnDisk(directory)).toBe("done")
      expect(yield* harness.running(id)).toBe(false)
      expect(yield* harness.live(directory)).toEqual(Option.none())

      // And the next /task in the directory is not busy: it claims the directory and starts its job.
      jobs.mode = "start"
      const next = yield* task(harness, ops, state.replies, SPEC, jobs)
      expect(next).toEqual(["Implementing spec **Release notes from conventional commits**"])
      expect(jobs.starts.map((start) => start.id)).toEqual([id, id])
      expect(yield* harness.live(directory)).toEqual(Option.some({ runID: id, spec: SPEC, path: SPEC }))
    }),
  { git: true },
  120_000,
)

it.instance(
  "[SV21] a run that is cancelled: its status writer stops before each lease release, and the next /task is not busy",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const id = TaskEvents.runID(directory, SPEC)
      const released: Array<Released> = []
      const { harness, capture } = observed(yield* TaskHarness.make, released)
      const replies: Array<string> = []
      const verdicts: Array<typeof ToolResult.Type> = []
      const state = { replies, verdicts, judge: yield* Deferred.make<void>() }
      const ops = opsOf(harness, state)
      const jobs = jobsOf()
      jobs.mode = "run"

      // Given a run that is cancelled: a new slice of the whole spec, whose two ready leaves build.
      expect(yield* task(harness, ops, state.replies, SPEC, jobs)).toEqual([
        "Implementing spec **Release notes from conventional commits**",
      ])
      yield* eventually(
        Effect.map(storedOf(id), (list) => list.filter((fact) => fact.type === "task.started").length === 2),
        "the run starts its two ready leaves",
      )
      yield* capture(id)
      expect(yield* harness.live(directory)).toEqual(Option.some({ runID: id, spec: SPEC, path: SPEC }))
      expect(yield* task(harness, ops, state.replies, SPEC, jobs)).toEqual([
        TaskCommand.busyLine({ runID: id, spec: SPEC, path: SPEC }),
      ])
      expect(released).toEqual([])

      // When the job is cancelled, its run scope closes.
      jobs.status = "cancelled"
      const job = Option.getOrThrow(Option.fromNullishOr(jobs.fibers[0]))
      yield* Fiber.interrupt(job).pipe(Effect.timeout(60_000))
      const after = yield* storedOf(id)
      expect(after.map((fact) => fact.type)).toContain("run.cancelled")
      expect(after.filter((fact) => fact.type === "run.cancelled")).toHaveLength(1)
      expect(
        engine.view(TaskEvents.fold(engine.XStateEngine, yield* loadPlan("release-notes.spec"), after)).run.state,
      ).toBe("cancelled")

      // Then the status writer had stopped before every release: the run supervisor's release once run.cancelled made
      // the run machine final (it freed the lease), and the run scope's last finalizer. The cancelled snapshot was on
      // disk at each.
      expect(released).toEqual([
        { lease: "held", writer: "ended", state: "cancelled" },
        { lease: "free", writer: "ended", state: "cancelled" },
      ])
      expect(stateOnDisk(directory)).toBe("cancelled")
      expect(yield* harness.running(id)).toBe(false)
      expect(yield* harness.live(directory)).toEqual(Option.none())

      // And the next /task in the directory is not busy: it claims the directory and starts its job.
      jobs.mode = "start"
      jobs.status = "running"
      const next = yield* task(harness, ops, state.replies, SPEC, jobs)
      expect(next).toEqual(["Implementing spec **Release notes from conventional commits**"])
      expect(jobs.starts.map((start) => start.id)).toEqual([id, id])
      expect(yield* harness.live(directory)).toEqual(Option.some({ runID: id, spec: SPEC, path: SPEC }))
    }),
  { git: true },
  120_000,
)
