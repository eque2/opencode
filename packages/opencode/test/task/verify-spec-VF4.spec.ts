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

// Scenario VF4 (spec task-harness-feedback, D12, AD-12, AD-14, spec.md defect 8): a spec that stops validating during
// a run is reported and the run keeps its plan.
//
//   Given a live run of a valid spec
//   When a VERIFY.md of the spec is edited so that the spec no longer validates
//   Then the run keeps working on the plan it loaded
//   And the stale check records spec.checked with the failures, and the run gets a history entry
//   And the status run warning holds one line for each failure
//
// The live run is a real `/task` job (the job registry runs it on its own fiber): the real run supervisor with its
// real stale cadence (every second) and stale-check worker, the real Recorder over the real event store, and the
// real status writer. The spec is a committed copy of release-notes.spec whose root tasks T1.1 and T1.2 are after the
// outside precondition T9, so the run is live and does no session work until the test trusts T9. The edit is made in
// the root checkout, where the stale check reads the spec: two R3 faults in T1.3's VERIFY.md and one changed
// obligation text. The expected lines come from the loader; the warning and history are read from status.json.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const T11_TASK = "T1-release-notes.task/T1.1-commit-parser.task/TASK.md"
const T12_TASK = "T1-release-notes.task/T1.2-version-bump.task/TASK.md"
const T13_VERIFY = "T1-release-notes.task/T1.3-markdown-render.task/VERIFY.md"

// A live run starts a real job in a git instance and ends with a cancel: allow for a loaded machine.
const LIVE_TIMEOUT = 60_000

const decodeStatus = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))

// The run supervisor's spec, as far as this test reads it: the obligation ids and texts it works with.
const SupervisorSpec = Schema.Struct({
  spec: Schema.Struct({ obligations: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })) }),
})
const decodeSupervisor = Schema.decodeUnknownSync(SupervisorSpec)

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

const lineOf = (failure: { readonly rule: string; readonly path: string; readonly message: string }) =>
  `${failure.rule} ${failure.path}: ${failure.message}`

// The facts the run stored.
const factsOf = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Database.Service
    return yield* TaskEvents.read(db.db, id)
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
  yield* until(
    Effect.map(statusOf(directory), (status) => Option.isSome(status) && isLive(status.value)),
    "the live run's status file",
  )
  // The run supervisor's spec, read from its live snapshot.
  const supervisorSpec = Effect.gen(function* () {
    const ref = yield* harness.system.get(TaskHarness.systemId.run(id))
    if (Option.isNone(ref)) return yield* Effect.die(new Error("no run supervisor"))
    // The context holds the run's services too; the decoder keeps only the spec's obligation ids and texts.
    return decodeSupervisor((yield* ref.value.getSnapshot).context).spec
  })
  return { directory, spec, harness, jobs, id, stop, supervisorSpec }
})

// T1.3's VERIFY.md edited so the spec no longer validates: two obligations get an unknown category (two R3 faults),
// and c1's text changes (a valid reload would take the new text).
const breakVerify = (text: string) =>
  text
    .replace("  c1:\n    category: happy-path\n", "  c1:\n    category: nonsense\n")
    .replace("  c3:\n    category: invalid-input\n", "  c3:\n    category: nonsense\n")
    .replace('    text: "The output follows', '    text: "Changed. The output follows')

it.instance(
  "[VF4] a live run whose spec stops validating: the stale check records spec.checked with the failures, the run gets a history entry, and status.json run.warning holds one line per failure",
  () =>
    Effect.gen(function* () {
      const { directory, spec, id, stop } = yield* liveRun
      const before = Option.getOrThrow(yield* statusOf(directory))
      expect(before.run).not.toHaveProperty("warning")
      expect((yield* factsOf(id)).filter((fact) => fact.type === "spec.checked")).toEqual([])

      // When: one VERIFY.md of the spec in the root checkout is edited so that the spec no longer validates.
      yield* rewrite(path.join(spec, T13_VERIFY), breakVerify)
      const failures = (yield* Blend.load(spec)).failures
      expect(failures.map((failure) => [failure.rule, failure.path])).toEqual([
        ["R3", T13_VERIFY],
        ["R3", T13_VERIFY],
      ])
      const lines = failures.map(lineOf)

      // The stale cadence picks it up: the status file gets the warning.
      yield* until(
        Effect.map(statusOf(directory), (status) => Option.isSome(status) && status.value.run.warning !== undefined),
        "the run warning in status.json",
      )
      const after = Option.getOrThrow(yield* statusOf(directory))

      // The status run warning holds one line for each failure, in the loader's order.
      expect(after.run.warning?.split("\n")).toEqual(lines)
      // The stale check recorded spec.checked once, with exactly those failures.
      const checked = (yield* factsOf(id)).flatMap((fact) => (fact.type === "spec.checked" ? [fact] : []))
      expect(checked).toHaveLength(1)
      expect(checked[0]?.failures.map(lineOf)).toEqual(lines)
      // The run got a history entry for it.
      expect(after.history.filter((entry) => entry.unit === "run" && entry.reason?.startsWith("spec.checked"))).toEqual(
        [expect.objectContaining({ unit: "run", reason: "spec.checked: 2 failures" })],
      )
      // The run is still live: a warning is not an end.
      expect(isLive(after)).toBe(true)
      expect(after.run.state).toBe(before.run.state)
      expect(after.run).not.toHaveProperty("reason")
      yield* stop
    }),
  { git: true },
  LIVE_TIMEOUT,
)

it.instance(
  "[VF4] the run keeps working on the plan it loaded: same obligations and old text, and it goes on to start the plan's tasks",
  () =>
    Effect.gen(function* () {
      const { directory, spec, harness, jobs, id, stop, supervisorSpec } = yield* liveRun
      const loaded = yield* supervisorSpec
      const before = Option.getOrThrow(yield* statusOf(directory))
      const oldText = loaded.obligations.find((item) => item.id === "T1.3.c1")?.text ?? ""
      expect(oldText).toStartWith("The output follows")

      yield* rewrite(path.join(spec, T13_VERIFY), breakVerify)
      yield* until(
        Effect.map(statusOf(directory), (status) => Option.isSome(status) && status.value.run.warning !== undefined),
        "the run warning in status.json",
      )

      // The run's supervisor still holds the spec it loaded: the same obligations, and T1.3.c1 keeps its old text.
      const kept = yield* supervisorSpec
      expect(kept).toEqual(loaded)
      expect(kept.obligations.find((item) => item.id === "T1.3.c1")?.text).toBe(oldText)
      // The status file still projects the loaded plan: the same tasks and obligations.
      const warned = Option.getOrThrow(yield* statusOf(directory))
      expect(Object.keys(warned.tasks)).toEqual(Object.keys(before.tasks))
      expect(Object.keys(warned.obligations)).toEqual(Object.keys(before.obligations))
      expect(yield* harness.live(directory)).toEqual(Option.some({ runID: id, spec: SPEC, path: SPEC }))

      // The run keeps working: once T9 is trusted, it starts the loaded plan's tasks T1.1 and T1.2.
      expect(yield* runTask(harness, "trust T9", jobs)).toEqual([
        "Task harness: recorded the outside precondition T9 as trusted.",
      ])
      yield* until(
        Effect.map(factsOf(id), (facts) =>
          ["T1.1", "T1.2"].every((task) => facts.some((fact) => fact.type === "task.started" && fact.task === task)),
        ),
        "task.started for T1.1 and T1.2",
      )
      const facts = yield* factsOf(id)
      expect(facts.some((fact) => fact.type === "outside.trusted" && fact.id === "T9")).toBe(true)
      expect(facts.filter((fact) => fact.type === "run.ended" || fact.type === "run.cancelled")).toEqual([])
      // Work went on under the warning: the run did not reload the invalid spec.
      expect((yield* supervisorSpec).obligations.find((item) => item.id === "T1.3.c1")?.text).toBe(oldText)
      expect(facts.filter((fact) => fact.type === "obligation.stale")).toEqual([])
      yield* stop
    }),
  { git: true },
  LIVE_TIMEOUT,
)
