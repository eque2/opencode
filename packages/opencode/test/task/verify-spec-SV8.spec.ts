import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Exit, Fiber, FileSystem, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { TaskOps } from "@/task/core/ops"
import { testEffect } from "../lib/effect"
import { type Jobs, jobsOf, refusalOf, SESSION, seed, services, SPEC, statusFile } from "./lib/command"
import { eventually } from "./lib/supervise"

// Scenario SV8 (spec task-harness-feedback, AD-19, AD-8, owner ruling 3; tasks T2.5, T2.11): one run is live in a
// directory at a time.
//
//   Given a live run of the release-notes spec in a directory
//   When /task runs for a valid spec in the same directory
//   Then it starts nothing and answers one line that names the live run's spec and path
//   And a claim whose background job does not start is released, so the next /task is not busy
//
// Everything is the real `/task` path: TaskCommand.run, the real TaskHarness root (the directory lease), the real event
// store, a seeded git instance. The background-job registry is the project's test registry (lib/command): in "run"
// mode it runs the job on its own fiber, so the live run is a real run (the Recorder, the run supervisor and its task
// supervisors). The session side answers the command's own replies and holds every builder prompt open, so the live
// run stays live and quiet. The busy line is written out here as EXPERIENCE "Busy reply" words it.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const OTHER = "task-formats/blend/example-scenarios.spec"

const BUSY =
  "Not started: the run of task-formats/blend/release-notes.spec is live in this directory (/task task-formats/blend/release-notes.spec). One run at a time: wait for it to end, or stop it in its own session with ctrl+x w, then esc twice."

// The session side of `/task`: the command's replies in the root session are recorded; every other prompt (a builder
// turn of the live run) never ends.
const opsOf = (replies: Array<string>): TaskOps.Ops => ({
  prompt: (input) =>
    input.sessionID === SESSION
      ? Effect.sync(() => {
          replies.push(input.parts.map((part) => part.text).join("\n"))
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the command never reads the reply message, and a real WithParts needs a stored session
          return {} as SessionV1.WithParts
        })
      : Effect.never,
  cancel: () => Effect.void,
  currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
  say: () => Effect.void,
})

// `/task <args>` in the instance: the replies it sent.
const task = (harness: TaskHarness.Interface, args: string, jobs: Jobs) =>
  Effect.gen(function* () {
    const replies: Array<string> = []
    yield* TaskCommand.run({ sessionID: SESSION, arguments: args }, opsOf(replies), harness).pipe(
      Effect.provide(services(jobs)),
    )
    return replies
  })

const storedTypes = Effect.fnUntraced(function* (id: string) {
  const db = yield* Database.Service
  return (yield* TaskEvents.read(db.db, id)).map((fact) => fact.type)
})

it.instance(
  "[SV8] with a live run of release-notes, /task for a valid spec starts nothing and answers one line naming the live run's spec and path",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* seed(SPEC, OTHER)
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      jobs.mode = "run"
      const live = TaskEvents.runID(directory, SPEC)

      // Given a live run of the release-notes spec in the directory, started by /task.
      const started = yield* task(harness, SPEC, jobs)
      expect(started).toHaveLength(1)
      expect(started[0]).toStartWith("Implementing spec **Release notes from conventional commits**")
      expect(jobs.starts.map((start) => start.id)).toEqual([live])
      yield* eventually(
        Effect.map(storedTypes(live), (types) => types.includes("run.started")),
        "the live run stores run.started",
      )
      yield* eventually(
        Effect.map(storedTypes(live), (types) => types.filter((type) => type === "task.started").length === 2),
        "the live run starts its two ready leaves",
      )
      expect(yield* harness.running(live)).toBe(true)
      expect(yield* harness.live(directory)).toEqual(Option.some({ runID: live, spec: SPEC, path: SPEC }))
      yield* eventually(
        Effect.map(fs.exists(statusFile(directory)), (exists) => exists),
        "the live run writes status.json",
      )
      const before = yield* storedTypes(live)
      const other = TaskEvents.runID(directory, OTHER)

      // When /task runs for a valid spec in the same directory (another spec, a task folder of it, the same spec).
      for (const args of [OTHER, `./${OTHER}/T1-slugs.task`, SPEC]) {
        const replies = yield* task(harness, args, jobs)

        // Then it answers one line that names the live run's spec and path.
        expect(replies).toEqual([BUSY])
        expect(replies[0]?.includes("\n")).toBe(false)
        // And it starts nothing: no job, no fact for the other spec, the same lease, the live run's status file.
        expect(jobs.starts.map((start) => start.id)).toEqual([live])
        expect(yield* storedTypes(other)).toEqual([])
        expect(yield* harness.live(directory)).toEqual(Option.some({ runID: live, spec: SPEC, path: SPEC }))
        expect(yield* refusalOf(directory)).toMatchObject({ spec: SPEC })
        expect((yield* refusalOf(directory)).state).not.toBe("refused")
      }
      // The live run goes on: the busy replies recorded nothing in it.
      const after = yield* storedTypes(live)
      expect(after.slice(0, before.length)).toEqual(before)
      expect(after.filter((type) => type.startsWith("run."))).toEqual(["run.started"])
      expect(yield* harness.running(live)).toBe(true)

      // The live run is stopped; then the directory is free for the next /task.
      jobs.status = "cancelled"
      for (const fiber of jobs.fibers) yield* Fiber.interrupt(fiber)
      expect(yield* storedTypes(live)).toContain("run.cancelled")
      expect(yield* harness.live(directory)).toEqual(Option.none())
      jobs.mode = "start"
      const next = yield* task(harness, OTHER, jobs)
      expect(next[0]).toStartWith("Implementing spec")
      expect(jobs.starts.map((start) => start.id)).toEqual([live, other])
    }),
  { git: true },
  120_000,
)

it.instance(
  "[SV8] a claim whose background job does not start is released, so the next /task is not busy",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      const id = TaskEvents.runID(directory, SPEC)

      // The background job does not start: /task fails, and its claim is released.
      jobs.mode = "fail"
      const failed = yield* Effect.exit(task(harness, SPEC, jobs))
      expect(Exit.isFailure(failed)).toBe(true)
      expect(jobs.starts).toEqual([])
      expect(yield* harness.live(directory)).toEqual(Option.none())

      // A job of that id is already running elsewhere: this call's claim is released as well.
      jobs.mode = "elsewhere"
      expect(yield* task(harness, SPEC, jobs)).toEqual([`Task harness: the run of ${SPEC} is already going on.`])
      expect(yield* harness.live(directory)).toEqual(Option.none())

      // So the next /task is not busy: it claims the directory and starts its job.
      jobs.mode = "start"
      const next = yield* task(harness, SPEC, jobs)
      expect(next).toHaveLength(1)
      expect(next[0]).toStartWith("Implementing spec **Release notes from conventional commits**")
      expect(next[0]).not.toContain("Not started")
      expect(jobs.starts.map((start) => start.id)).toEqual([id, id])
      expect(jobs.starts.at(-1)).toMatchObject({ id, type: "task-harness", metadata: { parentSessionId: SESSION } })
      expect(yield* harness.live(directory)).toEqual(Option.some({ runID: id, spec: SPEC, path: SPEC }))
    }),
  { git: true },
  120_000,
)
