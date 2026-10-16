import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Clock, Duration, Effect, Fiber, FileSystem, Layer, Option, Schema, Semaphore } from "effect"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { TaskHarness } from "@/task/core/harness"
import type { Fact, Plan } from "@/task/core/model"
import { TaskRecorder } from "@/task/core/recorder"
import { TaskStatus } from "@/task/core/status"
import { RunSupervisor } from "@/task/core/supervise/run"
import type { TaskWorkers } from "@/task/core/workers"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { facts, first, loadPlan, step, trustLeaf } from "./lib/machine"
import { BASE, boundary, hang, repository, storedFacts } from "./lib/supervise"

// Scenario SV16 (spec task-harness-feedback, AD-9, D8; task T2.4): the status writer writes every committed step and
// stops at the end.
//
//   Given a live run
//   When facts are recorded and the heartbeat touches the file
//   Then the file is written once for each committed macrostep, the final one included
//   And each write stamps the heartbeat time
//   And a touch rewrites the last consumed snapshot and never an older one
//   And nothing writes the file after the done snapshot
//
// Everything that runs is the real code: a real harness root, the real run supervisor spawned in it as `run:<runID>`
// (as `RunSupervisor.supervise` does for the job), with its real heartbeat region (`HEARTBEAT`, 5 s) and its real run
// wall clock, which ends the run; the real task supervisors it spawns; a real Recorder over the real event store,
// whose status writer writes `status.json` for real with `TaskStatus.write`. The model side is scripted: each builder
// turn runs until it is stopped.
//
// Two instruments sit at boundaries and change nothing: the Recorder's `write` is `TaskStatus.write` itself, wrapped
// only to log each call (its status, its `aliveAt`, the clock when it ran, and the file read back after it); and the
// run's `touch` is the Recorder's own `touch`, wrapped only to count the heartbeat's calls.
//
// The expected writes come from the store, independently of the writer: the stored facts of the run, folded one at a
// time from the first snapshot with the pure `transition`, give one projection per committed macrostep. A write is a
// macrostep write when it equals the next expected projection; any other write must equal the write just before it
// (a touch of the last consumed snapshot). A write of an older snapshot, a skipped macrostep or a second write of one
// matches neither, and fails.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SPEC_DIR = path.resolve(import.meta.dir, "../../../../task-formats/blend/release-notes.spec")
// A stream idle time longer than the test, so a hanging builder turn never stalls; the run wall clock ends the run
// after two heartbeats (at 5 s and 10 s).
const WALL_CLOCK = Duration.seconds(12)
const LIMITS: TaskLimits.Limits = {
  ...TaskLimits.scripted,
  streamIdle: Duration.seconds(600),
  runWallClock: Option.some(WALL_CLOCK),
}

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))

/** One call of the status writer's `write`. */
interface Write {
  readonly status: TaskStatus.Status
  readonly aliveAt: number
  /** The clock when the write ran. */
  readonly ranAt: number
  /** `status.json` as it was read back right after the write. */
  readonly onDisk: TaskStatus.Status | undefined
}

// `TaskStatus.write` into `directory`, as the Recorder's default write is, with each call logged in `writes`.
const loggedWrite = (directory: string, writes: Array<Write>) => (status: TaskStatus.Status, aliveAt: number) =>
  Effect.gen(function* () {
    const ranAt = yield* Clock.currentTimeMillis
    yield* TaskStatus.write(directory, status, aliveAt)
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs
      .readFileString(path.join(directory, ".opencode", "task", "status.json"))
      .pipe(Effect.orElseSucceed(() => ""))
    writes.push({ status, aliveAt, ranAt, onDisk: text === "" ? undefined : decode(text) })
  })

const withoutAlive = (status: TaskStatus.Status | undefined) =>
  status === undefined ? undefined : { ...status, run: { ...status.run, aliveAt: undefined } }

/** The projection of each committed macrostep: the first snapshot, then one per stored fact, in store order. */
const macrosteps = (plan: Plan, stored: ReadonlyArray<Fact>) => {
  const snapshots = stored.reduce(
    (list, fact) => [...list, step(plan, list.at(-1) ?? first(plan), fact)],
    [first(plan)],
  )
  return snapshots.map((snapshot) => TaskStatus.project(plan, snapshot))
}

/**
 * Splits the writes into macrostep writes and touch writes: a write that equals the next expected macrostep is that
 * macrostep's write; any other write must equal the write before it. Returns how far the macrosteps were matched and
 * the index of each touch write, or the index of the first write that is neither.
 */
const classify = (writes: ReadonlyArray<Write>, expected: ReadonlyArray<TaskStatus.Status>) => {
  const touches: Array<number> = []
  let next = 0
  for (const [index, write] of writes.entries()) {
    if (next < expected.length && Bun.deepEquals(write.status, expected[next], true)) {
      next++
      continue
    }
    const before = writes[index - 1]
    if (before !== undefined && Bun.deepEquals(write.status, before.status, true)) {
      touches.push(index)
      continue
    }
    return { matched: next, touches, stray: index }
  }
  return { matched: next, touches, stray: -1 }
}

let runs = 0

it.live(
  "[SV16] in a live run the writer writes each committed macrostep once, done last, each heartbeat touch rewrites the last snapshot with a fresh aliveAt, and nothing writes after done",
  () =>
    Effect.gen(function* () {
      // Given a live run: a new release-notes run of the real run supervisor, whose ready tasks build until stopped.
      const plan = yield* loadPlan("release-notes.spec")
      const root = yield* repository()
      const harness = yield* TaskHarness.make
      const events = yield* EventV2Bridge.Service
      const id = `task_sv16run${(runs++).toString(16).padStart(4, "0")}`
      const writes: Array<Write> = []
      const recorder = yield* TaskRecorder.make({
        plan,
        runID: id,
        directory: root,
        stored: [],
        events,
        write: loggedWrite(root, writes),
      })
      const touched: Array<number> = []
      const { env } = boundary(Array.from({ length: 40 }, () => hang))
      const run: TaskWorkers.Run = {
        env,
        id,
        directory: root,
        base: BASE,
        specDir: SPEC_DIR,
        plan,
        root: SessionID.make("ses_sv16_root"),
        model: { providerID: "test", modelID: "test" },
        limits: LIMITS,
        locks: { checkout: yield* Semaphore.make(1), git: yield* Semaphore.make(1) },
        recorder: {
          actor: recorder.actor,
          record: recorder.record,
          // The heartbeat's touch: the Recorder's own, counted.
          touch: Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sync(() => touched.push(now))).pipe(
            Effect.andThen(recorder.touch),
          ),
        },
        claim: harness.claimSession,
      }
      // When facts are recorded (by the supervisors' workers) and the heartbeat touches the file, until the run
      // wall clock ends the run; the supervisor closes once the writer has written the done snapshot.
      yield* RunSupervisor.supervise(harness, {
        run,
        events,
        resumed: false,
        path: plan.path,
        trusts: Effect.succeed([]),
        externals: [],
        release: Effect.void,
        writer: recorder.writer,
      })
      const closedAt = yield* Clock.currentTimeMillis
      const done = yield* recorder.actor.getSnapshot
      expect(done.status).toBe("done")
      // The writer ended with the run actor's changes, before the supervisor closed.
      expect(recorder.writer.pollUnsafe()).not.toBeUndefined()

      const stored = yield* storedFacts(id)
      const types = stored.map((fact) => fact.type)
      expect(types[0]).toBe("run.started")
      expect(types.filter((type) => type === "task.started").length).toBeGreaterThanOrEqual(1)
      expect(stored.at(-1)).toMatchObject({ type: "run.ended", state: "failed" })
      const expected = macrosteps(plan, stored)
      // Every macrostep has its own projection (each fact adds a history entry), so a write names one macrostep.
      for (const [index, status] of expected.entries())
        if (index > 0) expect(Bun.deepEquals(status, expected[index - 1], true)).toBe(false)

      // Then the file is written once for each committed macrostep, the final one included, and the only other writes
      // are touches of the snapshot written just before them.
      const writesAtClose = writes.length
      const split = classify(writes, expected)
      expect(split.stray).toBe(-1)
      expect(split.matched).toBe(expected.length)
      expect(writes.length).toBe(expected.length + split.touches.length)
      // The heartbeat touched the file during the run, and each touch gave at most one write.
      expect(touched.length).toBeGreaterThanOrEqual(1)
      expect(split.touches.length).toBeGreaterThanOrEqual(1)
      expect(split.touches.length).toBeLessThanOrEqual(touched.length)
      // The final write is the done snapshot: the run ended failed by its wall clock.
      const last = writes.at(-1)
      expect(Bun.deepEquals(last?.status, expected.at(-1), true)).toBe(true)
      expect(last?.status.run).toMatchObject({ state: "failed", tags: ["ended", "stopped"] })
      expect(last?.status.run.reason).toContain("wall clock")

      // And each write stamps the heartbeat time: `aliveAt` is the clock when the write ran, it is in the file, it
      // never goes back, a macrostep write is no earlier than the fact it shows, and a touch write is fresher than
      // the write it repeats.
      for (const [index, write] of writes.entries()) {
        expect(write.aliveAt).toBeLessThanOrEqual(write.ranAt)
        expect(write.ranAt - write.aliveAt).toBeLessThan(2_000)
        expect(write.onDisk?.run.aliveAt).toBe(write.aliveAt)
        expect(withoutAlive(write.onDisk)).toEqual(withoutAlive(write.status))
        expect(write.status.run.aliveAt).toBeUndefined()
        const before = writes[index - 1]
        if (before !== undefined) expect(write.aliveAt).toBeGreaterThanOrEqual(before.aliveAt)
      }
      for (const [index, fact] of stored.entries()) {
        const write = writes.find((item) => Bun.deepEquals(item.status, expected[index + 1], true))
        expect(write?.aliveAt).toBeGreaterThanOrEqual(fact.at)
      }
      // And a touch rewrites the last consumed snapshot, never an older one, with a fresh aliveAt.
      for (const index of split.touches) {
        const before = writes[index - 1]
        expect(Bun.deepEquals(writes[index]?.status, before?.status, true)).toBe(true)
        expect(writes[index]?.aliveAt).toBeGreaterThan(before?.aliveAt ?? Number.MAX_SAFE_INTEGER)
      }

      // And nothing writes the file after the done snapshot: not the heartbeat (wait past one more period), not a
      // touch, and the file still holds the done snapshot with its last heartbeat.
      yield* recorder.touch
      yield* Effect.sleep(Duration.sum(RunSupervisor.HEARTBEAT, Duration.seconds(1)))
      expect(writes.length).toBe(writesAtClose)
      expect(touched.filter((at) => at > closedAt)).toEqual([])
      const fs = yield* FileSystem.FileSystem
      const onDisk = decode(yield* fs.readFileString(path.join(root, ".opencode", "task", "status.json")))
      if (last?.onDisk === undefined) throw new Error("the done snapshot was not on disk")
      expect(onDisk).toEqual(last.onDisk)
      expect(onDisk.run.aliveAt).toBe(last.aliveAt)
      yield* harness.removeRun(id)
    }),
  120_000,
)

it.live(
  "[SV16] under a burst of records and touches with no wait, each macrostep is written once in order, done last, and every touch rewrites the snapshot written just before it",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const events = yield* EventV2Bridge.Service
      const id = `task_sv16burst${(runs++).toString(16).padStart(4, "0")}`
      const writes: Array<Write> = []
      const recorder = yield* TaskRecorder.make({
        plan,
        runID: id,
        directory,
        stored: [],
        events,
        write: loggedWrite(directory, writes),
      })
      // Given a live run: its writer has written the restored snapshot (the writer reads the run actor's snapshots
      // from the current one on, so it waits for that first write).
      for (let tries = 0; tries < 3000 && writes.length === 0; tries++) yield* Effect.sleep(10)
      expect(writes.length).toBe(1)
      // When facts are recorded and touches arrive between them, with no wait for the writer: T1.1 and T1.2 become
      // trusted, then the run is cancelled (the done snapshot).
      // The builders stamp their own `at`; the Recorder stamps every fact again from the clock.
      const f = facts()
      const list: ReadonlyArray<TaskRecorder.Unstamped> = [
        { type: "run.started" },
        ...trustLeaf(plan, f, "T1.1"),
        ...trustLeaf(plan, f, "T1.2"),
        { type: "run.cancelled", reason: "user stop" },
      ]
      let offered = 0
      for (const fact of list) {
        yield* recorder.record(fact)
        yield* recorder.touch
        offered++
      }
      yield* Fiber.await(recorder.writer).pipe(Effect.timeout(30_000))
      expect((yield* recorder.actor.getSnapshot).status).toBe("done")
      const stored = yield* storedFacts(id)
      expect(stored.map((fact) => fact.type)).toEqual(list.map((fact) => fact.type))
      const expected = macrosteps(plan, stored)
      // Then each macrostep is written once, in order, the done snapshot included, and every other write is a touch of
      // the snapshot written just before it: never an older one.
      const split = classify(writes, expected)
      expect(split.stray).toBe(-1)
      expect(split.matched).toBe(expected.length)
      expect(writes.length).toBe(expected.length + split.touches.length)
      expect(split.touches.length).toBeLessThanOrEqual(offered)
      expect(Bun.deepEquals(writes.at(-1)?.status, expected.at(-1), true)).toBe(true)
      expect(writes.at(-1)?.status.run).toMatchObject({ state: "cancelled", tags: ["ended", "stopped"] })
      // And each write stamps the clock at the write; the file holds it.
      for (const [index, write] of writes.entries()) {
        expect(write.aliveAt).toBeLessThanOrEqual(write.ranAt)
        expect(write.onDisk?.run.aliveAt).toBe(write.aliveAt)
        expect(write.aliveAt).toBeGreaterThanOrEqual(writes[index - 1]?.aliveAt ?? 0)
      }
      // And nothing writes after the done snapshot: a touch now returns and writes nothing.
      const count = writes.length
      yield* recorder.touch
      yield* recorder.record({ type: "run.started" })
      yield* Effect.sleep(200)
      expect(writes.length).toBe(count)
      expect((yield* storedFacts(id)).length).toBe(stored.length)
    }),
  60_000,
)
