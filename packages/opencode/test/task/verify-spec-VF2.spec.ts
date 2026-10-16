import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Fiber, FileSystem, Layer, Option, Schema } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import { TaskStatus } from "@/task/core/status"
import { testEffect } from "../lib/effect"
import { git, jobsOf, runTask, seed, SPEC, statusFile } from "./lib/command"

// Scenario VF2 (spec task-harness-feedback, owner ruling 3, AD-19, spec.md defect 2): a refusal while a run is live
// answers in the session only.
//
//   Given a live run in a directory
//   When /task runs on a faulty spec in the same directory
//   Then the session gets the refusal message
//   And the status file still shows the live run
//
// The live run is a real `/task` job: the real `TaskCommand.run` claims the directory's lease and starts the job,
// which the job registry runs on its own fiber (mode "run"); the job runs the real run supervisor, Recorder and status
// writer. The spec is a committed copy of release-notes.spec whose root tasks T1.1 and T1.2 are after the outside
// precondition T9, so every task waits on T9 and the run stays live, with no session work, until the test cancels it.
// The faulty spec is a second spec folder in the same directory with one planted R3 fault. The status file is read
// from disk and decoded with the AD-13 status schema.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const FAULTY = "task-formats/blend/faulty.spec"
const T11_TASK = "T1-release-notes.task/T1.1-commit-parser.task/TASK.md"
const T12_TASK = "T1-release-notes.task/T1.2-version-bump.task/TASK.md"
const T13_TASK = "T1-release-notes.task/T1.3-markdown-render.task/TASK.md"

const decodeStatus = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))

// The status file on disk, decoded; none before the first write.
const statusOf = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = statusFile(directory)
    if (!(yield* fs.exists(file))) return Option.none<TaskStatus.Status>()
    return Option.some(decodeStatus(yield* fs.readFileString(file)))
  })

// A live run's status: a live state (AD-13 `running` or `waiting`), not ended, with a heartbeat.
const isLive = (status: TaskStatus.Status) =>
  (status.run.state === "running" || status.run.state === "waiting") &&
  !status.run.tags.includes("ended") &&
  status.run.endedAt === undefined &&
  status.run.aliveAt !== undefined

// Polls `check` until it holds (the job runs on its own fiber).
const until = <E, R>(check: Effect.Effect<boolean, E, R>, what: string) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 1500; tries++) {
      if (yield* check) return yield* Effect.void
      yield* Effect.sleep(10)
    }
    return yield* Effect.die(new Error(`never: ${what}`))
  })

const rewrite = (file: string, change: (text: string) => string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const before = yield* fs.readFileString(file)
    const after = change(before)
    expect(after).not.toBe(before)
    yield* fs.writeFileString(file, after)
  })

// A seeded release-notes spec whose root tasks wait on the outside precondition T9, committed; then a live run of it.
const liveRun = Effect.gen(function* () {
  const directory = yield* seed(SPEC)
  const spec = path.join(directory, SPEC)
  yield* rewrite(path.join(spec, T11_TASK), (text) => text.replace("---\n", "---\nafter: [T9]\n"))
  yield* rewrite(path.join(spec, T12_TASK), (text) => text.replace("---\n", "---\nafter: [T9]\n"))
  expect((yield* Blend.load(spec)).failures).toEqual([])
  yield* git(directory, "add", "-A")
  yield* git(directory, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "wait on T9")

  const harness = yield* TaskHarness.make
  const jobs = jobsOf()
  jobs.mode = "run"
  // The job runs outside the test's scope: cancel it however the test ends.
  const stop = Effect.gen(function* () {
    jobs.status = "cancelled"
    for (const fiber of jobs.fibers) yield* Fiber.interrupt(fiber)
  })
  yield* Effect.addFinalizer(() => stop)
  expect(yield* runTask(harness, SPEC, jobs)).toEqual(["Implementing spec **Release notes from conventional commits**"])
  const id = TaskEvents.runID(directory, SPEC)
  // Live: the lease names the run, and the run's own status writer has written a live status. Every task waits on
  // T9, so the run's state is `waiting` (AD-13: a live run that waits; it has not ended).
  yield* until(
    Effect.map(statusOf(directory), (status) => Option.isSome(status) && isLive(status.value)),
    "the live run's status file",
  )
  expect(yield* harness.live(directory)).toEqual(Option.some({ runID: id, spec: SPEC, path: SPEC }))
  return { directory, harness, jobs, id, stop }
})

// A second spec folder in the same directory: a copy of release-notes.spec with one R3 fault (a second `refs` key).
const faultySpec = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.copy(path.join(directory, SPEC), path.join(directory, FAULTY))
    yield* rewrite(path.join(directory, FAULTY, T13_TASK), (text) => text.replace("---\n", "---\nrefs: []\n"))
    const failures = (yield* Blend.load(path.join(directory, FAULTY))).failures
    return failures.map((failure) => `${failure.rule} ${failure.path}: ${failure.message}`)
  })

const refusalText = (lines: ReadonlyArray<string>) =>
  [
    `Refused ${FAULTY}: ${lines.length} ${lines.length === 1 ? "failure" : "failures"}. No work started.`,
    ...lines,
    `Fix each line, then type /task ${FAULTY} again.`,
  ].join("\n")

it.instance(
  "[VF2] with a run live in the directory, /task on a faulty spec gets the refusal message in the session",
  () =>
    Effect.gen(function* () {
      const { directory, harness, jobs, stop } = yield* liveRun
      const lines = yield* faultySpec(directory)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toStartWith(`R3 ${T13_TASK}: `)

      const replies = yield* runTask(harness, FAULTY, jobs)

      // The session gets the full refusal: the counted header, the failure line, the hint. Not the busy line.
      expect(replies).toEqual([refusalText(lines)])
      expect(replies[0]).not.toContain("Not started: the run of")
      // Nothing new started.
      expect(jobs.starts).toHaveLength(1)
      yield* stop
    }),
  { git: true },
)

it.instance(
  "[VF2] the status file still shows the live run after the refusal, and the live run keeps the lease",
  () =>
    Effect.gen(function* () {
      const { directory, harness, jobs, id, stop } = yield* liveRun
      const lines = yield* faultySpec(directory)
      const before = Option.getOrThrow(yield* statusOf(directory))
      expect(isLive(before)).toBe(true)
      expect(before.run.state).toBe("waiting")

      yield* runTask(harness, FAULTY, jobs)

      // The status file is the live run's projection: its state, spec, path, start and tasks; no refusal in it.
      const after = Option.getOrThrow(yield* statusOf(directory))
      expect(isLive(after)).toBe(true)
      expect(after.run.state).toBe(before.run.state)
      expect(after.run.state).not.toBe("refused")
      expect(after.run.spec).toBe(SPEC)
      expect(after.run.path).toBe(SPEC)
      expect(after.run.startedAt).toBe(before.run.startedAt)
      expect(after.run.startedAt).toBeNumber()
      expect(after.run).not.toHaveProperty("reason")
      expect(after.run.tags).not.toContain("ended")
      expect(Object.keys(after.tasks)).toEqual(Object.keys(before.tasks))
      expect(Object.keys(after.tasks)).toContain("T1.1")
      expect(JSON.stringify(after)).not.toContain(FAULTY)
      expect(JSON.stringify(after)).not.toContain(lines[0] ?? "no line")
      // The live run still holds the directory.
      expect(yield* harness.live(directory)).toEqual(Option.some({ runID: id, spec: SPEC, path: SPEC }))

      // Control: once the live run has ended and freed the lease, the same refusal does write the status file.
      yield* stop
      yield* until(
        Effect.map(harness.live(directory), (live) => Option.isNone(live)),
        "the cancelled run frees the lease",
      )
      expect(yield* runTask(harness, FAULTY, jobs)).toEqual([refusalText(lines)])
      const refused = Option.getOrThrow(yield* statusOf(directory))
      expect(refused.run).toMatchObject({ state: "refused", spec: FAULTY, path: FAULTY, reason: lines.join("\n") })
    }),
  { git: true },
)
