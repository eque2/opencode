import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { initialTransition, transition } from "@jambudipa/xstate-effect"
import type { Fact, Plan } from "@/task/core/model"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import {
  type Facts,
  exhaustLeaf,
  facts,
  fail,
  first,
  fold,
  judge,
  loadPlan,
  obligationState,
  observed,
  obligationsOf,
  outcome,
  reject,
  step,
  trust,
  trustLeaf,
  unitState,
} from "./lib/machine"

// The run machine generator (spine AD-1 to AD-5): one machine per plan, generated as plain data.

const it = testEffect(NodeServices.layer)

// The plain-data config, read as JSON-like records.
type Node = { readonly [key: string]: unknown }
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value)
const child = (node: unknown, ...keys: ReadonlyArray<string>): Node => {
  const found = keys.reduce((current, key) => (isNode(current) ? current[key] : undefined), node)
  if (!isNode(found)) throw new Error(`no node at ${keys.join(".")}`)
  return found
}
const states = (node: unknown) => child(node, "states")
const region = (config: unknown, key: string) => child(config, "states", "active", "states", key)

// Every state node of the config with its path, depth first.
const walk = (
  value: unknown,
  at: ReadonlyArray<string> = [],
): Array<{ readonly path: ReadonlyArray<string>; readonly node: Node }> => {
  if (!isNode(value)) return []
  const node = value
  const nested = isNode(node.states) ? node.states : {}
  return [
    { path: at, node },
    ...Object.entries(nested).flatMap(([key, value]) => (isNode(value) ? walk(value, [...at, key]) : [])),
  ]
}

// Every value under `key` anywhere in a plain-data tree.
const everywhere = (value: unknown, key: string): Array<unknown> => {
  if (Array.isArray(value)) return value.flatMap((item) => everywhere(item, key))
  if (!isNode(value)) return []
  return Object.entries(value).flatMap(([name, item]) => [...(name === key ? [item] : []), ...everywhere(item, key)])
}

const META_KINDS = ["task", "obligation", "scenario", "outside", "external", "run"]
const TAGS = ["waiting", "active", "ended", "stopped", "blocked", "dead", "ready", "building", "proving", "verifying"]

describe("TaskMachine.config", () => {
  it.live("has a parallel root with active and outcome, and the release-notes regions in order", () =>
    Effect.gen(function* () {
      const config = TaskMachine.config(yield* loadPlan("release-notes.spec"))
      expect(config.type).toBe("parallel")
      expect(Object.keys(states(config))).toEqual(["active", "outcome"])
      expect(child(config, "states", "active").type).toBe("parallel")
      expect(Object.keys(states(child(config, "states", "active")))).toEqual([
        "T1",
        "T1_1",
        "T1_2",
        "T1_3",
        "T1_4",
        "T1_5",
        ...Array.from({ length: 13 }, (_, index) => `S${index + 1}`),
        "T8",
        "T9",
      ])
      expect(child(region(config, "T8"), "states", "untrusted", "meta")).toEqual({
        unit: "T8",
        kind: "outside",
        state: "untrusted",
      })
    }),
  )

  it.live("gives each task region an evidence region of final obligation states, then work", () =>
    Effect.gen(function* () {
      const config = TaskMachine.config(yield* loadPlan("release-notes.spec"))
      const task = region(config, "T1_4")
      expect(task.type).toBe("parallel")
      expect(Object.keys(states(task))).toEqual(["evidence", "work"])
      const evidence = child(task, "states", "evidence")
      expect(evidence.type).toBe("parallel")
      expect(Object.keys(states(evidence))).toEqual([
        ...Array.from({ length: 8 }, (_, index) => `T1_4_c${index + 1}`),
        "T1_4_p1",
        "T1_4_f1",
        "T1_4_f2",
      ])
      for (const obligation of Object.values(states(evidence)))
        for (const state of Object.values(states(obligation))) expect(isNode(state) && state.type).toBe("final")
      expect(Object.keys(states(child(task, "states", "work")))).toEqual([
        "waiting",
        "ready",
        "building",
        "proving",
        "verifying",
        "judging",
        "trusted",
        "needs_human",
        "budget_exhausted",
        "failed",
        "blocked",
        "cancelled",
      ])
    }),
  )

  it.live("names states by explicit ids with `_` for `.`, and gives each unit state its meta", () =>
    Effect.gen(function* () {
      const config = TaskMachine.config(yield* loadPlan("release-notes.spec"))
      const work = child(region(config, "T1_4"), "states", "work", "states")
      expect(child(work, "budget_exhausted").id).toBe("T1_4/budget_exhausted")
      expect(child(work, "budget_exhausted", "meta")).toEqual({ unit: "T1.4", kind: "task", state: "budget_exhausted" })
      expect(child(work, "ready", "meta")).toEqual({ unit: "T1.4", kind: "task", state: "waiting" })
      const rejected = child(region(config, "T1_4"), "states", "evidence", "states", "T1_4_c7", "states", "rejected")
      expect(rejected.id).toBe("T1_4_c7/rejected")
      expect(rejected.meta).toEqual({ unit: "T1.4.c7", kind: "obligation", state: "rejected" })
      expect(child(region(config, "S2"), "states", "ready", "meta")).toEqual({
        unit: "S2",
        kind: "scenario",
        state: "pending",
      })
      expect(child(region(config, "S2"), "states", "parked", "meta")).toEqual({
        unit: "S2",
        kind: "scenario",
        state: "waiting",
      })
      expect(child(config, "states", "outcome", "states", "done", "meta")).toEqual({
        unit: "run",
        kind: "run",
        state: "done",
      })

      const nodes = walk(config).map((entry) => entry.node)
      const metas = nodes.flatMap((node) => (isNode(node.meta) ? [node.meta] : []))
      expect(metas.length).toBeGreaterThan(0)
      for (const meta of metas) expect(META_KINDS).toContain(String(meta.kind))
      // Every node with a meta has its explicit id, and no id repeats.
      const ids = nodes.flatMap((node) => (isNode(node.meta) ? [node.id] : []))
      expect(ids.every((id) => typeof id === "string" && /^[A-Za-z0-9_]+\/[a-z_]+$/.test(id))).toBe(true)
      expect(new Set(ids).size).toBe(ids.length)
    }),
  )

  it.live("tags every unit state from the closed vocabulary", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const config = TaskMachine.config(plan)
      const units = new Set([
        "run",
        ...plan.tasks.map((task) => task.id),
        ...plan.spec.obligations.map((obligation) => obligation.id),
        ...plan.scenarios.map((scenario) => scenario.id),
        ...Object.keys(plan.spec.outside),
      ])
      const tags = everywhere(config, "tags").flatMap((value) => (Array.isArray(value) ? value : [value]))
      expect(tags.length).toBeGreaterThan(0)
      for (const tag of tags) {
        expect(typeof tag).toBe("string")
        const text = String(tag)
        const split = text.indexOf(":")
        const unit = text.slice(0, split)
        const rest = text.slice(split + 1)
        expect(units.has(unit)).toBe(true)
        const known = TAGS.includes(rest) || (rest.startsWith("waits:") && units.has(rest.slice("waits:".length)))
        if (!known) throw new Error(`tag outside the vocabulary: ${text}`)
      }
    }),
  )

  it.live("holds no after, invoke or spawn, only assign and raise actions, and maxIterations 1000", () =>
    Effect.gen(function* () {
      const config = TaskMachine.config(yield* loadPlan("release-notes.spec"))
      for (const key of ["after", "invoke", "spawn", "delay", "delays"]) expect(everywhere(config, key)).toEqual([])
      expect(child(config, "options").maxIterations).toBe(1000)
      const named = [...everywhere(config, "actions"), ...everywhere(config, "entry"), ...everywhere(config, "exit")]
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map((action) => (isNode(action) ? action.type : action))
      expect(named.length).toBeGreaterThan(0)
      for (const name of named) {
        expect(typeof name).toBe("string")
        expect(Object.keys(TaskMachine.ACTIONS)).toContain(String(name))
      }
      for (const action of Object.values(TaskMachine.ACTIONS))
        expect(["xstate.assign", "xstate.raise"]).toContain(action.type)
    }),
  )

  it.live("gives a plan with no scenarios and no outside ids only task regions", () =>
    Effect.gen(function* () {
      const config = TaskMachine.config(yield* loadPlan("example-cascade.spec"))
      expect(Object.keys(states(child(config, "states", "active")))).toEqual(["T1", "T1_1", "T1_2", "T1_3"])
    }),
  )

  it.live("gives a task with no obligations only its work region", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const bare: Plan = {
        ...plan,
        spec: { ...plan.spec, obligations: plan.spec.obligations.filter((item) => item.task !== "T1.3") },
      }
      expect(Object.keys(states(region(TaskMachine.config(bare), "T1_3")))).toEqual(["work"])
      // With no obligation to prove, its empty proof and its empty verdicts still make it trusted.
      const f = facts()
      const trusted = fold(bare, [f.runStarted(), ...trustLeaf(bare, f, "T1.3")])
      expect(unitState(trusted, "T1.3")).toBe("trusted")
    }),
  )

  it.live("gives a subtree plan an external region for each folder task it is after", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec", "T1.5")
      expect(plan.external).toEqual(["T1.3", "T1.4"])
      const config = TaskMachine.config(plan)
      expect(Object.keys(states(child(config, "states", "active")))).toEqual(["T1_5", "S5", "T8", "T9", "T1_3", "T1_4"])
      const external = region(config, "T1_3")
      expect(Object.keys(states(external))).toEqual(["untrusted", "trusted"])
      expect(child(external, "states", "untrusted").type).toBe("final")
      expect(child(external, "states", "trusted").type).toBe("final")
      expect(child(external, "states", "trusted", "meta")).toEqual({ unit: "T1.3", kind: "external", state: "trusted" })
      const [snapshot] = yield* initialTransition(TaskMachine.machine(plan))
      expect(snapshot.status).toBe("active")
    }),
  )
})

describe("TaskMachine.machine", () => {
  it.live("dies naming the id when two units collide after `.` becomes `_`", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const clash: Plan = { ...plan, spec: { ...plan.spec, outside: { T1_1: "an outside task" } } }
      expect(() => TaskMachine.machine(clash)).toThrow(/T1_1/)
    }),
  )

  it.live("VF22 dies naming the spec when the plan holds no task", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      expect(() => TaskMachine.machine({ ...plan, tasks: [] })).toThrow(/example-scenarios.*no task/)
    }),
  )

  it.live("builds the release-notes machine, and its first snapshot is active", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      expect(TaskMachine.machine(plan)).toBe(TaskMachine.machine(plan))
      const [snapshot] = yield* initialTransition(TaskMachine.machine(plan))
      expect(snapshot.status).toBe("active")
    }),
  )
})

describe("readiness and the cascade (AD-3)", () => {
  const work = (config: unknown, id: string, state: string) =>
    child(region(config, TaskMachine.key(id)), "states", "work", "states", state)
  const guardIds = (guard: unknown): ReadonlyArray<string> => {
    if (!isNode(guard) || !isNode(guard.params)) return []
    if (guard.type === "xstate.stateIn") return [String(guard.params.stateValue).replace(/^#/, "")]
    if (Array.isArray(guard.params.guards)) return guard.params.guards.flatMap(guardIds)
    return guardIds(guard.params.guard)
  }
  const always = (node: unknown) => (isNode(node) && Array.isArray(node.always) ? node.always.filter(isNode) : [])
  const deadRows = (dependency: string) =>
    ["needs_human", "budget_exhausted", "failed", "blocked", "cancelled"].map(
      (state) => `${TaskMachine.key(dependency)}/${state}`,
    )

  it.live("RM7 blocks T1.5 and T1 in the macrostep that exhausts T1.4, with the named cause", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const list = observed(plan)
      const before = fold(plan, list.slice(0, -1))
      expect(unitState(before, "T1.4")).toBe("proving")
      expect(unitState(before, "T1.5")).toBe("waiting")
      expect(unitState(before, "T1")).toBe("waiting")
      const after = fold(plan, list.slice(-1), before)
      expect(after.status).toBe("active")
      expect(["T1.1", "T1.2", "T1.3"].map((id) => unitState(after, id))).toEqual(["trusted", "trusted", "trusted"])
      expect(unitState(after, "T1.4")).toBe("budget_exhausted")
      for (const id of ["T1.5", "T1"]) {
        expect(unitState(after, id)).toBe("blocked")
        expect(after.context.units[id]?.blockedBy).toEqual({ id: "T1.4", state: "budget_exhausted" })
        expect(after.context.units[id]?.reason).toBe("blocked by T1.4: budget exhausted")
      }
    }),
  )

  it.live("RM15 orders a waiting task's rows: one blocked row per dependency and dead state, then ready", () =>
    Effect.gen(function* () {
      const config = TaskMachine.config(yield* loadPlan("release-notes.spec"))
      const waiting = always(work(config, "T1.5", "waiting"))
      expect(waiting.map((row) => guardIds(row.guard)[0])).toEqual([
        ...deadRows("T1.3"),
        ...deadRows("T1.4"),
        "T1_3/trusted",
      ])
      expect(waiting.map((row) => row.target)).toEqual([...Array(10).fill("blocked"), "ready"])
      expect(guardIds(waiting.at(-1)?.guard)).toEqual(["T1_3/trusted", "T1_4/trusted", "T9/trusted"])
      const ready = always(work(config, "T1.5", "ready"))
      expect(ready.map((row) => row.target)).toEqual([...Array(10).fill("blocked"), "waiting"])
      // The way back to waiting reads every dependency's trusted state: it fires when any one leaves trusted.
      const back = ready.at(-1)
      expect(isNode(back?.guard) && back.guard.type).toBe("xstate.not")
      expect(guardIds(back?.guard)).toEqual(["T1_3/trusted", "T1_4/trusted", "T9/trusted"])
      // A parent depends on its children, in natural order.
      const parent = always(work(config, "T1", "waiting"))
      expect(parent.map((row) => guardIds(row.guard)[0])).toEqual([
        ...["T1.1", "T1.2", "T1.3", "T1.4", "T1.5"].flatMap(deadRows),
        "T1_1/trusted",
      ])
    }),
  )

  it.live("RM15 moves a ready task back to waiting when a dependency leaves trusted", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const ready = fold(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1")])
      expect(unitState(ready, "T1.3")).toBe("ready")
      const reopened = step(plan, ready, f.stale("T1.1.c1"))
      expect(unitState(reopened, "T1.1")).toBe("proving")
      expect(unitState(reopened, "T1.3")).toBe("waiting")
      expect(reopened.hasTag("T1.3:waits:T1.1")).toBe(true)
    }),
  )

  it.live("RM9 cascades a death down the chain, and each dependant names its first dead dependency", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const snapshot = fold(plan, [f.runStarted(), f.started("T1.2"), f.failed("T1.2", "the builder session died")])
      expect(unitState(snapshot, "T1.2")).toBe("failed")
      expect(unitState(snapshot, "T1.4")).toBe("blocked")
      expect(snapshot.context.units["T1.4"]?.blockedBy).toEqual({ id: "T1.2", state: "failed" })
      expect(unitState(snapshot, "T1.5")).toBe("blocked")
      expect(snapshot.context.units["T1.5"]?.blockedBy).toEqual({ id: "T1.4", state: "blocked" })
      expect(unitState(snapshot, "T1")).toBe("blocked")
      expect(snapshot.context.units.T1?.blockedBy).toEqual({ id: "T1.2", state: "failed" })
      expect(unitState(snapshot, "T1.3")).toBe("waiting")
    }),
  )

  it.live("RM16 makes two siblings with no order between them ready in the same snapshot", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const snapshot = fold(plan, [facts().runStarted()])
      expect(["T1.1", "T1.2", "T1.3", "T1.4", "T1.5", "T1"].map((id) => unitState(snapshot, id))).toEqual([
        "ready",
        "ready",
        "waiting",
        "waiting",
        "waiting",
        "waiting",
      ])
      expect(snapshot.hasTag("T1.1:ready")).toBe(true)
      expect(snapshot.hasTag("T1.2:ready")).toBe(true)
    }),
  )

  it.live("RM17 keeps a task after an untrusted outside id waiting, and readies it on the trust", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const tasks = fold(plan, [
        f.runStarted(),
        ...trustLeaf(plan, f, "T1.1"),
        ...trustLeaf(plan, f, "T1.2"),
        ...trustLeaf(plan, f, "T1.3"),
        ...trustLeaf(plan, f, "T1.4"),
      ])
      expect(unitState(tasks, "T1.5")).toBe("waiting")
      expect(tasks.hasTag("T1.5:waits:T9")).toBe(true)
      expect(tasks.hasTag("T1.5:waits:T1.4")).toBe(false)
      const trusted = step(plan, tasks, f.outside("T9"))
      expect(unitState(trusted, "T1.5")).toBe("ready")
      expect(unitState(trusted, "T9")).toBe("trusted")
      expect(step(plan, trusted, f.outside("T9"))).toBe(trusted)
    }),
  )

  it.live("RM13 moves a scenario to ready, to parked on an outside need, and back on a trust or a reopen", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const tasks = fold(plan, [
        f.runStarted(),
        ...trustLeaf(plan, f, "T1.1"),
        ...trustLeaf(plan, f, "T1.2"),
        ...trustLeaf(plan, f, "T1.3"),
        ...trustLeaf(plan, f, "T1.4"),
      ])
      expect(unitState(tasks, "S2")).toBe("ready")
      expect(unitState(tasks, "S13")).toBe("parked")
      expect(unitState(step(plan, tasks, f.outside("T8")), "S13")).toBe("ready")
      // A need that leaves trusted sends a parked scenario back to waiting.
      const reopened = step(plan, tasks, f.stale("T1.4.c1"))
      expect(unitState(reopened, "T1.4")).toBe("proving")
      expect(unitState(reopened, "S13")).toBe("waiting")
      expect(unitState(reopened, "S8")).toBe("waiting")
    }),
  )

  it.live("tags every state of a dependency other than trusted with its dependants' waits tags", () =>
    Effect.gen(function* () {
      const config = TaskMachine.config(yield* loadPlan("release-notes.spec"))
      const states = child(region(config, "T1_4"), "states", "work", "states")
      for (const [state, node] of Object.entries(states)) {
        const tags = isNode(node) && Array.isArray(node.tags) ? node.tags : []
        const waits = ["T1:waits:T1.4", "T1.5:waits:T1.4", "S13:waits:T1.4"]
        for (const tag of waits) expect(tags.includes(tag)).toBe(state !== "trusted")
      }
      expect(child(region(config, "T9"), "states", "untrusted").tags).toContain("T1.5:waits:T9")
      expect(child(region(config, "T9"), "states", "trusted").tags).toEqual(["T9:ended"])
    }),
  )

  it.live("has no row that targets its own state, and an oscillating copy fails instead of hanging", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const config = TaskMachine.config(plan)
      for (const { path: at, node } of walk(config)) {
        const rows = [
          ...(Array.isArray(node.always) ? node.always : []),
          ...Object.values(isNode(node.on) ? node.on : {}).flatMap((value) => (Array.isArray(value) ? value : [])),
        ].filter(isNode)
        for (const row of rows) expect(row.target === undefined || row.target !== at.at(-1)).toBe(true)
      }
      // ready → waiting and waiting → ready with no guard: an eventless loop that maxIterations stops.
      const looping = TaskMachine.mapStates(config, (node) => {
        if (node.id === "T1_1/waiting") return { ...node, always: [{ target: "ready" }] }
        if (node.id === "T1_1/ready") return { ...node, always: [{ target: "waiting" }] }
        return node
      })
      const exit = Effect.runSyncExit(initialTransition(TaskMachine.fromConfig(plan, looping)))
      // The port stops the loop at maxIterations with a TransitionError in an `error` snapshot.
      if (!Exit.isSuccess(exit))
        throw new Error(`the oscillating copy failed outside the machine: ${String(exit.cause)}`)
      const [looped] = exit.value
      expect(looped.status).toBe("error")
      expect(String(looped.error)).toContain("TransitionError: Infinite loop detected")
    }),
  )

  it.live("RM28 names no dead state of an outside id, and folds the observed facts to an active snapshot", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const config = TaskMachine.config(plan)
      const ids = walk(config).flatMap(({ node }) =>
        [...(Array.isArray(node.always) ? node.always : [])].filter(isNode).flatMap((row) => guardIds(row.guard)),
      )
      expect(ids.filter((id) => id.startsWith("T9/") || id.startsWith("T8/"))).toEqual(
        ids.filter((id) => id === "T9/trusted" || id === "T8/trusted"),
      )
      expect(fold(plan, observed(plan)).status).toBe("active")
    }),
  )

  it.live("ignores outside.trusted that names a task: the identical snapshot", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const snapshot = fold(plan, [f.runStarted()])
      expect(step(plan, snapshot, f.outside("T1.4"))).toBe(snapshot)
    }),
  )

  it.live("leaves a dependant that is building alone when its dependency is reopened and then dies", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const building = fold(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1"), f.started("T1.3")])
      expect(unitState(building, "T1.3")).toBe("building")
      const dead = fold(
        plan,
        [
          f.stale("T1.1.c1"),
          f.proved("T1.1", [fail("T1.1.c1", "red")]),
          f.ready("T1.1"),
          f.proved("T1.1", [fail("T1.1.c1", "red")]),
          f.ready("T1.1"),
          f.proved("T1.1", [fail("T1.1.c1", "red")]),
        ],
        building,
      )
      expect(unitState(dead, "T1.1")).toBe("budget_exhausted")
      expect(unitState(dead, "T1.3")).toBe("building")
      expect(unitState(fold(plan, trustLeaf(plan, f, "T1.3").slice(1), dead), "T1.3")).toBe("trusted")
    }),
  )

  it.live("leaves a building dependant alone on the cascade plan, and the run ends budget_exhausted", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const building = fold(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1"), f.started("T1.2")])
      expect(unitState(building, "T1.2")).toBe("building")
      // T1.1 has a budget of one attempt: reopened and failed once more, it is exhausted while T1.2 builds.
      const dead = fold(plan, [f.stale("T1.1.c1"), f.proved("T1.1", [fail("T1.1.c1", "BUILD-1 exited 1")])], building)
      expect(unitState(dead, "T1.1")).toBe("budget_exhausted")
      expect(unitState(dead, "T1.2")).toBe("building")
      expect(dead.status).toBe("active")
      const ended = fold(plan, [...trustLeaf(plan, f, "T1.2").slice(1), ...trustLeaf(plan, f, "T1.3")], dead)
      expect(unitState(ended, "T1.2")).toBe("trusted")
      expect(unitState(ended, "T1")).toBe("blocked")
      expect(ended.status).toBe("done")
      expect(outcome(ended)).toBe("budget_exhausted")
    }),
  )

  it.live("RM28 refuses a guard on an unknown state id, and every guard of a real config names a node", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const config = TaskMachine.config(plan)
      const nodes = new Set(walk(config).flatMap(({ node }) => (typeof node.id === "string" ? [node.id] : [])))
      const ids = walk(config).flatMap(({ node }) =>
        [
          ...(Array.isArray(node.always) ? node.always : []),
          ...Object.values(isNode(node.on) ? node.on : {}).flatMap((value) => (Array.isArray(value) ? value : [])),
        ]
          .filter(isNode)
          .flatMap((row) => guardIds(row.guard)),
      )
      expect(ids.length).toBeGreaterThan(0)
      expect(ids.filter((id) => !nodes.has(id))).toEqual([])
      const unknown = TaskMachine.mapStates(config, (node) => {
        if (node.id !== "T1_5/waiting") return node
        const rows = always(node)
        const first = rows[0]
        const guard = isNode(first?.guard) && isNode(first.guard.params) ? first.guard : {}
        const params = isNode(guard.params) ? guard.params : {}
        return {
          ...node,
          always: [
            { ...first, guard: { ...guard, params: { ...params, stateValue: "#nowhere/at_all" } } },
            ...rows.slice(1),
          ],
        }
      })
      expect(() => TaskMachine.fromConfig(plan, unknown)).toThrow("a guard names the unknown state id nowhere/at_all")
    }),
  )

  it.live("RM29 refuses each gap of the totality scan with a line that names it", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const config = TaskMachine.config(plan)
      type Edit = Parameters<typeof TaskMachine.mapStates>[1]
      const edit = (id: string, change: (rows: ReadonlyArray<Node>, node: Parameters<Edit>[0]) => ReturnType<Edit>) =>
        TaskMachine.mapStates(config, (node) => (node.id === id ? change(always(node), node) : node))
      const without = (id: string, drop: (row: Node) => boolean) =>
        edit(id, (rows, node) => ({ ...node, always: rows.filter((row) => !drop(row)) }))
      const named = (row: Node) => guardIds(row.guard)[0]
      const block = (row: Node) =>
        (Array.isArray(row.actions) ? row.actions : []).find((action) => isNode(action) && action.type === "block")
      // A blocked row whose action names another dependency than its guard reads.
      const wrongCause = edit("T1_5/waiting", (rows, node) => ({
        ...node,
        always: rows.map((row) =>
          named(row) === "T1_4/failed"
            ? {
                ...row,
                actions: (Array.isArray(row.actions) ? row.actions : []).map((action) =>
                  action === block(row) && isNode(action)
                    ? { ...action, params: { id: "T1.3", state: "failed" } }
                    : action,
                ),
              }
            : row,
        ),
      }))
      // A blocked row that reads two states: the scan wants one state per row, so the first dead dependency wins.
      const twoStates = edit("T1_5/waiting", (rows, node) => {
        const [one, two] = [rows[0]?.guard, rows[5]?.guard]
        return {
          ...node,
          always: [...rows, { ...rows[0], guard: { type: "xstate.and", params: { guards: [one, two] } } }],
        }
      })
      const cases: ReadonlyArray<readonly [string, ReturnType<typeof TaskMachine.config>]> = [
        [
          "T1.5 waiting has no row for all of its dependencies trusted",
          without("T1_5/waiting", (row) => row.target === "ready"),
        ],
        ["T1.5 waiting has no row for T1.4 failed", wrongCause],
        [
          "T1.5 waiting has no row for T1.4 cancelled",
          without("T1_5/waiting", (row) => named(row) === "T1_4/cancelled"),
        ],
        [
          "T1.5 ready has no row for T1.3 needs_human",
          without("T1_5/ready", (row) => named(row) === "T1_3/needs_human"),
        ],
        ["S13 waiting has no row for T8 untrusted", without("S13/waiting", (row) => row.target === "parked")],
        ["T1.5 waiting has a blocked row that reads more than one state", twoStates],
        ["T1.4 building has no way out", edit("T1_4/building", (_, node) => ({ ...node, on: {}, always: [] }))],
      ]
      for (const [line, copy] of cases) expect(() => TaskMachine.fromConfig(plan, copy)).toThrow(`totality: ${line}`)
    }),
  )

  it.live("RM29 refuses a config with T1.5's row for T1.4 budget_exhausted removed, before any fact", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const gap = TaskMachine.mapStates(TaskMachine.config(plan), (node) =>
        node.id === "T1_5/waiting"
          ? { ...node, always: always(node).filter((row) => guardIds(row.guard)[0] !== "T1_4/budget_exhausted") }
          : node,
      )
      expect(() => TaskMachine.fromConfig(plan, gap)).toThrow(
        "totality: T1.5 waiting has no row for T1.4 budget_exhausted",
      )
    }),
  )

  it.live("RM29 passes the totality scan for every plan that loads", () =>
    Effect.gen(function* () {
      for (const [name, root] of [
        ["release-notes.spec", undefined],
        ["release-notes.spec", "T1.5"],
        ["provider-ordering-admin.spec", undefined],
        ["example-scenarios.spec", undefined],
        ["example-cascade.spec", undefined],
      ] as const) {
        const plan = yield* loadPlan(name, root)
        expect(() => TaskMachine.machine(plan)).not.toThrow()
      }
    }),
  )
})

describe("the outcome region (AD-4)", () => {
  const run = (snapshot: ReturnType<typeof first>) => ({
    outcome: outcome(snapshot),
    status: snapshot.status,
    reason: snapshot.context.units.run?.reason,
  })
  // Every task of the release-notes plan trusted: the leaves, T9 for T1.5, then T1's review.
  const allTasks = (plan: Plan, f: Facts) => [
    f.runStarted(),
    ...trustLeaf(plan, f, "T1.1"),
    ...trustLeaf(plan, f, "T1.2"),
    ...trustLeaf(plan, f, "T1.3"),
    ...trustLeaf(plan, f, "T1.4"),
    f.outside("T9"),
    ...trustLeaf(plan, f, "T1.5"),
    f.proved("T1", []),
    f.verified("T1", [trust("T1.e1")]),
  ]
  const scenario = (f: Facts, id: string, verdict: "trusted" | "rejected" = "trusted") => [
    f.scenarioProved(id, "passed"),
    f.scenarioVerified(verdict === "trusted" ? trust(id) : reject(id, `${id} does not hold`)),
  ]

  it.live("rule 4: every task and every scenario trusted gives done with no reason", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      const f = facts()
      const before = fold(plan, [
        f.runStarted(),
        ...trustLeaf(plan, f, "T1.1"),
        f.proved("T1", []),
        f.verified("T1", [trust("T1.e1")]),
      ])
      expect(unitState(before, "S1")).toBe("ready")
      expect(run(before)).toEqual({ outcome: "running", status: "active", reason: undefined })
      const done = fold(plan, scenario(f, "S1"), before)
      expect(run(done)).toEqual({ outcome: "done", status: "done", reason: undefined })
    }),
  )

  it.live("moves outcome between running and waiting with the work, and logs neither move", () =>
    Effect.gen(function* () {
      expect(outcome(first(yield* loadPlan("release-notes.spec")))).toBe("running")
      // The T1.5 subtree: T1.5 waits on the folder tasks T1.3 and T1.4 and on T9, and nothing else can run.
      const plan = yield* loadPlan("release-notes.spec", "T1.5")
      const f = facts()
      const waiting = fold(plan, [f.runStarted(), f.outside("T1.3"), f.outside("T1.4")])
      expect(outcome(waiting)).toBe("waiting")
      expect(waiting.hasTag("run:waiting")).toBe(true)
      const running = step(plan, waiting, f.outside("T9"))
      expect(unitState(running, "T1.5")).toBe("ready")
      expect(outcome(running)).toBe("running")
      expect(running.hasTag("run:active")).toBe(true)
      expect(running.context.log.filter((entry) => entry.unit === "run" && entry.from !== entry.to)).toEqual([])
    }),
  )

  it.live("RM11 rule 1: the task that died first gives the outcome; lines for each dead task, then each blocked", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const snapshot = fold(plan, [
        f.runStarted(),
        f.started("T1.1"),
        f.needsHuman("T1.1", "spend cap: $5.00 reached"),
        f.started("T1.3"),
        f.failed("T1.3", "the builder session died"),
      ])
      expect(run(snapshot)).toEqual({
        outcome: "needs_human",
        status: "done",
        reason: ["T1.1 needs human", "T1.3 failed", "T1 blocked by T1.1", "T1.2 blocked by T1.1"].join("\n"),
      })
    }),
  )

  it.live("RM10 waits for an independent task that is still building before it settles", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const building = fold(plan, [f.runStarted(), f.started("T1.1"), f.started("T1.3"), f.ready("T1.1")])
      const dead = step(plan, building, f.proved("T1.1", [fail("T1.1.c1", "BUILD-1 exited 1")]))
      expect(unitState(dead, "T1.1")).toBe("budget_exhausted")
      expect(unitState(dead, "T1.2")).toBe("blocked")
      expect(unitState(dead, "T1.3")).toBe("building")
      expect(run(dead)).toEqual({ outcome: "running", status: "active", reason: undefined })
      // A run.settled that no longer holds (a unit is still building) meets only the last, targetless row.
      const [same] = Effect.runSync(transition(TaskMachine.machine(plan), dead, { type: "run.settled" }))
      expect(same).toBe(dead)
      const done = fold(plan, trustLeaf(plan, f, "T1.3").slice(1), dead)
      expect(unitState(done, "T1.3")).toBe("trusted")
      expect(run(done)).toEqual({
        outcome: "budget_exhausted",
        status: "done",
        reason: ["T1.1 budget exhausted", "T1 blocked by T1.1", "T1.2 blocked by T1.1"].join("\n"),
      })
    }),
  )

  it.live("RM12 owner ruling 1: every task trusted and a scenario rejected or failed gives failed", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      const f = facts()
      const tasks = fold(plan, [
        f.runStarted(),
        ...trustLeaf(plan, f, "T1.1"),
        f.proved("T1", []),
        f.verified("T1", [trust("T1.e1")]),
      ])
      expect(run(fold(plan, scenario(f, "S1", "rejected"), tasks))).toEqual({
        outcome: "failed",
        status: "done",
        reason: "acceptance not proved: S1 rejected",
      })
      expect(run(step(plan, tasks, f.scenarioProved("S1", "failed", "the [S1] test failed")))).toEqual({
        outcome: "failed",
        status: "done",
        reason: "acceptance not proved: S1 failed",
      })
    }),
  )

  it.live("RM13 rule 4 with a parked scenario: done, with the not-run line", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const tasks = fold(plan, allTasks(plan, f))
      expect(unitState(tasks, "S13")).toBe("parked")
      const ids = Array.from({ length: 12 }, (_, index) => `S${index + 1}`)
      const done = fold(
        plan,
        ids.flatMap((id) => scenario(f, id)),
        tasks,
      )
      expect(run(done)).toEqual({ outcome: "done", status: "done", reason: "not run: S13 waits on T8" })
    }),
  )

  it.live("rule 3 with parked scenarios: the acceptance line first, and every untrusted outside need named", () =>
    Effect.gen(function* () {
      const loaded = yield* loadPlan("release-notes.spec", "T1.4")
      // S13 needs T9 as well as T8 here, so its line names both.
      const plan: Plan = {
        ...loaded,
        scenarios: loaded.scenarios.map((each) =>
          each.id === "S13" ? { ...each, needs: [...each.needs, "T9"] } : each,
        ),
      }
      const f = facts()
      const tasks = fold(plan, [f.runStarted(), f.outside("T1.2"), f.outside("T1.3"), ...trustLeaf(plan, f, "T1.4")])
      expect(unitState(tasks, "S13")).toBe("parked")
      const done = fold(
        plan,
        [...scenario(f, "S6"), ...scenario(f, "S8", "rejected"), ...scenario(f, "S9"), ...scenario(f, "S11")],
        tasks,
      )
      expect(run(done)).toEqual({
        outcome: "failed",
        status: "done",
        reason: ["acceptance not proved: S8 rejected", "not run: S13 waits on T8, T9"].join("\n"),
      })
    }),
  )

  it.live("RM14 default 4: a cancel cancels every unfinished unit, keeps the finished ones and ends cancelled", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const going = fold(plan, [
        f.runStarted(),
        ...trustLeaf(plan, f, "T1.1"),
        f.started("T1.2"),
        f.started("T1.3"),
        f.ready("T1.3"),
        f.proved("T1.3", obligationsOf(plan, "T1.3").map(judge)),
        f.scenarioProved("S7", "passed"),
      ])
      expect(["T1.2", "T1.3", "S2", "S7"].map((id) => unitState(going, id))).toEqual([
        "building",
        "verifying",
        "ready",
        "verifying",
      ])
      const cancelled = step(plan, going, f.cancelled("user stop"))
      expect(unitState(cancelled, "S7")).toBe("cancelled")
      const proving = step(plan, step(plan, going, f.ready("T1.2")), f.cancelled("user stop"))
      expect(unitState(proving, "T1.2")).toBe("cancelled")
      // A waiting scenario and a ready task are unfinished too: the cancel ends them, it does not block them.
      expect(unitState(going, "S1")).toBe("waiting")
      expect(unitState(cancelled, "S1")).toBe("cancelled")
      const ready = fold(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1")])
      expect(unitState(ready, "T1.3")).toBe("ready")
      expect(unitState(step(plan, ready, f.cancelled("user stop")), "T1.3")).toBe("cancelled")
      expect(unitState(cancelled, "T1.1")).toBe("trusted")
      expect(["T1.2", "T1.3", "T1.4", "T1.5", "T1"].map((id) => unitState(cancelled, id))).toEqual(
        Array(5).fill("cancelled"),
      )
      expect(cancelled.context.units["T1.2"]?.reason).toBe("user stop")
      expect(unitState(cancelled, "S2")).toBe("cancelled")
      expect(obligationState(cancelled, "T1.1.c1")).toBe("trusted")
      expect(obligationState(cancelled, "T1.2.c1")).toBe("pending")
      expect(run(cancelled)).toEqual({ outcome: "cancelled", status: "done", reason: "user stop" })
      const ended = step(plan, going, f.ended("failed", "the run wall clock ran out"))
      expect(run(ended)).toEqual({ outcome: "failed", status: "done", reason: "the run wall clock ran out" })
    }),
  )

  it.live("keeps the stop rows on the units: no ancestor takes a stop, and active.onDone only raises", () =>
    Effect.gen(function* () {
      const config = TaskMachine.config(yield* loadPlan("release-notes.spec"))
      const active = child(config, "states", "active")
      const ancestors: ReadonlyArray<unknown> = [config, active, ...Object.values(states(active))]
      for (const node of ancestors.filter(isNode)) {
        const on = isNode(node.on) ? node.on : {}
        expect(on["run.cancelled"]).toBeUndefined()
        expect(on["run.ended"]).toBeUndefined()
      }
      expect(active.onDone).toEqual({ actions: [{ type: "settled" }] })
    }),
  )

  it.live("RM27 AC 4 outranks the spine: a stop after a death ends in the dead task's state", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const snapshot = fold(plan, [
        f.runStarted(),
        f.started("T1.1"),
        f.started("T1.3"),
        f.ready("T1.1"),
        f.proved("T1.1", [fail("T1.1.c1", "BUILD-1 exited 1")]),
        f.cancelled("user stop"),
      ])
      expect(unitState(snapshot, "T1.3")).toBe("cancelled")
      expect(unitState(snapshot, "T1.1")).toBe("budget_exhausted")
      expect(run(snapshot)).toEqual({
        outcome: "budget_exhausted",
        status: "done",
        reason: ["T1.1 budget exhausted", "T1 blocked by T1.1", "T1.2 blocked by T1.1", "user stop"].join("\n"),
      })
    }),
  )

  it.live("picks the earliest death by history order, and lists the dead in natural order", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const going = fold(plan, [f.runStarted(), f.started("T1.1"), f.started("T1.3")])
      const sameTime = (fact: Fact): Fact => ({ ...fact, at: 100 })
      const snapshot = fold(
        plan,
        [
          sameTime(f.failed("T1.3", "the builder session died")),
          sameTime(f.needsHuman("T1.1", "spend cap: $5.00 reached")),
        ],
        going,
      )
      expect(run(snapshot)).toEqual({
        outcome: "failed",
        status: "done",
        reason: ["T1.1 needs human", "T1.3 failed", "T1 blocked by T1.3", "T1.2 blocked by T1.1"].join("\n"),
      })
    }),
  )

  it.live("RM29 the totality scan requires a settle row for every final unit state", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const gap = TaskMachine.mapStates(TaskMachine.config(plan), (node) =>
        node.id === "run/running" && node.on !== undefined ? { ...node, on: { ...node.on, "run.settled": [] } } : node,
      )
      expect(() => TaskMachine.fromConfig(plan, gap)).toThrow("totality: run running has no settle row for T1 trusted")
    }),
  )
})

describe("history, causes, times and spans (AD-5)", () => {
  const entries = (snapshot: ReturnType<typeof first>, unit: string) =>
    snapshot.context.log.filter((entry) => entry.unit === unit).map(({ from, to, reason }) => ({ from, to, reason }))

  it.live("RM7 appends one entry per move with status names, and the blocked entries name their cause", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const snapshot = fold(plan, observed(plan))
      expect(entries(snapshot, "T1.5")).toEqual([
        { from: "waiting", to: "blocked", reason: "blocked by T1.4: budget exhausted" },
      ])
      expect(entries(snapshot, "T1")).toEqual([
        { from: "waiting", to: "blocked", reason: "blocked by T1.4: budget exhausted" },
      ])
      expect(entries(snapshot, "T1.4").map((entry) => `${entry.from}>${entry.to}`)).toEqual([
        "waiting>building",
        "building>proving",
        "proving>building",
        "building>proving",
        "proving>building",
        "building>proving",
        "proving>budget_exhausted",
      ])
      expect(entries(snapshot, "T1.1.c1")).toEqual([{ from: "pending", to: "trusted", reason: undefined }])
    }),
  )

  it.live("logs no toggle and no judging step, but the primary move and the targetless rows", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const started = fold(plan, [f.runStarted()])
      // The first macrostep made T1.1 and T1.2 ready: no entry for them, and none for the initial macrostep.
      expect(started.context.log.map((entry) => entry.unit)).toEqual(["run"])
      const trusted = fold(plan, trustLeaf(plan, f, "T1.1"), started)
      // T1.1 trusted makes T1.3 ready and S2 and S7 ready: the toggles add nothing.
      expect(entries(trusted, "T1.3")).toEqual([])
      expect(entries(trusted, "S2")).toEqual([])
      expect(entries(trusted, "T1.1").map((entry) => `${entry.from}>${entry.to}`)).toEqual([
        "waiting>building",
        "building>proving",
        "proving>verifying",
        "verifying>trusted",
      ])
      // T1.1 reopened sends T1.3 back to waiting: still no entry for T1.3.
      expect(entries(step(plan, trusted, f.stale("T1.1.c1")), "T1.3")).toEqual([])
      const stalled = fold(plan, [f.started("T1.2"), f.stalled("T1.2", "no stream for 120 s")], trusted)
      expect(entries(stalled, "T1.2").at(-1)).toEqual({
        from: "building",
        to: "building",
        reason: "no stream for 120 s",
      })
      const repeated = step(plan, stalled, f.repeated("T1.2", "read src/bump.ts 5 times"))
      expect(entries(repeated, "T1.2").at(-1)).toEqual({
        from: "building",
        to: "building",
        reason: "read src/bump.ts 5 times",
      })
      expect(repeated.context.units["T1.2"]?.attempts).toBe(2)
    }),
  )

  it.live("logs no move of a scenario into or out of parked", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const parked = fold(plan, [
        f.runStarted(),
        ...trustLeaf(plan, f, "T1.1"),
        ...trustLeaf(plan, f, "T1.2"),
        ...trustLeaf(plan, f, "T1.3"),
        ...trustLeaf(plan, f, "T1.4"),
      ])
      expect(unitState(parked, "S13")).toBe("parked")
      expect(entries(parked, "S13")).toEqual([])
      const ready = step(plan, parked, f.outside("T8"))
      expect(unitState(ready, "S13")).toBe("ready")
      expect(entries(ready, "S13")).toEqual([])
      const back = step(plan, parked, f.stale("T1.4.c1"))
      expect(unitState(back, "S13")).toBe("waiting")
      expect(entries(back, "S13")).toEqual([])
    }),
  )

  it.live("stamps each entry with its fact's time, or the last entry's for a raised event", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const snapshot = fold(plan, [
        f.runStarted(),
        f.started("T1.1"),
        f.started("T1.3"),
        f.ready("T1.1"),
        f.proved("T1.1", [fail("T1.1.c1", "BUILD-1 exited 1")]),
        f.cancelled("user stop"),
      ])
      const times = snapshot.context.log.map((entry) => entry.at)
      expect(times).toEqual(times.toSorted((a, b) => a - b))
      const last = snapshot.context.log.at(-1)
      expect(last).toEqual({
        at: 6,
        unit: "run",
        from: "running",
        to: "budget_exhausted",
        reason: ["T1.1 budget exhausted", "T1 blocked by T1.1", "T1.2 blocked by T1.1", "user stop"].join("\n"),
      })
    }),
  )

  it.live("RM25 times and spans of the cascade plan, with a stale reopen restarting the clock", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const snapshot = fold(plan, [
        f.runStarted(), // 1
        ...trustLeaf(plan, f, "T1.3"), // 2..5
        f.stale("T1.3.c1"), // 6
        f.started("T1.1"), // 7
        f.ready("T1.1"), // 8
        f.proved("T1.1", [fail("T1.1.c1", "BUILD-1 exited 1")]), // 9
      ])
      const units = snapshot.context.units
      expect(units["T1.1"]?.startedAt).toBe(7)
      expect(units["T1.1"]?.endedAt).toBe(9)
      expect(units["T1.1"]?.spans).toEqual([
        { state: "waiting", from: 1, to: 7 },
        { state: "building", from: 7, to: 8 },
        { state: "proving", from: 8, to: 9 },
        { state: "budget_exhausted", from: 9, to: 9 },
      ])
      expect(units["T1.2"]?.startedAt).toBeUndefined()
      expect(units["T1.2"]?.endedAt).toBe(9)
      expect(units["T1.2"]?.spans).toEqual([
        { state: "waiting", from: 1, to: 9 },
        { state: "blocked", from: 9, to: 9 },
      ])
      // T1.3 was trusted at 5, then reopened at 6: a new clock, and no end.
      expect(units["T1.3"]?.startedAt).toBe(6)
      expect(units["T1.3"]?.endedAt).toBeUndefined()
      expect(units["T1.3"]?.spans?.map((span) => span.state)).toEqual([
        "waiting",
        "building",
        "proving",
        "verifying",
        "trusted",
        "proving",
      ])
      expect(units.run?.startedAt).toBe(1)
      expect(units.run?.endedAt).toBeUndefined()
      // Before the slice's run.started the run has neither time.
      expect(first(plan).context.units.run?.startedAt).toBeUndefined()
      expect(first(plan).context.units.run?.endedAt).toBeUndefined()
    }),
  )

  it.live("shows a retry as building, proving and verifying spans again", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const snapshot = fold(plan, [f.runStarted(), ...exhaustLeaf(f, "T1.2", "T1.2.c1", 2)])
      // Two failed proofs with a budget of 3: the task is building its third attempt.
      expect(snapshot.context.units["T1.2"]?.spans?.map((span) => span.state)).toEqual([
        "waiting",
        "building",
        "proving",
        "building",
        "proving",
        "building",
      ])
      expect(snapshot.context.units["T1.2"]?.spans?.at(-1)?.to).toBeUndefined()
      // A rejected verdict sends the task from verifying back to building: verifying shows again on the next attempt.
      const own = obligationsOf(plan, "T1.2")
      const rejected = fold(plan, [
        f.runStarted(),
        f.started("T1.2"),
        f.ready("T1.2"),
        f.proved("T1.2", own.map(judge)),
        f.verified("T1.2", [reject(own[0] ?? "T1.2.c1", "the test proves another text")]),
        f.ready("T1.2"),
        f.proved("T1.2", own.map(judge)),
      ])
      expect(rejected.context.units["T1.2"]?.spans?.map((span) => span.state)).toEqual([
        "waiting",
        "building",
        "proving",
        "verifying",
        "building",
        "proving",
        "verifying",
      ])
    }),
  )

  it.live("SD-14 ends the run's history with running>done or running>cancelled, and sets its end time", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      const f = facts()
      const done = fold(plan, [
        f.runStarted(),
        ...trustLeaf(plan, f, "T1.1"),
        f.proved("T1", []),
        f.verified("T1", [trust("T1.e1")]),
        f.scenarioProved("S1", "passed"),
        f.scenarioVerified(trust("S1")),
      ])
      expect(entries(done, "run").map((entry) => `${entry.from}>${entry.to}`)).toEqual([
        "running>running",
        "running>done",
      ])
      expect(done.context.units.run?.endedAt).toBe(done.context.log.at(-1)?.at)
      expect(entries(done, "S1").map((entry) => `${entry.from}>${entry.to}`)).toEqual([
        "waiting>pending",
        "pending>trusted",
      ])
      const cancelled = fold(plan, [f.runStarted(), f.runResumed(), f.cancelled("user stop")])
      expect(entries(cancelled, "run")).toEqual([
        { from: "running", to: "running", reason: undefined },
        { from: "running", to: "running", reason: "resumed" },
        { from: "running", to: "running", reason: "user stop" },
        { from: "running", to: "cancelled", reason: "user stop" },
      ])
    }),
  )
})
