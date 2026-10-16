import { expect } from "bun:test"
import { Clock, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { Fact, Plan } from "@/task/core/model"
import { TaskRecorder } from "@/task/core/recorder"
import { TaskStatus } from "@/task/core/status"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { fail, loadPlan, pass } from "./lib/machine"

// Scenario RM25 (spec task-harness-feedback, AD-5, T1.5 and T1.7): start times, end times and spans come only from
// machine actions.
//
//   Given the loaded example-cascade plan and facts with fixed times
//   When T1.1 builds and fails its proof, and T1.3 builds and is trusted
//   Then T1.1 has its start time at task.started, its end time at the failing proof, and the spans waiting,
//     building, proving and a zero-length budget_exhausted
//   And the blocked T1.2 has an end time and no start time
//   And a stale obligation on the trusted T1.3 clears its end time and starts its clock again
//
// The plan is `task-formats/blend/example-cascade.spec`, loaded by the real loader (`Blend.load`, then
// `TaskCommand.plan`): T1.1 (budget 1, gate T1.1.c1), T1.2 after T1.1, T1.3 (T1.3.c1), under the parent T1. The
// facts carry fixed times (1000, 2000, ...) and fold through the engine API (`initial`, `apply`). The times and spans
// are read from the machine's snapshot context and from the status projection (`TaskStatus.project`), and from the
// status file that today's run writer (the real `TaskRecorder`, a live actor of the same machine) writes. The
// Recorder stamps each fact with its clock's time, so that test records each fact under a clock fixed at its time.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))
const engine = TaskEngineXState

const SPEC = "task-formats/blend/example-cascade.spec"

// The facts of the scenario, each with a fixed time `base + n * 1000`.
const facts = (base = 0) => {
  const at = (n: number) => base + n * 1000
  const started = (task: string, n: number): Fact => ({
    type: "task.started",
    at: at(n),
    task,
    worktree: `/wt/${task}`,
    branch: `task/${task}`,
    base: "base0",
    session: `ses_${task}`,
  })
  return {
    at,
    // The run starts; T1.1 and T1.3 are built; T1.3 is proved and trusted while T1.1 waits for its proof.
    untilTrusted: [
      { type: "run.started", at: at(1) },
      started("T1.1", 2),
      started("T1.3", 3),
      { type: "task.ready", at: at(4), task: "T1.1", head: "head1" },
      { type: "task.ready", at: at(5), task: "T1.3", head: "head1" },
      { type: "task.proved", at: at(6), task: "T1.3", results: [pass("T1.3.c1")] },
      { type: "task.verified", at: at(7), task: "T1.3", verdicts: [] },
    ] satisfies ReadonlyArray<Fact>,
    // T1.1 fails its proof on its one attempt (budget 1).
    failedProof: {
      type: "task.proved",
      at: at(8),
      task: "T1.1",
      results: [fail("T1.1.c1", "BUILD-1 exited 1")],
    } satisfies Fact,
    // The obligation of the trusted T1.3 goes stale (its unit hash changed), half way between 7 and 8.
    stale: { type: "obligation.stale", at: at(7.5), id: "T1.3.c1", hash: "hash2" } satisfies Fact,
  }
}

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(plan)) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), from)

// The times and spans of a unit, as the machine's context holds them.
const timesOf = (snapshot: RunSnapshot, id: string) => {
  const slot = snapshot.context.units[id]
  return { startedAt: slot?.startedAt, endedAt: slot?.endedAt, spans: slot?.spans }
}

// The expected times and spans of the When, for facts from `facts(base)`.
const expected = (base: number) => {
  const at = facts(base).at
  return {
    "T1.1": {
      startedAt: at(2),
      endedAt: at(8),
      spans: [
        { state: "waiting", from: at(1), to: at(2) },
        { state: "building", from: at(2), to: at(4) },
        { state: "proving", from: at(4), to: at(8) },
        { state: "budget_exhausted", from: at(8), to: at(8) },
      ],
    },
    "T1.2": {
      startedAt: undefined,
      endedAt: at(8),
      spans: [
        { state: "waiting", from: at(1), to: at(8) },
        { state: "blocked", from: at(8), to: at(8) },
      ],
    },
    T1: {
      startedAt: undefined,
      endedAt: at(8),
      spans: [
        { state: "waiting", from: at(1), to: at(8) },
        { state: "blocked", from: at(8), to: at(8) },
      ],
    },
    "T1.3": {
      startedAt: at(3),
      endedAt: at(7),
      spans: [
        { state: "waiting", from: at(1), to: at(3) },
        { state: "building", from: at(3), to: at(5) },
        { state: "proving", from: at(5), to: at(6) },
        { state: "verifying", from: at(6), to: at(7) },
        { state: "trusted", from: at(7), to: at(7) },
      ],
    },
  }
}

it.live("[RM25] the loaded example-cascade plan: T1.1 has budget 1, T1.2 waits on T1.1, T1.3 is independent", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("example-cascade.spec")
    expect(plan.specPath).toBe(SPEC)
    expect(plan.tasks.map((task) => [task.id, task.afterEffective, task.children])).toEqual([
      ["T1", [], ["T1.1", "T1.2", "T1.3"]],
      ["T1.1", [], []],
      ["T1.2", ["T1.1"], []],
      ["T1.3", [], []],
    ])
    expect(plan.budget("T1.1")).toBe(1)
    // Before any fact no unit has a time or a span: the times start with the slice's run.started.
    const first = engine.initial(plan)
    for (const [id, slot] of Object.entries(first.context.units)) {
      expect({ id, startedAt: slot.startedAt, endedAt: slot.endedAt, spans: slot.spans }).toEqual({
        id,
        startedAt: undefined,
        endedAt: undefined,
        spans: undefined,
      })
    }
  }),
)

it.live(
  "[RM25] T1.1 starts at task.started, ends at the failing proof, with spans waiting, building, proving and a zero-length budget_exhausted",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const snapshot = fold(plan, [...f.untilTrusted, f.failedProof])
      const view = engine.view(snapshot)
      expect(view.tasks["T1.1"]?.state).toBe("budget_exhausted")
      expect(view.tasks["T1.3"]?.state).toBe("trusted")
      expect(timesOf(snapshot, "T1.1")).toEqual(expected(0)["T1.1"])
      // The last span is zero-length: it starts and ends at the failing proof.
      const last = timesOf(snapshot, "T1.1").spans?.at(-1)
      expect(last?.state).toBe("budget_exhausted")
      expect(last?.from).toBe(f.failedProof.at)
      expect(last?.to).toBe(last?.from)
      // The start is the time of task.started and the end the time of the failing proof.
      expect(timesOf(snapshot, "T1.1").startedAt).toBe(f.untilTrusted[1]?.at)
      expect(timesOf(snapshot, "T1.1").endedAt).toBe(f.failedProof.at)
      // T1.3 built and trusted: its clock runs from task.started to its trust, closed with a zero-length span.
      expect(timesOf(snapshot, "T1.3")).toEqual(expected(0)["T1.3"])
      // The run started at run.started and ended at the macrostep that settled it.
      expect(snapshot.status).toBe("done")
      expect(view.run.state).toBe("budget_exhausted")
      expect(snapshot.context.units.run?.startedAt).toBe(f.at(1))
      expect(snapshot.context.units.run?.endedAt).toBe(f.at(8))
    }),
)

it.live("[RM25] the blocked T1.2 has an end time and no start time", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("example-cascade.spec")
    const f = facts()
    const snapshot = fold(plan, [...f.untilTrusted, f.failedProof])
    const view = engine.view(snapshot)
    expect(view.tasks["T1.2"]?.state).toBe("blocked")
    expect(engine.blockedBy(snapshot, "T1.2")).toEqual({ id: "T1.1", state: "budget_exhausted" })
    expect(timesOf(snapshot, "T1.2")).toEqual(expected(0)["T1.2"])
    expect("startedAt" in (snapshot.context.units["T1.2"] ?? {})).toBe(false)
    // The parent T1 is blocked by T1.1 too, in the same macrostep: an end time and no start time.
    expect(view.tasks.T1?.state).toBe("blocked")
    expect(timesOf(snapshot, "T1")).toEqual(expected(0).T1)
  }),
)

it.live("[RM25] a stale obligation on the trusted T1.3 clears its end time and starts its clock again", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("example-cascade.spec")
    const f = facts()
    // T1.3 is trusted and T1.1 still proves: the run is active, so the stale fact moves T1.3.
    const trusted = fold(plan, f.untilTrusted)
    expect(trusted.status).toBe("active")
    expect(engine.view(trusted).tasks["T1.3"]?.state).toBe("trusted")
    expect(timesOf(trusted, "T1.3")).toEqual(expected(0)["T1.3"])
    const reopened = engine.apply(plan, trusted, f.stale)
    expect(engine.view(reopened).tasks["T1.3"]?.state).toBe("proving")
    // The end time is cleared, and the clock starts again at the stale fact's time.
    expect(timesOf(reopened, "T1.3").endedAt).toBeUndefined()
    expect("endedAt" in (reopened.context.units["T1.3"] ?? {})).toBe(false)
    expect(timesOf(reopened, "T1.3").startedAt).toBe(f.stale.at)
    // The trusted span stays closed, and a new proving span opens at the stale fact's time.
    expect(timesOf(reopened, "T1.3").spans).toEqual([
      ...expected(0)["T1.3"].spans,
      { state: "proving", from: f.stale.at },
    ])
    // Then T1.1 fails its proof: T1.3 keeps its new clock, and the run waits for it.
    const after = engine.apply(plan, reopened, f.failedProof)
    expect(engine.view(after).tasks["T1.1"]?.state).toBe("budget_exhausted")
    expect(timesOf(after, "T1.1")).toEqual(expected(0)["T1.1"])
    expect(timesOf(after, "T1.3")).toEqual(timesOf(reopened, "T1.3"))
    expect(after.status).toBe("active")
  }),
)

it.live(
  "[RM25] the times and spans are the fact times only: a shifted clock shifts every value by the same amount",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const shift = 5_000_000
      const zero = facts()
      const later = facts(shift)
      const a = fold(plan, [...zero.untilTrusted, zero.failedProof])
      const b = fold(plan, [...later.untilTrusted, later.failedProof])
      for (const id of ["T1", "T1.1", "T1.2", "T1.3"] as const) {
        expect(timesOf(a, id)).toEqual(expected(0)[id])
        expect(timesOf(b, id)).toEqual(expected(shift)[id])
      }
      // The same facts fold to the same times: no wall clock enters the fold.
      const again = fold(plan, [...zero.untilTrusted, zero.failedProof])
      expect(again.context.units).toEqual(a.context.units)
      // The stale reopen follows the shift too.
      const reopened = engine.apply(plan, fold(plan, later.untilTrusted), later.stale)
      expect(timesOf(reopened, "T1.3").startedAt).toBe(shift + 7500)
    }),
)

it.live("[RM25] the status projection copies the machine's times and spans unchanged", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("example-cascade.spec")
    const f = facts()
    const snapshot = fold(plan, [...f.untilTrusted, f.failedProof])
    const status = TaskStatus.project(plan, snapshot)
    for (const id of ["T1", "T1.1", "T1.2", "T1.3"] as const) {
      const want = expected(0)[id]
      expect(status.tasks[id]).toMatchObject({ spans: want.spans })
      expect(status.tasks[id]?.startedAt).toBe(want.startedAt)
      expect(status.tasks[id]?.endedAt).toBe(want.endedAt)
    }
    expect(status.run.startedAt).toBe(f.at(1))
    expect(status.run.endedAt).toBe(f.at(8))
    // The reopened T1.3: no end time in the file, and the new start.
    const reopened = TaskStatus.project(plan, engine.apply(plan, fold(plan, f.untilTrusted), f.stale))
    expect(reopened.tasks["T1.3"]?.startedAt).toBe(f.stale.at)
    expect(reopened.tasks["T1.3"] && "endedAt" in reopened.tasks["T1.3"]).toBe(false)
  }),
)

const statusFile = (directory: string) => path.join(directory, ".opencode", "task", "status.json")
const decode = (text: string) => Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))(text)

// A clock fixed at one time: the Recorder stamps each fact it records with the clock's time, so a fact recorded
// under it keeps its fixed time. Sleeps still use the live clock.
const fixedAt = (live: Clock.Clock, at: number): Clock.Clock => ({
  currentTimeMillisUnsafe: () => at,
  currentTimeMillis: Effect.succeed(at),
  currentTimeNanosUnsafe: () => BigInt(at) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(at) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: live.monotonicTimeNanos,
  sleep: (duration) => live.sleep(duration),
})

let runs = 0
// Today's run writer: the Recorder's live actor records the facts; its status writer writes the file.
const recorded = Effect.fnUntraced(function* (
  plan: Plan,
  list: ReadonlyArray<Fact>,
  done: (status: TaskStatus.Status) => boolean,
) {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  const events = yield* EventV2Bridge.Service
  const live = yield* Clock.Clock
  const runID = `task_rm25${(runs++).toString(16).padStart(4, "0")}${Date.now().toString(16)}`
  const recorder = yield* TaskRecorder.make({ plan, runID, directory, stored: [], events })
  for (const fact of list) yield* recorder.record(fact).pipe(Effect.provideService(Clock.Clock, fixedAt(live, fact.at)))
  // The writer runs on its own fiber: wait until it has written the last macrostep.
  for (let tries = 0; tries < 3_000; tries++) {
    const text = yield* fs.readFileString(statusFile(directory)).pipe(Effect.option)
    if (Option.isSome(text)) {
      const status = decode(text.value)
      if (done(status)) return status
    }
    yield* Effect.sleep(10)
  }
  return yield* Effect.die(new Error("the status writer never wrote the last macrostep"))
})

it.live(
  "[RM25] the run's live actor and status writer write the same times and spans as the fold",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const status = yield* recorded(
        plan,
        [...f.untilTrusted, f.failedProof],
        (each) => each.run.state === "budget_exhausted",
      )
      for (const id of ["T1", "T1.1", "T1.2", "T1.3"] as const) {
        const want = expected(0)[id]
        expect(status.tasks[id]?.spans).toEqual(want.spans)
        expect(status.tasks[id]?.startedAt).toBe(want.startedAt)
        expect(status.tasks[id]?.endedAt).toBe(want.endedAt)
      }
      const reopened = yield* recorded(
        plan,
        [...f.untilTrusted, f.stale],
        // The write after the stale fact: T1.3 proving again, after its trusted span (an earlier write had T1.3
        // proving before its trust).
        (each) =>
          each.tasks["T1.3"]?.state === "proving" &&
          (each.tasks["T1.3"]?.spans.some((span) => span.state === "trusted") ?? false),
      )
      expect(reopened.tasks["T1.3"]?.startedAt).toBe(f.stale.at)
      expect(reopened.tasks["T1.3"]?.endedAt).toBeUndefined()
      expect(reopened.tasks["T1.3"]?.spans.at(-1)).toEqual({ state: "proving", from: f.stale.at })
    }),
  60_000,
)
