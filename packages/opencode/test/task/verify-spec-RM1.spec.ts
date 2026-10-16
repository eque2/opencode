import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import type { Plan } from "@/task/core/model"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { loadPlan } from "./lib/machine"

// Scenario RM1 (spec task-harness-feedback, spine AD-1, AD-2, AD-13): one machine is generated for each plan with a
// parallel region for every unit.
//
//   Given the release-notes plan
//   When the engine generates the run machine for it
//   Then its root is parallel with the regions active and outcome
//   And active holds one region for each task in plan order, then each scenario, then each outside precondition
//   And each task region is parallel with one evidence sub-region for each obligation and a work sub-region
//   And every unit state has an explicit id, a meta record of unit, kind and state, and only closed-vocabulary tags
//
// The plan comes from the real loader (`Blend.load` and `TaskCommand.plan`, through `loadPlan`). The assertions read
// the state nodes of the machine that xstate built (`TaskMachine.machine(plan).root`), the same machine whose
// snapshot the engine's `initial` returns. The expected names come from the spine, not from the generator's tables.

const it = testEffect(NodeServices.layer)

// A state node of the built machine, read structurally.
interface StateNode {
  readonly key: string
  readonly id: string
  readonly type: string
  readonly meta?: unknown
  readonly tags: ReadonlyArray<string>
  readonly states: Readonly<Record<string, StateNode>>
}

const RELEASE_NOTES = "release-notes.spec"

// AD-1: the unit kinds and the closed tag vocabulary.
const KINDS = ["task", "obligation", "scenario", "outside", "external", "run"]
const CLASS_TAGS = ["waiting", "active", "ended", "stopped", "blocked", "dead"]
const PHASE_TAGS = ["ready", "building", "proving", "verifying"]

// AD-2: the states of each unit kind. AD-13: the status-contract name of each state (meta `state`), where it differs.
const STATES: Readonly<Record<string, ReadonlyArray<string>>> = {
  task: [
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
    "cancelled",
    "blocked",
  ],
  obligation: ["pending", "passed", "failed", "trusted", "rejected", "stale"],
  scenario: ["waiting", "ready", "verifying", "trusted", "rejected", "failed", "cancelled", "blocked", "parked"],
  outside: ["untrusted", "trusted"],
  run: ["running", "waiting", "done", "failed", "needs_human", "budget_exhausted", "cancelled"],
}
const STATUS_NAME: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  task: { ready: "waiting", judging: "verifying" },
  scenario: { ready: "pending", verifying: "pending", parked: "waiting" },
}
const statusName = (kind: string, state: string) => STATUS_NAME[kind]?.[state] ?? state

const natural = new Intl.Collator(undefined, { numeric: true })
const key = (id: string) => id.replaceAll(".", "_")
const sorted = (ids: ReadonlyArray<string>) => ids.toSorted((a, b) => natural.compare(a, b))

const rootOf = (plan: Plan): StateNode => TaskMachine.machine(plan).root
const childOf = (node: StateNode, name: string): StateNode => {
  const found = node.states[name]
  if (found === undefined) throw new Error(`no state ${name} under ${node.id}`)
  return found
}
const keysOf = (node: StateNode) => Object.keys(node.states)
const nodesOf = (node: StateNode): ReadonlyArray<StateNode> => [node, ...Object.values(node.states).flatMap(nodesOf)]
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const metaOf = (node: StateNode) => {
  if (!isRecord(node.meta)) throw new Error(`state ${node.id} has no meta record`)
  return node.meta
}
const obligationsOf = (plan: Plan, task: string) =>
  plan.spec.obligations.filter((obligation) => obligation.task === task).map((obligation) => obligation.id)

// Every unit state with the unit and kind its place in the tree gives it: the expectation each node is checked against.
const unitStatesOf = (plan: Plan, root: StateNode) => {
  const active = childOf(root, "active")
  const states = (region: StateNode, unit: string, kind: string) =>
    Object.values(region.states).map((node) => ({ node, unit, kind }))
  return [
    ...plan.tasks.flatMap((task) => {
      const region = childOf(active, key(task.id))
      const obligations = obligationsOf(plan, task.id)
      const evidence = obligations.length === 0 ? undefined : childOf(region, "evidence")
      return [
        ...obligations.flatMap((id) =>
          evidence === undefined ? [] : states(childOf(evidence, key(id)), id, "obligation"),
        ),
        ...states(childOf(region, "work"), task.id, "task"),
      ]
    }),
    ...plan.scenarios.flatMap((scenario) => states(childOf(active, key(scenario.id)), scenario.id, "scenario")),
    ...Object.keys(plan.spec.outside).flatMap((id) => states(childOf(active, key(id)), id, "outside")),
    ...states(childOf(root, "outcome"), "run", "run"),
  ]
}

// Every gap of the unit states of a machine: an id that is not explicit or repeats, a meta record that is not exactly
// { unit, kind, state } with the status-contract name, a tag outside the closed vocabulary, a unit state with no class
// tag of its own, or a tag on a node that is not a unit state. Sorted, so a list of gaps compares as one value.
const unitStateGaps = (plan: Plan, root: StateNode): ReadonlyArray<string> => {
  const units = unitStatesOf(plan, root)
  const dependants = new Set([...plan.tasks.map((task) => task.id), ...plan.scenarios.map((scenario) => scenario.id)])
  const seen = new Set<string>()
  const gaps = units.flatMap(({ node, unit, kind }) => {
    const found: Array<string> = []
    // An explicit id `<unit with . as _>/<state>`, not the port's dotted path id, unique in the machine.
    const explicit = `${key(unit)}/${node.key}`
    if (node.id !== explicit || !/^[A-Za-z0-9_]+\/[a-z_]+$/.test(node.id))
      found.push(`${node.id}: not the explicit id ${explicit}`)
    if (seen.has(node.id)) found.push(`${node.id}: the id repeats`)
    seen.add(node.id)
    // A meta record of exactly unit, kind and state, from the closed kinds; state is the status-contract name.
    const want = { unit, kind, state: statusName(kind, node.key) }
    const meta = isRecord(node.meta) ? node.meta : {}
    const exact =
      Object.keys(meta).toSorted().join(",") === "kind,state,unit" &&
      KINDS.includes(String(meta.kind)) &&
      meta.unit === want.unit &&
      meta.kind === want.kind &&
      meta.state === want.state
    if (!exact) found.push(`${node.id}: meta ${JSON.stringify(node.meta)}, expected ${JSON.stringify(want)}`)
    // Tags: `<unit>:<class or phase tag>`, or `<dependant>:waits:<unit>` for a task or scenario that waits on it.
    if (!node.tags.some((tag) => CLASS_TAGS.some((name) => tag === `${unit}:${name}`)))
      found.push(`${node.id}: no class tag of ${unit}`)
    const waits = `:waits:${unit}`
    for (const tag of node.tags) {
      const own = [...CLASS_TAGS, ...PHASE_TAGS].some((name) => tag === `${unit}:${name}`)
      const dependant = tag.endsWith(waits) ? tag.slice(0, -waits.length) : undefined
      const waitsTag = dependant !== undefined && dependant !== unit && dependants.has(dependant)
      if (!own && !waitsTag) found.push(`${node.id}: tag ${tag} is outside the closed vocabulary`)
    }
    return found
  })
  const unitNodes = new Set(units.map((each) => each.node))
  const strays = nodesOf(root)
    .filter((node) => !unitNodes.has(node) && node.tags.length > 0)
    .map((node) => `${node.id}: a node that is not a unit state carries the tags ${node.tags.join(", ")}`)
  return [...gaps, ...strays].toSorted()
}

it.live(
  "[RM1] the release-notes plan loads, and the engine's first snapshot comes from its one generated machine",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan(RELEASE_NOTES)
      // Given the release-notes plan: six tasks, thirteen scenarios, two outside preconditions, no external task.
      expect(plan.tasks.map((task) => task.id)).toEqual(["T1", "T1.1", "T1.2", "T1.3", "T1.4", "T1.5"])
      expect(sorted(plan.scenarios.map((scenario) => scenario.id))).toEqual(
        Array.from({ length: 13 }, (_, index) => `S${index + 1}`),
      )
      expect(Object.keys(plan.spec.outside).toSorted()).toEqual(["T8", "T9"])
      expect(plan.external).toEqual([])

      // When the engine generates the run machine: one machine per plan, and the engine's snapshot is made of its nodes.
      const machine = TaskMachine.machine(plan)
      expect(TaskMachine.machine(plan)).toBe(machine)
      const snapshot = TaskEngineXState.initial(plan)
      expect(snapshot.status).toBe("active")
      const nodes = new Set<unknown>(nodesOf(machine.root))
      expect(snapshot._nodes.length).toBeGreaterThan(0)
      for (const node of snapshot._nodes) expect(nodes.has(node)).toBe(true)

      // The exported plain-data config is what the machine was built from: the same explicit ids on its state nodes.
      const configNodes = (node: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> => {
        if (!isRecord(node)) return []
        const children = isRecord(node.states) ? Object.values(node.states) : []
        return [node, ...children.flatMap(configNodes)]
      }
      const configIds = configNodes(TaskMachine.config(plan))
        .filter((node) => node.meta !== undefined)
        .map((node) => String(node.id))
        .toSorted()
      const builtIds = nodesOf(machine.root)
        .filter((node) => node.meta !== undefined)
        .map((node) => node.id)
        .toSorted()
      expect(builtIds.length).toBeGreaterThan(0)
      expect(configIds).toEqual(builtIds)
    }),
)

it.live("[RM1] the root is parallel with exactly the regions active and outcome", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan(RELEASE_NOTES)
    const root = rootOf(plan)
    expect(root.type).toBe("parallel")
    expect(keysOf(root)).toEqual(["active", "outcome"])
    expect(childOf(root, "active").type).toBe("parallel")
    // `outcome` is one region of run states (AD-4), not a parallel state.
    const outcome = childOf(root, "outcome")
    expect(outcome.type).toBe("compound")
    expect(keysOf(outcome).toSorted()).toEqual(STATES.run.toSorted())
    for (const state of Object.values(outcome.states)) expect(metaOf(state).kind).toBe("run")
  }),
)

it.live(
  "[RM1] active holds one region for each task in plan order, then each scenario, then each outside precondition",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan(RELEASE_NOTES)
      const active = childOf(rootOf(plan), "active")
      const tasks = plan.tasks.map((task) => key(task.id))
      const scenarios = sorted(plan.scenarios.map((scenario) => scenario.id)).map(key)
      const outside = sorted(Object.keys(plan.spec.outside)).map(key)
      expect(keysOf(active)).toEqual([...tasks, ...scenarios, ...outside])
      // The same order, written out: tasks in plan order, scenarios in natural order (S2 before S10), then T8, T9.
      expect(keysOf(active)).toEqual([
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
      expect(keysOf(active).indexOf("S2")).toBeLessThan(keysOf(active).indexOf("S10"))

      // Each region holds the unit its key names, of the right kind.
      const kindOf = (region: StateNode) => {
        const work = region.states.work
        const first = Object.values((work ?? region).states)[0]
        if (first === undefined) throw new Error(`region ${region.key} has no state`)
        return { unit: metaOf(first).unit, kind: metaOf(first).kind }
      }
      for (const task of plan.tasks)
        expect(kindOf(childOf(active, key(task.id)))).toEqual({ unit: task.id, kind: "task" })
      for (const scenario of plan.scenarios)
        expect(kindOf(childOf(active, key(scenario.id)))).toEqual({ unit: scenario.id, kind: "scenario" })
      for (const id of Object.keys(plan.spec.outside))
        expect(kindOf(childOf(active, key(id)))).toEqual({ unit: id, kind: "outside" })
    }),
)

it.live(
  "[RM1] each task region is parallel with one evidence sub-region for each obligation and a work sub-region",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan(RELEASE_NOTES)
      const active = childOf(rootOf(plan), "active")
      // T1.4's obligations, as the spec names them: c1 to c8, p1, f1, f2.
      expect(obligationsOf(plan, "T1.4")).toEqual([
        ...Array.from({ length: 8 }, (_, index) => `T1.4.c${index + 1}`),
        "T1.4.p1",
        "T1.4.f1",
        "T1.4.f2",
      ])
      let checked = 0
      for (const task of plan.tasks) {
        const region = childOf(active, key(task.id))
        const obligations = obligationsOf(plan, task.id)
        expect(obligations.length).toBeGreaterThan(0)
        expect(region.type).toBe("parallel")
        expect(keysOf(region)).toEqual(["evidence", "work"])

        const evidence = childOf(region, "evidence")
        expect(evidence.type).toBe("parallel")
        expect(keysOf(evidence)).toEqual(obligations.map(key))
        for (const id of obligations) {
          const obligation = childOf(evidence, key(id))
          expect(keysOf(obligation).toSorted()).toEqual(STATES.obligation.toSorted())
          for (const state of Object.values(obligation.states))
            expect([metaOf(state).unit, metaOf(state).kind]).toEqual([id, "obligation"])
          checked += 1
        }

        const work = childOf(region, "work")
        expect(work.type).toBe("compound")
        expect(keysOf(work).toSorted()).toEqual(STATES.task.toSorted())
        for (const state of Object.values(work.states))
          expect([metaOf(state).unit, metaOf(state).kind]).toEqual([task.id, "task"])
      }
      // Every obligation of every plan task has its sub-region; none is left out.
      expect(checked).toBe(
        plan.spec.obligations.filter((item) => plan.tasks.some((task) => task.id === item.task)).length,
      )
    }),
)

it.live(
  "[RM1] every unit state has an explicit id, a meta record of unit, kind and state, and only closed-vocabulary tags",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan(RELEASE_NOTES)
      const machine = TaskMachine.machine(plan)
      const root: StateNode = machine.root
      const units = unitStatesOf(plan, root)

      // Every leaf of the tree is a unit state, and the count is the AD-2 state list of each unit.
      const leaves = nodesOf(root).filter((node) => keysOf(node).length === 0)
      const obligations = plan.tasks.reduce((sum, task) => sum + obligationsOf(plan, task.id).length, 0)
      const expected =
        plan.tasks.length * STATES.task.length +
        obligations * STATES.obligation.length +
        plan.scenarios.length * STATES.scenario.length +
        Object.keys(plan.spec.outside).length * STATES.outside.length +
        STATES.run.length
      expect(units.length).toBe(expected)
      const unitNodes = new Set(units.map((unit) => unit.node))
      expect(unitNodes.size).toBe(expected)
      expect(leaves.length).toBe(expected)
      for (const leaf of leaves) expect(unitNodes.has(leaf)).toBe(true)

      // Explicit ids, meta records and closed-vocabulary tags: no gap on any unit state.
      expect(unitStateGaps(plan, root)).toEqual([])
      // Each explicit id names its node in the machine (the port resolves `#<id>` by it).
      for (const { node } of units) {
        const found: StateNode = yield* machine.getStateNodeById(node.id)
        expect(found).toBe(node)
      }

      // Negative control: the same checks name each gap in a machine built from an edited copy of the config.
      const broken = TaskMachine.fromConfig(
        plan,
        TaskMachine.mapStates(TaskMachine.config(plan), (node) => {
          if (node.id === "T1_4/waiting") return { ...node, tags: [[node.tags ?? []].flat(), "T1.4:bogus"].flat() }
          if (node.id === "S2/ready") return { ...node, meta: { unit: "S2", kind: "scenario", state: "ready" } }
          if (node.id === "T9/untrusted") return { ...node, tags: ["T9:waits:T42"] }
          return node
        }),
      )
      expect(unitStateGaps(plan, broken.root)).toEqual([
        'S2/ready: meta {"unit":"S2","kind":"scenario","state":"ready"}, expected {"unit":"S2","kind":"scenario","state":"pending"}',
        "T1_4/waiting: tag T1.4:bogus is outside the closed vocabulary",
        "T9/untrusted: no class tag of T9",
        "T9/untrusted: tag T9:waits:T42 is outside the closed vocabulary",
      ])

      // The engine's live snapshot shows only those tags.
      const everyTag = new Set(units.flatMap(({ node }) => node.tags))
      const snapshot = TaskEngineXState.initial(plan)
      expect(snapshot.tags.length).toBeGreaterThan(0)
      for (const tag of snapshot.tags) expect(everyTag.has(tag)).toBe(true)
    }),
)
