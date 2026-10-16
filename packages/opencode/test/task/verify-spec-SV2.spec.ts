import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Deferred, Duration, Effect, FileSystem, Layer, Option, Path, Predicate, Semaphore } from "effect"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { TaskHarness } from "@/task/core/harness"
import type { Fact, Plan } from "@/task/core/model"
import { TaskRecorder, type Unstamped } from "@/task/core/recorder"
import { RunSupervisor } from "@/task/core/supervise/run"
import type { TaskWorkers } from "@/task/core/workers"
import { TaskWorkspace } from "@/task/core/workspace"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, trustLeaf } from "./lib/machine"
import { BASE, boundary, eventually, repository, storedFacts, type Turn } from "./lib/supervise"

// Scenario SV2 (spec task-harness-feedback, D6, AD-8; tasks T2.7-T2.10): the run supervisor starts work from the
// machine's tags and records every outcome as a fact.
//
//   Given a run with a ready leaf and a verifying scenario
//   When the run supervisor reads the run actor
//   Then it spawns one task supervisor for the leaf and one scenario supervisor for the scenario
//   And each supervisor records the outcome of its phase as a fact through the Recorder
//   And a supervisor stops when its unit leaves the ready, active and verifying tags
//   And the run machine itself invokes nothing
//
// The run is the release-notes plan folded from a stored slice in which T1.1 and T1.2 are trusted, S2 proved its
// tests (so it waits for its judge in `verifying`) and S3 and S7 failed theirs: T1.3 is the one ready leaf and S2 the
// one verifying scenario. Everything that runs is the real code: the run supervisor in a real TaskHarness system, the
// real task and scenario supervisors and their workers, a real Recorder over the real event store, a scratch git
// repository for the worktree, and the real hook routing of the harness root for the judge's verdict. Only the model
// side is scripted: a builder turn runs until it is stopped, and the judge answers `verdict` when the test lets it.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SPEC_DIR = path.resolve(import.meta.dir, "../../../../task-formats/blend/release-notes.spec")
const JUDGE_S2 = "task-harness role=verifier scenario=S2"
const SUPERVISED = ["ready", "active", "verifying"]
// The scripted bounds, with a stream idle time longer than any test, so a quiet builder turn never stalls here.
const LIMITS: TaskLimits.Limits = { ...TaskLimits.scripted, streamIdle: Duration.seconds(120) }

// T1.1 and T1.2 trusted; S2 passed its tests and waits for its judge; S3 and S7 failed theirs.
const givenSlice = (plan: Plan): ReadonlyArray<Fact> => {
  const f = facts()
  return [
    f.runStarted(plan.path),
    ...trustLeaf(plan, f, "T1.1"),
    ...trustLeaf(plan, f, "T1.2"),
    f.scenarioProved("S2", "passed"),
    f.scenarioProved("S3", "failed", "no test"),
    f.scenarioProved("S7", "failed", "no test"),
  ]
}

let runs = 0

// The run of the scenario, spawned by the harness root as run:<runID>.
const startRun = Effect.fnUntraced(function* () {
  const plan = yield* loadPlan("release-notes.spec")
  const root = yield* repository()
  const harness = yield* TaskHarness.make
  const events = yield* EventV2Bridge.Service
  const id = `task_sv2run${(runs++).toString(16).padStart(4, "0")}`
  const stored = givenSlice(plan)
  const recorder = yield* TaskRecorder.make({ plan, runID: id, directory: root, stored, events })
  // Every fact the run records, in the order the Recorder's `record` received it.
  const recorded: Array<string> = []
  const judge = yield* Deferred.make<void>()
  const delivered: Array<boolean> = []
  // A builder turn runs until its supervisor stops it; the judge of S2 answers `verdict` through the harness hooks.
  const turn: Turn = (prompt) =>
    prompt.text.startsWith(JUDGE_S2)
      ? Deferred.await(judge).pipe(
          Effect.andThen(
            harness.hooks.send({
              type: "hook.verdicts",
              session: prompt.session,
              verdicts: [{ id: "S2", verdict: "trusted" }],
            }),
          ),
          Effect.flatMap((sent) => Effect.sync(() => delivered.push(sent))),
        )
      : Effect.never
  const { env, seen } = boundary(
    Array.from({ length: 40 }, () => turn),
    [],
  )
  const run: TaskWorkers.Run = {
    env,
    id,
    directory: root,
    base: BASE,
    specDir: SPEC_DIR,
    plan,
    root: SessionID.make("ses_sv2_root"),
    model: { providerID: "test", modelID: "test" },
    limits: LIMITS,
    locks: { checkout: yield* Semaphore.make(1), git: yield* Semaphore.make(1) },
    recorder: {
      actor: recorder.actor,
      touch: recorder.touch,
      record: (fact: Unstamped) =>
        Effect.sync(() => recorded.push(describe(fact))).pipe(Effect.andThen(recorder.record(fact))),
    },
    claim: harness.claimSession,
  }
  // The Given: in the fold of the stored slice, T1.3 is the one task tagged ready or active, and S2 the one
  // scenario tagged verifying.
  const before = yield* recorder.actor.getSnapshot
  expect(plan.tasks.filter((task) => snapshotHas(before, task.id, ["ready", "active"])).map((task) => task.id)).toEqual(
    ["T1.3"],
  )
  expect(plan.tasks.find((task) => task.id === "T1.3")?.children).toEqual([])
  expect(plan.scenarios.filter((item) => before.hasTag(`${item.id}:verifying`)).map((item) => item.id)).toEqual(["S2"])

  yield* harness.spawnRun(id, RunSupervisor.machine, {
    run,
    events,
    resumed: true,
    path: plan.path,
    trusts: Effect.succeed([]),
    externals: [],
    release: Effect.void,
    writer: recorder.writer,
  } satisfies RunSupervisor.Input)
  const taskRef = TaskHarness.systemId.task(id, "T1.3")
  const scenarioRef = TaskHarness.systemId.scenario(id, "S2")
  const alive = (systemId: string) => Effect.map(harness.system.get(systemId), Option.isSome)
  const runActor = recorder.actor
  const unitState = (unit: string) =>
    Effect.map(runActor.getSnapshot, (snapshot) => TaskEngineXState.unitState(snapshot, unit))
  return {
    plan,
    root,
    harness,
    events,
    id,
    recorder,
    recorded,
    judge,
    delivered,
    seen,
    taskRef,
    scenarioRef,
    alive,
    unitState,
  }
})

const describe = (fact: Unstamped) =>
  fact.type === "scenario.verified"
    ? `${fact.type} ${fact.verdict.id} ${fact.verdict.verdict}`
    : "task" in fact
      ? `${fact.type} ${fact.task}`
      : "id" in fact
        ? `${fact.type} ${fact.id}`
        : fact.type

const describeStored = (fact: Fact) => {
  const { at: _at, ...rest } = fact
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) a stored fact without its stamp is an Unstamped fact of the same member
  return describe(rest as Unstamped)
}

const snapshotHas = (snapshot: { hasTag: (tag: string) => boolean }, unit: string, tags: ReadonlyArray<string>) =>
  tags.some((tag) => snapshot.hasTag(`${unit}:${tag}`))

// The run supervisor's unit-supervisor children: the ids that start with task: or scenario:.
const unitChildren = Effect.fnUntraced(function* (harness: TaskHarness.Interface, id: string) {
  const ref = yield* harness.system.get(TaskHarness.systemId.run(id))
  if (Option.isNone(ref)) return []
  const snapshot: unknown = yield* ref.value.getSnapshot
  const children = Predicate.hasProperty(snapshot, "children") ? snapshot.children : {}
  return Object.keys(Predicate.isObject(children) ? children : {})
    .filter((key) => key.startsWith("task:") || key.startsWith("scenario:"))
    .toSorted()
})

// The builder session of a task, from the run's view.
const sessionOf = Effect.fnUntraced(function* (setup: Effect.Success<ReturnType<typeof startRun>>, task: string) {
  return TaskEngineXState.view(yield* setup.recorder.actor.getSnapshot).tasks[task]?.session ?? ""
})

it.live(
  "[SV2] from the run actor's tags the run supervisor spawns one task supervisor for the ready leaf and one scenario supervisor for the verifying scenario, and none for any other unit",
  () =>
    Effect.gen(function* () {
      const setup = yield* startRun()
      yield* eventually(setup.alive(setup.taskRef), "the T1.3 task supervisor")
      yield* eventually(setup.alive(setup.scenarioRef), "the S2 scenario supervisor")
      expect(yield* unitChildren(setup.harness, setup.id)).toEqual([setup.scenarioRef, setup.taskRef].toSorted())
      // No other task or scenario of the plan has a supervisor: waiting, trusted and failed units get none.
      for (const task of setup.plan.tasks.filter((item) => item.id !== "T1.3"))
        expect({ task: task.id, alive: yield* setup.alive(TaskHarness.systemId.task(setup.id, task.id)) }).toEqual({
          task: task.id,
          alive: false,
        })
      for (const scenario of setup.plan.scenarios.filter((item) => item.id !== "S2"))
        expect({
          scenario: scenario.id,
          alive: yield* setup.alive(TaskHarness.systemId.scenario(setup.id, scenario.id)),
        }).toEqual({ scenario: scenario.id, alive: false })
      // More snapshots (T1.3 starts building) spawn no second supervisor for the same unit.
      yield* eventually(
        Effect.map(setup.unitState("T1.3"), (state) => state === "building"),
        "T1.3 building",
      )
      expect(yield* unitChildren(setup.harness, setup.id)).toEqual([setup.scenarioRef, setup.taskRef].toSorted())
    }),
  60_000,
)

it.live(
  "[SV2] each supervisor records the outcome of its phase as a fact through the Recorder: stored, then folded into the run actor",
  () =>
    Effect.gen(function* () {
      const setup = yield* startRun()
      // The task supervisor's ready phase: begin made the worktree and the builder session, then task.started.
      yield* eventually(
        Effect.map(setup.unitState("T1.3"), (state) => state === "building"),
        "T1.3 building after task.started",
      )
      const startedFact = (yield* storedFacts(setup.id)).find(
        (fact) => fact.type === "task.started" && fact.task === "T1.3",
      )
      if (startedFact === undefined || startedFact.type !== "task.started") throw new Error("no task.started for T1.3")
      expect(startedFact.worktree).toBe(TaskWorkspace.worktreePath(yield* Path.Path, setup.root, setup.id, "T1.3"))
      expect(yield* (yield* FileSystem.FileSystem).exists(startedFact.worktree)).toBe(true)
      const view = TaskEngineXState.view(yield* setup.recorder.actor.getSnapshot)
      expect(view.tasks["T1.3"]).toMatchObject({ session: startedFact.session, worktree: startedFact.worktree })

      // The scenario supervisor's judge round: the judge answers, and the supervisor records scenario.verified.
      yield* Deferred.succeed(setup.judge, undefined)
      yield* eventually(
        Effect.map(setup.unitState("S2"), (state) => state === "trusted"),
        "S2 trusted after scenario.verified",
      )
      expect(setup.delivered).toEqual([true])

      // The task supervisor's building phase: a spend-cap retry status ends it with task.needs_human.
      yield* setup.events.publish(SessionStatus.Event.Status, {
        sessionID: SessionID.make(yield* sessionOf(setup, "T1.3")),
        status: { type: "retry", attempt: 1, message: "You exceeded your current quota", next: 0 },
      })
      yield* eventually(
        Effect.map(setup.unitState("T1.3"), (state) => state === "needs_human"),
        "T1.3 needs a human after task.needs_human",
      )

      // Each outcome went through the Recorder's record, and the store holds exactly what record received, in its
      // order: run.resumed (the run supervisor's start), then the units' facts.
      const stored = (yield* storedFacts(setup.id)).map(describeStored)
      expect(stored).toEqual(setup.recorded)
      expect(setup.recorded).toEqual([
        "run.resumed",
        "task.started T1.3",
        "scenario.verified S2 trusted",
        "task.needs_human T1.3",
      ])
      const needsHuman = (yield* storedFacts(setup.id)).find((fact) => fact.type === "task.needs_human")
      expect(needsHuman).toMatchObject({ task: "T1.3", reason: "spend cap: You exceeded your current quota" })
      // The fold holds the same facts: each one moved its unit in the run actor's history, in the store's order.
      const log = (yield* setup.recorder.actor.getSnapshot).context.log
      const since = yield* firstAt(setup.id)
      const moves = log
        .filter((entry) => (entry.unit === "T1.3" || entry.unit === "S2") && entry.at >= since)
        .map((entry) => `${entry.unit} ${entry.to}`)
      expect(moves).toEqual(["T1.3 building", "S2 trusted", "T1.3 needs_human"])
    }),
  60_000,
)

it.live(
  "[SV2] a scenario supervisor stops when its scenario leaves verifying, while the leaf's supervisor and the run go on",
  () =>
    Effect.gen(function* () {
      const setup = yield* startRun()
      yield* eventually(setup.alive(setup.scenarioRef), "the S2 scenario supervisor")
      yield* eventually(
        Effect.map(setup.unitState("T1.3"), (state) => state === "building"),
        "T1.3 building",
      )
      yield* Deferred.succeed(setup.judge, undefined)
      yield* eventually(
        Effect.map(setup.alive(setup.scenarioRef), (live) => !live),
        "the S2 supervisor stopped",
      )
      const snapshot = yield* setup.recorder.actor.getSnapshot
      expect(TaskEngineXState.unitState(snapshot, "S2")).toBe("trusted")
      expect(snapshotHas(snapshot, "S2", SUPERVISED)).toBe(false)
      // The run goes on: the run actor is live, T1.3 still builds under its own supervisor, the supervisor still runs.
      expect(snapshot.status).toBe("active")
      expect(snapshotHas(snapshot, "T1.3", ["active"])).toBe(true)
      expect(yield* setup.alive(setup.taskRef)).toBe(true)
      expect(yield* setup.harness.running(setup.id)).toBe(true)
      expect(yield* unitChildren(setup.harness, setup.id)).toEqual([setup.taskRef])
    }),
  60_000,
)

it.live(
  "[SV2] a task supervisor lives through its phases and stops when its task leaves ready and active, while the scenario's supervisor and the run go on",
  () =>
    Effect.gen(function* () {
      const setup = yield* startRun()
      yield* eventually(setup.alive(setup.taskRef), "the T1.3 task supervisor")
      const first = yield* setup.harness.system.get(setup.taskRef)
      // ready -> building keeps the same supervisor: the unit is still tagged active.
      yield* eventually(
        Effect.map(setup.unitState("T1.3"), (state) => state === "building"),
        "T1.3 building",
      )
      yield* eventually(
        Effect.sync(() => setup.seen.prompts.some((prompt) => prompt.agent === "task-builder")),
        "the T1.3 builder turn",
      )
      const second = yield* setup.harness.system.get(setup.taskRef)
      expect(Option.isSome(first) && Option.isSome(second) && first.value === second.value).toBe(true)
      // The spend cap ends T1.3's building phase: needs_human is tagged ended and stopped, not ready or active.
      yield* setup.events.publish(SessionStatus.Event.Status, {
        sessionID: SessionID.make(yield* sessionOf(setup, "T1.3")),
        status: { type: "retry", attempt: 1, message: "You exceeded your current quota", next: 0 },
      })
      yield* eventually(
        Effect.map(setup.alive(setup.taskRef), (live) => !live),
        "the T1.3 supervisor stopped",
      )
      const snapshot = yield* setup.recorder.actor.getSnapshot
      expect(TaskEngineXState.unitState(snapshot, "T1.3")).toBe("needs_human")
      expect(snapshotHas(snapshot, "T1.3", SUPERVISED)).toBe(false)
      // The run goes on: S2 still waits for its judge under its own supervisor.
      expect(snapshot.status).toBe("active")
      expect(snapshot.hasTag("S2:verifying")).toBe(true)
      expect(yield* setup.alive(setup.scenarioRef)).toBe(true)
      expect(yield* setup.harness.running(setup.id)).toBe(true)
      expect(yield* unitChildren(setup.harness, setup.id)).toEqual([setup.scenarioRef])
      // The stopped supervisor's builder turn was cancelled.
      expect(setup.seen.cancels).toContain(yield* sessionOf(setup, "T1.3"))
    }),
  60_000,
)

it.live(
  "[SV2] the run machine itself invokes nothing: no state invokes an actor and the run actor spawns no child",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const machine = TaskMachine.machine(plan)
      // Every state node of a machine, walked from its root, with what it invokes.
      const nodesOf = (root: unknown) => {
        const nodes: Array<{ id: string; invoke: ReadonlyArray<unknown> }> = []
        const walk = (node: unknown) => {
          if (!Predicate.hasProperty(node, "id") || !Predicate.hasProperty(node, "states")) return
          const invoke = Predicate.hasProperty(node, "invoke") && Array.isArray(node.invoke) ? node.invoke : []
          nodes.push({ id: String(node.id), invoke })
          for (const child of Object.values(Predicate.isObject(node.states) ? node.states : {})) walk(child)
        }
        walk(root)
        return nodes
      }
      // The walk sees invocations where they exist: the run supervisor invokes its workers (a control).
      expect(
        nodesOf(RunSupervisor.machine.root)
          .filter((node) => node.invoke.length > 0)
          .map((node) => node.id),
      ).toEqual(expect.arrayContaining(["run.starting", "run.running.heartbeat.touching"]))
      const nodes = nodesOf(machine.root)
      expect(nodes.length).toBeGreaterThan(100)
      expect(nodes.filter((node) => node.invoke.length > 0).map((node) => node.id)).toEqual([])
      // The machine has no actor implementations to invoke or spawn.
      const actors: unknown = machine.implementations.actors
      expect(Object.keys(Predicate.isObject(actors) ? actors : {})).toEqual([])
      // And in a live run the run actor never holds a child: the supervisors run beside it, not inside it.
      const setup = yield* startRun()
      yield* eventually(setup.alive(setup.taskRef), "the T1.3 task supervisor")
      yield* eventually(
        Effect.map(setup.unitState("T1.3"), (state) => state === "building"),
        "T1.3 building",
      )
      yield* Deferred.succeed(setup.judge, undefined)
      yield* eventually(
        Effect.map(setup.unitState("S2"), (state) => state === "trusted"),
        "S2 trusted",
      )
      expect(Object.keys((yield* setup.recorder.actor.getSnapshot).children)).toEqual([])
    }),
  60_000,
)

// The time of the first fact this job stored: entries before it come from the stored slice.
const firstAt = Effect.fnUntraced(function* (id: string) {
  return (yield* storedFacts(id))[0]?.at ?? 0
})
