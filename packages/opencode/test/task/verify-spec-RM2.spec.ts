import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { readdirSync } from "node:fs"
import path from "path"
import { createMachine, initialTransition } from "@jambudipa/xstate-effect"
import { Blend } from "@/task/blend"
import type { Plan } from "@/task/core/model"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { facts, fold, loadPlan, observed, trustLeaf } from "./lib/machine"

// Scenario RM2 (spec task-harness-feedback, spine AD-1, AD-6; task T1.2): the generator refuses a machine it cannot
// fold safely.
//
//   Given a plan whose task ids give two equal explicit state ids
//   When the engine generates the run machine
//   Then the generation dies naming the repeated id
//   And every generated machine caps eventless iterations at 1000
//   And no generated machine for any plan has a delayed transition, an invoked actor, a spawned actor or a custom
//   action
//
// The plans come from the real loader (`Blend.load` and `TaskCommand.plan`, through `loadPlan`): every
// `task-formats/blend/*.spec` folder that loads, as a whole-spec plan and as a subtree plan for each of its tasks.
// The checks read both the plain-data config (`TaskMachine.config`) and the machine that xstate built from it
// (`TaskMachine.machine`, the machine the engine's `initial` and `apply` use).

const it = testEffect(NodeServices.layer)

const FORMATS = path.resolve(import.meta.dir, "../../../../task-formats/blend")

type Node = { readonly [key: string]: unknown }
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value)

// Every state node of a plain-data config, depth first (document order).
const configNodes = (value: unknown): ReadonlyArray<Node> => {
  if (!isNode(value)) return []
  return [value, ...Object.values(isNode(value.states) ? value.states : {}).flatMap(configNodes)]
}

// Every explicit id of a config, in document order, with repeats.
const explicitIds = (config: unknown) =>
  configNodes(config).flatMap((node) => (typeof node.id === "string" ? [node.id] : []))

const repeatedIds = (ids: ReadonlyArray<string>) => [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]

// Every key named `key` anywhere in a plain-data tree.
const keysNamed = (value: unknown, key: string): ReadonlyArray<unknown> => {
  if (Array.isArray(value)) return value.flatMap((item) => keysNamed(item, key))
  if (!isNode(value)) return []
  return Object.entries(value).flatMap(([name, item]) => [...(name === key ? [item] : []), ...keysNamed(item, key)])
}

// Every plan the loader gives for the format folders: the whole spec, and a subtree run of each task.
const allPlans = Effect.gen(function* () {
  const folders = readdirSync(FORMATS)
    .filter((name) => name.endsWith(".spec"))
    .toSorted()
  const plans: Array<{ readonly name: string; readonly plan: Plan }> = []
  for (const folder of folders) {
    const loaded = yield* Blend.load(path.join(FORMATS, folder))
    if (!loaded.spec) continue
    plans.push({ name: folder, plan: yield* loadPlan(folder) })
    for (const task of loaded.spec.tasks)
      plans.push({ name: `${folder}/${task.id}`, plan: yield* loadPlan(folder, task.id) })
  }
  return plans
})

// The defect a synchronous call dies with: its message, or a failure when it does not die.
const defectOf = (run: () => unknown) => {
  const exit = Effect.runSyncExit(Effect.sync(run))
  if (Exit.isSuccess(exit)) throw new Error("the call did not die")
  expect(Cause.hasDies(exit.cause)).toBe(true)
  expect(Cause.hasFails(exit.cause)).toBe(false)
  return String(Cause.squash(exit.cause))
}

// A state node of a built machine, read structurally.
interface Built {
  readonly id: string
  readonly states: Readonly<Record<string, Built>>
  readonly after: ReadonlyArray<unknown>
  readonly invoke: ReadonlyArray<unknown>
  readonly entry: ReadonlyArray<unknown>
  readonly exit: ReadonlyArray<unknown>
  readonly always: ReadonlyArray<{ readonly actions: Iterable<unknown> }>
  readonly transitions: Iterable<readonly [string, ReadonlyArray<{ readonly actions: Iterable<unknown> }>]>
}
const builtNodes = (node: Built): ReadonlyArray<Built> => [node, ...Object.values(node.states).flatMap(builtNodes)]

// Every action a built machine can run: entry, exit, and the actions of every event, eventless and done row.
const usedActions = (root: Built) =>
  builtNodes(root).flatMap((node) => [
    ...node.entry,
    ...node.exit,
    ...node.always.flatMap((row) => [...row.actions]),
    ...[...node.transitions].flatMap(([, rows]) => rows.flatMap((row) => [...row.actions])),
  ])

// The gaps of one action against the fold-safe rule: only `assign` and `raise` with no delay; a name must resolve to
// an implementation of the machine, and an implementation must be one of the two built-in action kinds.
const actionGaps = (implementations: Readonly<Record<string, unknown>>, action: unknown): ReadonlyArray<string> => {
  if (typeof action === "function") return [`a custom action function ${action.name || "(anonymous)"}`]
  if (!isNode(action) || typeof action.type !== "string") return [`an action that is not an object: ${String(action)}`]
  const resolved = action.type in implementations ? implementations[action.type] : action
  if (typeof resolved === "function") return [`${action.type}: a custom action function`]
  if (!isNode(resolved)) return [`${action.type}: no implementation`]
  if (resolved.type !== "xstate.assign" && resolved.type !== "xstate.raise")
    return [`${action.type}: an action of kind ${String(resolved.type)}`]
  if (resolved.type === "xstate.raise" && resolved.delay !== undefined) return [`${action.type}: a delayed raise`]
  return []
}

it.live("[RM2] a plan whose task ids give two equal explicit state ids makes the generation die naming the id", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("example-cascade.spec")
    const leaf = plan.tasks.find((task) => task.id === "T1.1")
    if (leaf === undefined) throw new Error("example-cascade.spec has no T1.1")
    // Given: a second task `T1_1` beside `T1.1`. A state id replaces `.` with `_`, so the two tasks give the same
    // explicit id for every work state.
    const clash: Plan = { ...plan, tasks: [...plan.tasks, { ...leaf, id: "T1_1", children: [], after: [] }] }
    for (const state of ["waiting", "ready", "building", "trusted", "budget_exhausted", "blocked"]) {
      expect(TaskMachine.stateId("T1.1", state)).toBe(`T1_1/${state}`)
      expect(TaskMachine.stateId("T1_1", state)).toBe(`T1_1/${state}`)
    }
    expect(repeatedIds(explicitIds(TaskMachine.config(plan)))).toEqual([])
    // Left to itself, the plain config keeps one `T1_1` region, the second task's: T1.1 would vanish without a word,
    // and the port builds that config without a complaint.
    const config = TaskMachine.config(clash)
    const regions = Object.keys(isNode(config.states.active.states) ? config.states.active.states : {})
    expect(regions.filter((region) => region === "T1_1")).toEqual(["T1_1"])
    const kept = configNodes(config).find((node) => node.id === "T1_1/waiting")
    expect(kept?.meta).toEqual({ unit: "T1_1", kind: "task", state: "waiting" })
    expect(() => createMachine(config, { actions: TaskMachine.ACTIONS, guards: TaskMachine.GUARDS })).not.toThrow()

    // When the engine generates the run machine: the generator and the engine's first snapshot both die (a defect,
    // not a typed failure), and the message names the repeated id and the two task ids that give it.
    const generated = defectOf(() => TaskMachine.machine(clash))
    expect(generated).toContain("duplicate unit T1_1: T1.1, T1_1")
    const engine = defectOf(() => TaskEngineXState.initial(clash))
    expect(engine).toContain("duplicate unit T1_1: T1.1, T1_1")
    // The real plan still generates: the refusal is the clash, not the plan.
    expect(TaskEngineXState.initial(plan).status).toBe("active")
  }),
)

it.live("[RM2] a task id that repeats an obligation's explicit state ids makes the generation die naming that id", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("example-cascade.spec")
    const leaf = plan.tasks.find((task) => task.id === "T1.2")
    if (leaf === undefined) throw new Error("example-cascade.spec has no T1.2")
    expect(plan.spec.obligations.map((item) => item.id)).toContain("T1.1.c1")
    // Given: a task `T1.1.c1`. Its unit key `T1_1_c1` repeats no other unit key, but its work states `trusted` and
    // `failed` have the explicit ids of the obligation T1.1.c1's states `trusted` and `failed`.
    const clash: Plan = { ...plan, tasks: [...plan.tasks, { ...leaf, id: "T1.1.c1", children: [], after: [] }] }
    const ids = explicitIds(TaskMachine.config(clash))
    const repeated = repeatedIds(ids)
    expect(repeated.toSorted()).toEqual(["T1_1_c1/failed", "T1_1_c1/trusted"])

    // When the engine generates the run machine: it dies naming the first repeated id in document order.
    const first = repeated[0]
    if (first === undefined) throw new Error("no repeated id")
    expect(defectOf(() => TaskMachine.machine(clash))).toContain(`duplicate state id ${first}`)
    expect(defectOf(() => TaskEngineXState.initial(clash))).toContain(`duplicate state id ${first}`)
  }),
)

it.live(
  "[RM2] every generated machine caps eventless iterations at 1000",
  () =>
    Effect.gen(function* () {
      const plans = yield* allPlans
      // Every plan the formats give, the three phase-1 plans among them, as whole-spec and subtree runs.
      const names = plans.map((each) => each.name)
      for (const name of ["release-notes.spec", "example-cascade.spec", "example-scenarios.spec"])
        expect(names).toContain(name)
      expect(names).toContain("release-notes.spec/T1.5")
      expect(plans.some((each) => each.plan.external.length > 0)).toBe(true)
      for (const { name, plan } of plans) {
        expect({ name, config: TaskMachine.config(plan).options.maxIterations }).toEqual({ name, config: 1000 })
        expect({ name, built: TaskMachine.machine(plan).options.maxIterations }).toEqual({ name, built: 1000 })
      }

      // The cap is in force: on each whole-spec plan, a copy of the generated config with one task's `waiting` and
      // `ready` bound by unguarded eventless rows loops, and the port stops it after 1000 microsteps with an `error`
      // snapshot. The copy keeps the generated options; it is built with `createMachine` directly, because the
      // generator's own checks refuse a loop like it.
      const loopOf = (plan: Plan, maxIterations?: number) => {
        const unit = TaskMachine.key(plan.tasks[0]?.id ?? "T1")
        const built = TaskMachine.mapStates(TaskMachine.config(plan), (node) => {
          if (node.id === `${unit}/waiting`) return { ...node, always: [{ target: "ready" }] }
          if (node.id === `${unit}/ready`) return { ...node, always: [{ target: "waiting" }] }
          return node
        })
        const options = maxIterations === undefined ? built.options : { maxIterations }
        const [snapshot] = Effect.runSync(
          initialTransition(
            createMachine({ ...built, options }, { actions: TaskMachine.ACTIONS, guards: TaskMachine.GUARDS }),
          ),
        )
        return snapshot
      }
      for (const { name, plan } of plans.filter((each) => each.plan.root === undefined)) {
        const looped = loopOf(plan)
        expect({ name, status: looped.status }).toEqual({ name, status: "error" })
        expect(String(looped.error)).toContain("Infinite loop detected")
        expect(String(looped.error)).toContain("more than 1000 microsteps")
      }
      // Control: the number in the port's message is the option in force, so "1000" above is the generated cap.
      const control = plans.find((each) => each.name === "example-cascade.spec")
      if (control === undefined) throw new Error("no example-cascade.spec plan")
      expect(String(loopOf(control.plan, 50).error)).toContain("more than 50 microsteps")
    }),
  120_000,
)

it.live(
  "[RM2] no generated machine for any plan has a delayed transition, an invoked actor, a spawned actor or a custom action",
  () =>
    Effect.gen(function* () {
      const plans = yield* allPlans
      expect(plans.length).toBeGreaterThan(3)
      for (const { name, plan } of plans) {
        // The plain-data config: no `after`, `invoke`, `spawn`, delay or actor key anywhere.
        const config = TaskMachine.config(plan)
        for (const key of ["after", "invoke", "spawn", "delay", "delays", "actors", "src"])
          expect({ name, key, found: keysNamed(config, key) }).toEqual({ name, key, found: [] })

        // The built machine: no delayed row and no invocation on any state node, no delayed event type, and only the
        // action and guard implementations (no actor logic, no delays).
        const machine = TaskMachine.machine(plan)
        const root: Built = machine.root
        const nodes = builtNodes(root)
        expect(nodes.length).toBeGreaterThan(10)
        const delayed = nodes.filter((node) => node.after.length > 0).map((node) => node.id)
        const invoked = nodes.filter((node) => node.invoke.length > 0).map((node) => node.id)
        expect({ name, delayed, invoked }).toEqual({ name, delayed: [], invoked: [] })
        const events = nodes.flatMap((node) => [...node.transitions].map(([type]) => type))
        expect({ name, after: events.filter((type) => type.startsWith("xstate.after")) }).toEqual({ name, after: [] })
        expect(Object.keys(machine.implementations).toSorted()).toEqual(["actions", "guards"])

        // Every action the machine can run is an `assign` or an undelayed `raise`, by name or built in; no custom
        // action function, no spawn or send action.
        const implementations: Readonly<Record<string, unknown>> = machine.implementations.actions ?? {}
        const used = usedActions(root)
        expect(used.length).toBeGreaterThan(0)
        const gaps = [
          ...used.flatMap((action) => actionGaps(implementations, action)),
          ...Object.values(implementations).flatMap((action) => actionGaps({}, action)),
        ]
        expect({ name, gaps }).toEqual({ name, gaps: [] })

        // No actor is spawned: the first snapshot holds no child actor.
        expect({ name, children: Object.keys(TaskEngineXState.initial(plan).children) }).toEqual({ name, children: [] })
      }

      // An `assign` could still spawn from inside its function: fold real runs of the release-notes plan, the observed
      // stuck run and a run of trusted leaves, and check that no snapshot along the way holds a child actor.
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const runs = [
        observed(plan),
        [f.runStarted(), ...trustLeaf(plan, f, "T1.1"), ...trustLeaf(plan, f, "T1.2"), f.cancelled("user stop")],
      ]
      for (const run of runs) {
        let snapshot = TaskEngineXState.initial(plan)
        for (const fact of run) {
          snapshot = TaskEngineXState.apply(plan, snapshot, fact)
          expect({ fact: fact.type, children: Object.keys(snapshot.children) }).toEqual({
            fact: fact.type,
            children: [],
          })
        }
      }
      expect(Object.keys(fold(plan, observed(plan)).children)).toEqual([])

      // Control: the scan names a custom action, a spawn action and a delayed raise when a machine has them.
      const custom = Object.assign(() => undefined, { type: "custom" })
      expect(actionGaps({}, () => undefined)).toEqual(["a custom action function (anonymous)"])
      expect(actionGaps({ custom }, { type: "custom" })).toEqual(["custom: a custom action function"])
      expect(actionGaps({ spawn: { type: "xstate.spawnChild" } }, { type: "spawn" })).toEqual([
        "spawn: an action of kind xstate.spawnChild",
      ])
      expect(actionGaps({ late: { type: "xstate.raise", delay: 5 } }, { type: "late" })).toEqual([
        "late: a delayed raise",
      ])
    }),
  120_000,
)
