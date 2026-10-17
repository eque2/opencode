import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Layer, Semaphore } from "effect"
import path from "path"
import { createActor, SimulatedClock } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import type { Fact, Plan } from "@/task/core/model"
import { TaskRecorder } from "@/task/core/recorder"
import { RunSupervisor } from "@/task/core/supervise/run"
import { ScenarioSupervisor } from "@/task/core/supervise/scenario"
import { TaskSupervisor } from "@/task/core/supervise/task"
import { TaskWorkers } from "@/task/core/workers"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { facts, judge, loadPlan, obligationsOf, trust, trustLeaf } from "./lib/machine"
import { BASE, boundary, eventually, runOf, settle, storedFacts, storedTypes, unitOf } from "./lib/supervise"

// Scenario SV6 (spec task-harness-feedback, AD-8, D6; tasks T2.8, T2.9, T2.10): three worker failures in a row fail
// the unit with a harness error.
//
//   Given a task supervisor whose worker fails
//   When the worker fails three times in a row
//   Then the supervisor records task.failed with a reason that starts "harness error:"
//   And a scenario batch whose worker fails three times records its scenario fact the same way
//
// No worker is replaced. Each worker fails for a real reason: the root checkout of the run is a directory with no git
// repository, so the real `begin` worker (a worktree) and the real batch worker (`scenarioProof`, which reads the base
// head) fail on their first git call. The judge test fails the harness's `session.claim` input, so the real judge
// worker fails before its prompt. The supervisors are the real machines on a SimulatedClock, so the test moves each
// 1 s retry on exactly; every fact goes through a real Recorder into the real event store.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SCENARIOS_DIR = path.resolve(import.meta.dir, "../../../../task-formats/blend/example-scenarios.spec")

const NOT_GIT = "not a git repository"

let runs = 0

const reasonOf = (fact: Fact | undefined) => (fact !== undefined && "reason" in fact ? (fact.reason ?? "") : "")

it.live(
  "[SV6] a task supervisor whose begin worker fails three times in a row records task.failed with a harness error",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      // The root checkout has no git repository: the real begin worker fails on `git worktree prune`.
      const directory = yield* fs.makeTempDirectoryScoped()
      const setup = yield* runOf({ plan, directory, stored: [f.runStarted()] })
      const unit = unitOf(yield* setup.recorder.actor.getSnapshot, "T1.1")

      // Given a task supervisor (for the ready leaf T1.1) whose worker fails.
      expect(unit.tags).toContain("ready")
      const task = plan.spec.tasks.find((item) => item.id === "T1.1")
      if (task === undefined) throw new Error("no task T1.1")
      const clock = new SimulatedClock()
      const actor = yield* createActor(TaskSupervisor.machine, {
        input: {
          run: setup.run,
          events: setup.events,
          task,
          spec: plan.spec,
          owner: `task:${setup.id}:T1.1`,
          entry: unit.entry,
          tags: unit.tags,
          runStart: 0,
        } satisfies TaskSupervisor.Input,
        clock,
      })
      yield* actor.start
      const failedTimes = (count: number) =>
        eventually(
          Effect.map(
            actor.getSnapshot,
            (snapshot) => snapshot.context.failures === count && snapshot.matches({ live: { work: "retrying" } }),
          ),
          `worker failure ${count}, then a retry`,
        )

      // When the worker fails three times in a row: failures 1 and 2 record nothing and retry after 1 s.
      yield* failedTimes(1)
      expect((yield* actor.getSnapshot).context.error).toContain(NOT_GIT)
      yield* settle
      expect(yield* storedTypes(setup.id)).toEqual([])
      yield* clock.increment(999)
      yield* settle
      expect((yield* actor.getSnapshot).context.failures).toBe(1)
      yield* clock.increment(1)
      yield* failedTimes(2)
      yield* settle
      expect(yield* storedTypes(setup.id)).toEqual([])
      yield* clock.increment(1_000)
      yield* eventually(
        Effect.map(storedTypes(setup.id), (types) => types.length === 1),
        "the fact of the third failure",
      )

      // Then the supervisor records task.failed with a reason that starts "harness error:".
      const recorded = yield* storedFacts(setup.id)
      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toMatchObject({ type: "task.failed", task: "T1.1" })
      const reason = reasonOf(recorded[0])
      expect(reason.startsWith("harness error:")).toBe(true)
      // The reason carries the third failure's own message: the begin worker's git error.
      expect(reason).toContain("git worktree prune")
      expect(reason).toContain(NOT_GIT)
      // The record worker ends after the fact is stored: then the supervisor waits quietly.
      yield* eventually(
        Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches({ live: { work: "quiet" } })),
        "the supervisor is quiet",
      )
      expect((yield* actor.getSnapshot).context.failures).toBe(3)
      // The fact folds: T1.1 has failed in the run actor.
      yield* eventually(
        Effect.map(
          setup.recorder.actor.getSnapshot,
          (snapshot) => TaskEngineXState.unitState(snapshot, "T1.1") === "failed",
        ),
        "T1.1 folds to failed",
      )
      // No fourth try: the quiet supervisor records nothing more.
      yield* clock.increment(5_000)
      yield* settle
      expect(yield* storedTypes(setup.id)).toEqual(["task.failed"])
    }),
  60_000,
)

// The example-scenarios plan with T1.1 and its parent T1 trusted: S1 needs only T1.1, so it is ready for its batch.
const scenarioReady = (plan: Plan): ReadonlyArray<Fact> => {
  const f = facts()
  const review = obligationsOf(plan, "T1")
  return [
    f.runStarted(),
    ...trustLeaf(plan, f, "T1.1"),
    f.proved("T1", review.map(judge)),
    f.verified("T1", review.map(trust)),
  ]
}

it.live(
  "[SV6] a scenario batch whose worker fails three times in a row records scenario.proved failed with a harness error",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const plan = yield* loadPlan("example-scenarios.spec")
      // The root checkout has no git repository: the real batch worker fails when it reads the base head.
      const directory = yield* fs.makeTempDirectoryScoped()
      const events = yield* EventV2Bridge.Service
      const id = `task_sv6batch${(runs++).toString(16).padStart(4, "0")}`
      const recorder = yield* TaskRecorder.make({
        plan,
        runID: id,
        directory,
        stored: scenarioReady(plan),
        events,
        write: () => Effect.void,
      })
      const before = yield* recorder.actor.getSnapshot
      // Given: every task is trusted and S1 is ready for its batch proof.
      expect(TaskEngineXState.unitState(before, "T1.1")).toBe("trusted")
      expect(TaskEngineXState.unitState(before, "T1")).toBe("trusted")
      expect(RunSupervisor.readyScenarios(plan, before)).toEqual(["S1"])
      const { env } = boundary([])
      const run: TaskWorkers.Run = {
        env,
        id,
        directory,
        base: BASE,
        // The stale cadence reads the real spec folder, which loads unchanged and records nothing.
        specDir: SCENARIOS_DIR,
        plan,
        root: SessionID.make("ses_sv6_root"),
        model: { providerID: "test", modelID: "test" },
        limits: TaskLimits.scripted,
        locks: { checkout: yield* Semaphore.make(1), git: yield* Semaphore.make(1) },
        recorder,
        claim: () => Effect.void,
      }
      const clock = new SimulatedClock()
      const actor = yield* createActor(RunSupervisor.machine, {
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
      yield* actor.start
      const batchFailed = (count: number) =>
        eventually(
          Effect.map(
            actor.getSnapshot,
            (snapshot) =>
              snapshot.context.batchFailures === count &&
              snapshot.matches({ running: { scenarios: "retrying" } }) &&
              snapshot.context.batch.includes("S1"),
          ),
          `batch failure ${count}, then a retry`,
        )

      // When the batch worker fails three times in a row: failures 1 and 2 record nothing and retry after 1 s.
      yield* batchFailed(1)
      expect((yield* actor.getSnapshot).context.error).toContain(NOT_GIT)
      yield* settle
      expect(yield* storedTypes(id)).toEqual(["run.resumed"])
      yield* clock.increment(1_000)
      yield* batchFailed(2)
      yield* settle
      expect(yield* storedTypes(id)).toEqual(["run.resumed"])
      yield* clock.increment(1_000)
      yield* eventually(
        Effect.map(storedTypes(id), (types) => types.includes("scenario.proved")),
        "the fact of the third batch failure",
      )

      // Then its scenario fact is recorded the same way: scenario.proved failed, with a "harness error:" reason.
      const recorded = (yield* storedFacts(id)).filter((fact) => fact.type === "scenario.proved")
      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toMatchObject({ type: "scenario.proved", id: "S1", status: "failed" })
      const reason = reasonOf(recorded[0])
      expect(reason.startsWith("harness error:")).toBe(true)
      expect(reason).toContain("rev-parse")
      expect(reason).toContain(NOT_GIT)
      // The fact folds: S1 has failed, and no fourth batch runs.
      yield* eventually(
        Effect.map(recorder.actor.getSnapshot, (snapshot) => TaskEngineXState.unitState(snapshot, "S1") === "failed"),
        "S1 folds to failed",
      )
      yield* clock.increment(5_000)
      yield* settle
      expect((yield* storedFacts(id)).filter((fact) => fact.type === "scenario.proved")).toHaveLength(1)
    }),
  60_000,
)

it.live(
  "[SV6] a scenario supervisor whose judge worker fails three times in a row records scenario.verified rejected with a harness error",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const directory = yield* fs.makeTempDirectoryScoped()
      let claims = 0
      // S2 needs only T1.1: with T1.1 trusted and S2's tests passed, S2 waits for its judge. The harness cannot
      // claim the judge's session, so the real judge worker fails before its prompt.
      const setup = yield* runOf({
        plan,
        directory,
        stored: [f.runStarted(), ...trustLeaf(plan, f, "T1.1"), f.scenarioProved("S2", "passed")],
        claim: () =>
          Effect.suspend(() => {
            claims++
            return Effect.fail(new TaskWorkers.WorkerError({ message: "the session index is closed" }))
          }),
      })
      const unit = unitOf(yield* setup.recorder.actor.getSnapshot, "S2")
      expect(unit.tags).toContain("verifying")
      const scenario = plan.spec.scenarios.find((item) => item.id === "S2")
      if (scenario === undefined) throw new Error("no scenario S2")
      const clock = new SimulatedClock()
      const actor = yield* createActor(ScenarioSupervisor.machine, {
        input: { run: setup.run, scenario, owner: `scenario:${setup.id}:S2`, entry: unit.entry, tags: unit.tags },
        clock,
      })
      yield* actor.start
      const failedTimes = (count: number) =>
        eventually(
          Effect.map(
            actor.getSnapshot,
            (snapshot) => snapshot.context.failures === count && snapshot.matches("retrying"),
          ),
          `judge failure ${count}, then a retry`,
        )
      yield* failedTimes(1)
      yield* settle
      expect(yield* storedTypes(setup.id)).toEqual([])
      yield* clock.increment(1_000)
      yield* failedTimes(2)
      yield* settle
      expect(yield* storedTypes(setup.id)).toEqual([])
      yield* clock.increment(1_000)
      yield* eventually(
        Effect.map(storedTypes(setup.id), (types) => types.length === 1),
        "the fact of the third judge failure",
      )
      expect(claims).toBe(3)
      expect(setup.seen.prompts).toEqual([])
      const recorded = yield* storedFacts(setup.id)
      expect(recorded[0]).toMatchObject({
        type: "scenario.verified",
        verdict: { id: "S2", verdict: "rejected", reason: "harness error: the session index is closed" },
      })
      yield* eventually(
        Effect.map(
          setup.recorder.actor.getSnapshot,
          (snapshot) => TaskEngineXState.unitState(snapshot, "S2") === "rejected",
        ),
        "S2 folds to rejected",
      )
      yield* eventually(
        Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches("quiet")),
        "the supervisor is quiet",
      )
    }),
  60_000,
)
