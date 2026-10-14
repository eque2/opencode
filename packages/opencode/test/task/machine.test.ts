import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Option } from "effect"
import path from "path"
import { initialTransition } from "@jambudipa/xstate-effect"
import { Blend } from "@/task/blend"
import { TaskCommand } from "@/task/core/command"
import type { Plan } from "@/task/core/model"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"

// The run machine generator (spine AD-1 to AD-5): one machine per plan, generated as plain data.

const it = testEffect(NodeServices.layer)

const formatDir = path.resolve(import.meta.dir, "../../../../task-formats/blend")

// The plan of `/task task-formats/blend/<name>`, or of the task folder `root` inside it.
const loadPlan = (name: string, root?: string) =>
  Effect.gen(function* () {
    const loaded = yield* Blend.load(path.join(formatDir, name))
    expect(loaded.failures).toEqual([])
    if (!loaded.spec) return yield* Effect.die(`${name} did not load`)
    const specPath = `task-formats/blend/${name}`
    return TaskCommand.plan({ spec: loaded.spec, specPath, path: specPath, root: Option.fromNullishOr(root) })
  })

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
const walk = (node: Node, at: ReadonlyArray<string> = []): Array<{ readonly path: ReadonlyArray<string>; readonly node: Node }> => {
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
      expect(child(region(config, "S2"), "states", "ready", "meta")).toEqual({ unit: "S2", kind: "scenario", state: "pending" })
      expect(child(region(config, "S2"), "states", "parked", "meta")).toEqual({ unit: "S2", kind: "scenario", state: "waiting" })
      expect(child(config, "states", "outcome", "states", "done", "meta")).toEqual({ unit: "run", kind: "run", state: "done" })

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
      for (const action of Object.values(TaskMachine.ACTIONS)) expect(["xstate.assign", "xstate.raise"]).toContain(action.type)
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
