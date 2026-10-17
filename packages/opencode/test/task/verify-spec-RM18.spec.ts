import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Deferred, Effect, FileSystem, Layer, Option, Path } from "effect"
import fs from "fs"
import path from "path"
import ts from "typescript"
import { createActor, createMachine, fromEffect, SimulatedClock } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { BlendModel } from "@/task/blend/model"
import type { Plan } from "@/task/core/model"
import type { Unstamped } from "@/task/core/recorder"
import { TaskStatus } from "@/task/core/status"
import { RunSupervisor } from "@/task/core/supervise/run"
import { ScenarioSupervisor } from "@/task/core/supervise/scenario"
import { TaskSupervisor } from "@/task/core/supervise/task"
import { TaskWorkers } from "@/task/core/workers"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { type RunMachine, TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import {
  facts,
  loadPlan,
  obligationsOf,
  outcome,
  pass,
  trust,
  trustLeaf,
  unitState as machineState,
} from "./lib/machine"
import { eventually, type Run, runOf, settle, stored, storedFacts } from "./lib/supervise"

// Scenario RM18 (spec task-harness-feedback, D3, D4, AD-20, T1.11 and T1.14): the phase-1 runner reads readiness and
// completion from the machine.
//
//   Given the runner after phase 1
//   When a run proceeds
//   Then the runner starts a task only when the snapshot tags it ready
//   And the runner keeps no readiness check, no outside trust set and no done decision of its own
//   And the runner never records run.ended in state done
//   And the runner stops when the snapshot status is done
//
// "The runner after phase 1": phase 1 put the polled runner on the run snapshot (T1.11), and phase 2 replaced it by
// the run supervisor and its unit supervisors (T2.11, T2.12 deleted `src/task/core/runner.ts`). So the runner of this
// tree is the real run supervisor (`RunSupervisor.machine`) over a real Recorder and the real event store (the
// `runOf` helper of test/task/lib/supervise.ts), on a SimulatedClock so that no timer moves the run. Only the unit
// supervisors and the batch proof are stand-ins: a task stand-in logs the run snapshot when the runner spawns it
// (that is, starts the task) and then records the task's scripted work through `TaskWorkers.record`; a scenario
// stand-in records its verifier's trust. The readiness and done negative controls run the same runner on copies of
// the plan's machine config (`TaskMachine.mapStates`, the generator's tool for negative controls).

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))
const engine = TaskEngineXState

const SOURCE = path.resolve(import.meta.dir, "../../src/task")

type Actors = NonNullable<Parameters<typeof RunSupervisor.machine.provide>[0]["actors"]>

interface Options {
  readonly trusts?: ReadonlyArray<string>
  readonly resumed?: boolean
}

// The real run supervisor as a root actor, with the given unit supervisors and batch proof.
const supervise = Effect.fnUntraced(function* (setup: Run, actors: Actors, options: Options = {}) {
  const actor = yield* createActor(RunSupervisor.machine.provide({ actors }), {
    input: {
      run: setup.run,
      events: setup.events,
      resumed: options.resumed ?? false,
      path: setup.run.plan.path,
      trusts: Effect.succeed(options.trusts ?? []),
      externals: [],
      release: Effect.void,
      writer: setup.recorder.writer,
    },
    clock: new SimulatedClock(),
  })
  yield* actor.start
  return actor
})

/** A task as the runner started it: the tags it was given, and the run snapshot at that moment. */
interface Spawn {
  readonly unit: string
  readonly tags: ReadonlyArray<string>
  readonly machine: string
  readonly readyTag: boolean
  /** The machine state of each of the task's dependencies (its after ids, then its children) at the start. */
  readonly dependencies: Readonly<Record<string, string>>
}

const spawnOf = (snapshot: RunSnapshot, plan: Plan, input: TaskSupervisor.Input): Spawn => {
  const id = input.task.id
  const planned = plan.tasks.find((task) => task.id === id)
  const dependencies = [...(planned?.afterEffective ?? []), ...(planned?.children ?? [])]
  return {
    unit: id,
    tags: input.tags,
    machine: machineState(snapshot, id),
    readyTag: snapshot.hasTag(`${id}:ready`),
    dependencies: Object.fromEntries(
      dependencies.map((dependency) => [dependency, machineState(snapshot, dependency)]),
    ),
  }
}

// The scripted work of a task: a leaf is built, proved with every obligation passed and verified; a parent's review
// is proved and trusted.
const workOf = (plan: Plan, task: BlendModel.Task): ReadonlyArray<Unstamped> =>
  task.children.length === 0
    ? [
        {
          type: "task.started",
          task: task.id,
          worktree: `/wt/${task.id}`,
          branch: `task/${task.id}`,
          base: "dev",
          session: `ses_${task.id}`,
        },
        { type: "task.ready", task: task.id, head: "head1" },
        { type: "task.proved", task: task.id, results: obligationsOf(plan, task.id).map(pass) },
        { type: "task.verified", task: task.id, verdicts: [] },
      ]
    : [
        { type: "task.proved", task: task.id, results: [] },
        { type: "task.verified", task: task.id, verdicts: obligationsOf(plan, task.id).map(trust) },
      ]

/** A task supervisor stand-in: it logs its start, then records the task's work (or, with `work` false, waits). */
const taskStandIn = (spawns: Array<Spawn>, work = true) =>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (b) the run supervisor only spawns, stops and sends events to a unit supervisor; the stand-in takes each such use
  fromEffect(({ input }: { input: TaskSupervisor.Input }) =>
    Effect.gen(function* () {
      spawns.push(spawnOf(yield* input.run.recorder.actor.getSnapshot, input.run.plan, input))
      const scripted = work ? workOf(input.run.plan, input.task) : []
      for (const fact of scripted) yield* TaskWorkers.record(input.run, fact)
      if (!work) return yield* Effect.never
      return undefined
    }),
  ) as unknown as typeof TaskSupervisor.machine

/** A scenario supervisor stand-in: its verifier trusts the scenario; `hold` keeps one scenario's verdict back. */
const scenarioStandIn = (hold?: {
  readonly id: string
  readonly held: Deferred.Deferred<void>
  readonly gate: Deferred.Deferred<void>
}) =>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (b) as for the task supervisor stand-in
  fromEffect(({ input }: { input: ScenarioSupervisor.Input }) =>
    Effect.gen(function* () {
      if (hold !== undefined && input.scenario.id === hold.id) {
        yield* Deferred.succeed(hold.held, undefined)
        yield* Deferred.await(hold.gate)
      }
      yield* TaskWorkers.record(input.run, {
        type: "scenario.verified",
        verdict: { id: input.scenario.id, verdict: "trusted" },
      })
    }),
  ) as unknown as typeof ScenarioSupervisor.machine

// The batch proof stand-in: every scenario of a batch passes.
const passingBatch = fromEffect(({ input }: { input: { run: TaskWorkers.Run; ids: ReadonlyArray<string> } }) =>
  Effect.gen(function* () {
    yield* FileSystem.FileSystem
    yield* Path.Path
    for (const id of input.ids) yield* TaskWorkers.record(input.run, { type: "scenario.proved", id, status: "passed" })
  }),
)

const allTrusted = (snapshot: RunSnapshot, ids: ReadonlyArray<string>) =>
  ids.every((id) => machineState(snapshot, id) === "trusted")

const nodeTags = (tags: unknown): ReadonlyArray<string> =>
  Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : []

// A copy of the plan's machine with one state's tags changed; it still passes the generator's checks.
const retagged = (
  plan: Plan,
  unit: string,
  state: string,
  edit: (tags: ReadonlyArray<string>) => ReadonlyArray<string>,
) =>
  TaskMachine.fromConfig(
    plan,
    TaskMachine.mapStates(TaskMachine.config(plan), (node) =>
      node.id === TaskMachine.stateId(unit, state) ? { ...node, tags: [...edit(nodeTags(node.tags))] } : node,
    ),
  )

// A copy of the plan's machine whose outcome region has no `run.settled` rows: it never becomes done. It fails the
// totality check by design (the outcome cannot settle), so it is built without the check.
const unsettled = (plan: Plan): RunMachine =>
  createMachine(
    TaskMachine.mapStates(TaskMachine.config(plan), (node) =>
      node.id === TaskMachine.stateId("run", "running") || node.id === TaskMachine.stateId("run", "waiting")
        ? { ...node, on: Object.fromEntries(Object.entries(node.on ?? {}).filter(([type]) => type !== "run.settled")) }
        : node,
    ),
    { actions: TaskMachine.ACTIONS, guards: TaskMachine.GUARDS },
  )

it.live(
  "[RM18] a run proceeds to done: the runner starts each task only while the snapshot tags it ready, keeps running while the machine is not done, and stops when it is done, with no run.ended recorded",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const setup = yield* runOf({ plan, directory: "/root", stored: [] })
      const spawns: Array<Spawn> = []
      const hold = { id: "S5", held: yield* Deferred.make<void>(), gate: yield* Deferred.make<void>() }
      // The directory recorded T9 and T8 as trusted before the run.
      const actor = yield* supervise(
        setup,
        { task: taskStandIn(spawns), scenario: scenarioStandIn(hold), batch: passingBatch },
        { trusts: ["T9", "T8"] },
      )
      const tasks = plan.tasks.map((task) => task.id)
      const others = plan.scenarios.map((scenario) => scenario.id).filter((id) => id !== "S5")

      // The run proceeds until every task and every scenario but S5 is trusted; S5's verdict is held back.
      yield* eventually(Deferred.isDone(hold.held), "S5 under its verifier")
      yield* eventually(
        Effect.map(setup.recorder.actor.getSnapshot, (snapshot) => allTrusted(snapshot, [...tasks, ...others])),
        "every task and every other scenario trusted",
      )
      yield* settle
      // Every task is trusted, but the machine is not done: the runner is still running its main region.
      const holding = yield* setup.recorder.actor.getSnapshot
      expect(holding.status).toBe("active")
      expect(machineState(holding, "S5")).toBe("verifying")
      expect(outcome(holding)).toBe("running")
      expect(TaskStatus.project(plan, holding).run.state).toBe("running")
      const live = yield* actor.getSnapshot
      expect(live.status).toBe("active")
      expect(live.matches({ running: { main: "active" } })).toBe(true)

      // S5's verdict makes the machine done; the runner then finishes and closes.
      yield* Deferred.succeed(hold.gate, undefined)
      yield* eventually(
        Effect.map(actor.getSnapshot, (snapshot) => snapshot.status === "done"),
        "the runner closed",
      )
      expect((yield* actor.getSnapshot).value).toBe("closed")
      const final = yield* setup.recorder.actor.getSnapshot
      expect(final.status).toBe("done")
      expect(TaskStatus.project(plan, final).run).toMatchObject({ state: "done", tags: ["ended"] })

      // The runner started every task exactly once, each while the snapshot tagged it ready and every dependency
      // (after task, child or outside precondition) was trusted.
      expect(spawns.map((spawn) => spawn.unit).toSorted(TaskEngineXState.byId)).toEqual(tasks)
      for (const spawn of spawns) {
        expect(spawn).toMatchObject({ unit: spawn.unit, tags: ["waiting", "ready"], machine: "ready", readyTag: true })
        expect([spawn.unit, Object.values(spawn.dependencies).filter((state) => state !== "trusted")]).toEqual([
          spawn.unit,
          [],
        ])
      }
      expect(spawns.find((spawn) => spawn.unit === "T1.5")?.dependencies).toEqual({
        "T1.3": "trusted",
        "T1.4": "trusted",
        T9: "trusted",
      })

      // The facts of the run: run.started first, each directory trust once, and never run.ended.
      const list = yield* storedFacts(setup.id)
      expect(list[0]).toMatchObject({ type: "run.started", path: plan.path })
      expect(list.flatMap((fact) => (fact.type === "outside.trusted" ? [fact.id] : []))).toEqual(["T9", "T8"])
      expect(list.filter((fact) => fact.type === "run.ended")).toEqual([])
      // The machine reached done from those facts alone: their fold through the engine is done too.
      const fold = list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), engine.initial(plan))
      expect(engine.ended(fold)).toBe(true)
    }),
  60_000,
)

it.live(
  "[RM18] the runner keeps no readiness check of its own: it starts a task the snapshot tags ready, and never one it does not tag",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")

      // A copy whose T1.5 `waiting` state also carries `T1.5:ready`: the runner starts T1.5 at once, although none of
      // its after tasks is trusted. A runner with its own readiness check would not.
      const early = yield* runOf({
        plan,
        directory: "/root",
        stored: [],
        machine: retagged(plan, "T1.5", "waiting", (tags) => [...tags, "T1.5:ready"]),
      })
      const first: Array<Spawn> = []
      yield* supervise(early, { task: taskStandIn(first, false), scenario: scenarioStandIn(), batch: passingBatch })
      yield* eventually(
        Effect.sync(() => first.length >= 3),
        "three tasks started",
      )
      yield* settle
      expect(first.map((spawn) => spawn.unit).toSorted(TaskEngineXState.byId)).toEqual(["T1.1", "T1.2", "T1.5"])
      expect(first.find((spawn) => spawn.unit === "T1.5")).toEqual({
        unit: "T1.5",
        tags: ["waiting", "ready"],
        machine: "waiting",
        readyTag: true,
        dependencies: { "T1.3": "waiting", "T1.4": "waiting", T9: "untrusted" },
      })

      // A copy whose T1.3 `ready` state lacks `T1.3:ready`: with T1.1 trusted, T1.3 is ready in the machine, but the
      // runner never starts it; it starts T1.2, which the snapshot tags ready.
      const f = facts()
      const late = yield* runOf({
        plan,
        directory: "/root",
        stored: [f.runStarted(), ...trustLeaf(plan, f, "T1.1")],
        machine: retagged(plan, "T1.3", "ready", (tags) => tags.filter((tag) => tag !== "T1.3:ready")),
      })
      const second: Array<Spawn> = []
      yield* supervise(
        late,
        { task: taskStandIn(second, false), scenario: scenarioStandIn(), batch: passingBatch },
        { resumed: true },
      )
      yield* eventually(
        Effect.sync(() => second.length >= 1),
        "T1.2 started",
      )
      yield* settle
      yield* settle
      const snapshot = yield* late.recorder.actor.getSnapshot
      expect(machineState(snapshot, "T1.3")).toBe("ready")
      expect(snapshot.hasTag("T1.3:ready")).toBe(false)
      expect(second.map((spawn) => spawn.unit)).toEqual(["T1.2"])
    }),
  60_000,
)

it.live(
  "[RM18] the runner keeps no done decision of its own: with every unit final in a machine that is not done, it keeps running",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      expect(plan.tasks.map((task) => task.id)).toEqual(["T1", "T1.1"])
      expect(plan.scenarios.map((scenario) => [scenario.id, scenario.needs])).toEqual([["S1", ["T1.1"]]])
      const setup = yield* runOf({ plan, directory: "/root", stored: [], machine: unsettled(plan) })
      const spawns: Array<Spawn> = []
      const actor = yield* supervise(setup, {
        task: taskStandIn(spawns),
        scenario: scenarioStandIn(),
        batch: passingBatch,
      })
      yield* eventually(
        Effect.map(setup.recorder.actor.getSnapshot, (snapshot) => allTrusted(snapshot, ["T1", "T1.1", "S1"])),
        "every unit trusted",
      )
      yield* settle
      yield* settle
      // Every unit is final, the copy's outcome region did not settle, and the machine is not done: the runner keeps
      // running. It has no rule of its own that ends a run whose tasks are all trusted.
      const snapshot = yield* setup.recorder.actor.getSnapshot
      expect(snapshot.status).toBe("active")
      expect(outcome(snapshot)).toBe("waiting")
      const live = yield* actor.getSnapshot
      expect(live.status).toBe("active")
      expect(live.matches({ running: { main: "active" } })).toBe(true)
      const list = yield* storedFacts(setup.id)
      expect(list.filter((fact) => fact.type === "run.ended")).toEqual([])
      // The same facts through the plan's own machine settle to done: only the machine's status ends a run.
      const fold = list.reduce((each, fact) => engine.apply(plan, each, fact), engine.initial(plan))
      expect(engine.ended(fold)).toBe(true)
      expect(TaskStatus.project(plan, fold).run.state).toBe("done")
    }),
  60_000,
)

it.live("[RM18] the runner keeps no outside trust set: it reads an outside trust from the snapshot", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const setup = yield* runOf({ plan, directory: "/root", stored: [] })
    const actor = yield* supervise(
      setup,
      { task: taskStandIn([], false), scenario: scenarioStandIn(), batch: passingBatch },
      { trusts: ["T9"] },
    )
    yield* stored(setup.id, 2)
    yield* eventually(
      Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches("running")),
      "the runner is running",
    )
    // T8 is trusted by a fact the runner did not record: the runner reads it from the snapshot, so a forwarded trust
    // of T8 records nothing; a forwarded trust of T9, which the runner recorded itself, records nothing either.
    yield* TaskWorkers.record(setup.run, { type: "outside.trusted", id: "T8" })
    yield* eventually(
      Effect.map(actor.getSnapshot, (snapshot) =>
        Option.match(snapshot.context.latest, {
          onNone: () => false,
          onSome: (latest) => machineState(latest, "T8") === "trusted",
        }),
      ),
      "the runner saw T8 trusted",
    )
    yield* actor.send({ type: "run.trust", id: "T8" })
    yield* actor.send({ type: "run.trust", id: "T9" })
    yield* settle
    yield* settle
    const list = yield* storedFacts(setup.id)
    expect(list.flatMap((fact) => (fact.type === "outside.trusted" ? [fact.id] : []))).toEqual(["T9", "T8"])
    // The runner holds no list of trusted ids: its in-flight list is empty once each trust has folded.
    expect((yield* actor.getSnapshot).context.trusting).toEqual([])
    expect(RunSupervisor.untrustedOutside(plan, yield* setup.recorder.actor.getSnapshot, "T8")).toBe(false)
  }),
)

// --- the runner's source ---------------------------------------------------------------------------------------------

const sources = (dir: string): ReadonlyArray<string> =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? sources(path.join(dir, entry.name))
        : entry.name.endsWith(".ts")
          ? [path.join(dir, entry.name)]
          : [],
    )

interface Ended {
  readonly file: string
  /** The text of the literal's `state`, if it has one. */
  readonly state: string | undefined
  /** Whether the literal is the argument of a `raise(...)` call: a supervisor event, not a fact. */
  readonly raised: boolean
}

const stringProperty = (literal: ts.ObjectLiteralExpression, name: string) =>
  literal.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name,
  )

// Every object literal `{ type: "run.ended", ... }` in a file.
const runEnded = (file: string): ReadonlyArray<Ended> => {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  const found: Array<Ended> = []
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const type = stringProperty(node, "type")
      if (type !== undefined && ts.isStringLiteral(type.initializer) && type.initializer.text === "run.ended") {
        const parent = node.parent
        found.push({
          file: path.relative(SOURCE, file),
          state: stringProperty(node, "state")?.initializer.getText(source),
          raised:
            ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "raise",
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const identifiers = (file: string): ReadonlyArray<string> => {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  const found: Array<string> = []
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) found.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

it.live(
  "[RM18] the runner's source: the polled runner is gone, no done or readiness helper of its own remains, and every run.ended it records has state failed, never done",
  () =>
    Effect.sync(() => {
      const core = sources(path.join(SOURCE, "core"))
      expect(core.length).toBeGreaterThan(10)
      expect(fs.existsSync(path.join(SOURCE, "core/runner.ts"))).toBe(false)
      expect(core.some((file) => path.basename(file) === "runner.ts")).toBe(false)
      // The phase-1 runner's own decisions (T1.11): `checkDone`, `follows`, the `ACTIVE` and `JUDGED` lists and the
      // trusted-outside set `trustActive` are named nowhere in the harness core.
      const names = new Set(core.flatMap(identifiers))
      expect(["checkDone", "follows", "ACTIVE", "JUDGED", "trustActive"].filter((name) => names.has(name))).toEqual([])
      // Every `run.ended` literal the core holds: the wall clock's fact, with state "failed", and the supervisor's
      // own `raise`d event, which is not a fact. None has state "done".
      const ended = core.flatMap(runEnded)
      expect(ended.filter((item) => item.state !== undefined)).toEqual([
        { file: path.join("core", "supervise", "run.ts"), state: '"failed"', raised: false },
      ])
      expect(ended.filter((item) => item.state === undefined).every((item) => item.raised)).toBe(true)
      expect(ended.some((item) => item.state?.includes("done"))).toBe(false)
    }),
)
