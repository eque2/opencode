import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { and, createMachine, initialTransition, not, or, stateIn, transition } from "@jambudipa/xstate-effect"
import type { Fact, Plan } from "@/task/core/model"
import { TaskEngineXState } from "@/task/engine-xstate"
import { type RunContext, type RunEvent, TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, observed } from "./lib/machine"

// Scenario RM28 (spec task-harness-feedback, SD-16, T1.3 and T1.6): a machine error is a defect, never a frozen run.
//
//   Given a generated machine whose guard names a state id that does not exist, reachable only after task.started
//   When task.started is applied
//   Then apply dies with a defect that names the error
//   And apply never returns a snapshot whose status is error
//   And the generator's config scan refuses any stateIn id that names no state
//
// The machine is the generated config of the loaded release-notes plan (`TaskMachine.config`), copied with
// `TaskMachine.mapStates` so that a `building` state, which only task.started enters, has an eventless row guarded by
// `stateIn("#nowhere/at_all")`. The copy is built with the port's `createMachine` and the machine's own actions and
// guards: the generator's scan (`TaskMachine.fromConfig`, `check`) refuses it, which the last steps prove. The fold
// uses the engine's `applyTo`, the `apply` of a given machine; each step is compared with the port's own
// `transition`.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const UNKNOWN = "#nowhere/at_all"
const NAMED = "Child state node '#nowhere/at_all' does not exist on machine 'run'"

type Config = ReturnType<typeof TaskMachine.config>
type Edit = Parameters<typeof TaskMachine.mapStates>[1]
type Node = Parameters<Edit>[0]

// A copy of a plan's config with one state node changed.
const edited = (plan: Plan, id: string, change: (node: Node) => Node): Config =>
  TaskMachine.mapStates(TaskMachine.config(plan), (node) => (node.id === id ? change(node) : node))

/** A guard on a state id, typed for the run machine's rows. */
const named = (id: string) => stateIn<RunContext, RunEvent>(id)

/** A node's eventless rows as a list. */
const alwaysOf = (node: Node) => {
  const rows = node.always
  if (rows === undefined) return []
  return Array.isArray(rows) ? rows : [rows]
}

// The copy with an eventless row on `id` whose guard names a state id that does not exist.
const brokenAt = (plan: Plan, id: string) =>
  edited(plan, id, (node) => ({ ...node, always: [{ guard: named(UNKNOWN), target: "blocked" }] }))

// A machine of a config built by the port alone, with no generator check.
const unchecked = (config: Config) =>
  createMachine(config, { actions: TaskMachine.ACTIONS, guards: TaskMachine.GUARDS })

type Machine = ReturnType<typeof unchecked>
type Snapshot = ReturnType<typeof engine.initial>

/** What applying a fact gives: a returned snapshot, or the error it died with. */
const attempt = (machine: Machine, snapshot: Snapshot, fact: Fact) => {
  const exit = Effect.runSyncExit(Effect.suspend(() => Effect.succeed(engine.applyTo(machine, snapshot, fact))))
  return exit
}

it.live("[RM28] the broken machine is the generated one until task.started enters the broken state", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const real = TaskMachine.machine(plan)
    const broken = unchecked(brokenAt(plan, "T1_4/building"))
    const [first] = Effect.runSync(initialTransition(broken))
    const [want] = Effect.runSync(initialTransition(real))
    expect(first.status).toBe("active")
    expect(first.value).toEqual(want.value)
    // Every fact before T1.4's task.started folds as on the generated machine, and the run stays active.
    const list = observed(plan, facts())
    const index = list.findIndex((fact) => fact.type === "task.started" && fact.task === "T1.4")
    expect(index).toBeGreaterThan(0)
    const folded = list.slice(0, index).reduce((snapshot, fact) => engine.applyTo(broken, snapshot, fact), first)
    const reference = list
      .slice(0, index)
      .reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), engine.initial(plan))
    expect(folded.status).toBe("active")
    expect(folded.value).toEqual(reference.value)
    expect(folded.context.log).toEqual(reference.context.log)
  }),
)

it.live("[RM28] when task.started enters the broken state, apply dies with a defect that names the error", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    const broken = unchecked(brokenAt(plan, "T1_1/building"))
    const [first] = Effect.runSync(initialTransition(broken))
    const started = f.started("T1.1")
    // The port itself fails on this fact: its guard names no state.
    const port = Effect.runSyncExit(transition(broken, first, started))
    expect(Exit.isFailure(port)).toBe(true)
    // apply does not return: it throws the port's error, which names the unknown state id.
    expect(() => engine.applyTo(broken, first, started)).toThrow(NAMED)
    // In an Effect it is a defect (a die), never a typed failure, and its error names the error.
    const exit = attempt(broken, first, started)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(Cause.hasDies(exit.cause)).toBe(true)
    expect(Cause.hasFails(exit.cause)).toBe(false)
    expect(String(Cause.squash(exit.cause))).toContain(NAMED)
    // After run.started the same fact dies the same way.
    const running = engine.applyTo(broken, first, f.runStarted())
    expect(running.status).toBe("active")
    expect(() => engine.applyTo(broken, running, f.started("T1.1"))).toThrow(NAMED)
  }),
)

it.live("[RM28] apply never returns a snapshot whose status is error", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const broken = unchecked(brokenAt(plan, "T1_4/building"))
    const [first] = Effect.runSync(initialTransition(broken))
    // Each observed fact, step by step: apply returns the port's snapshot when the port gives an active or done one,
    // and dies where the port fails or gives an error snapshot. No returned snapshot has status error.
    const outcomes: Array<string> = []
    let snapshot: Snapshot = first
    for (const fact of observed(plan, facts())) {
      const port = Effect.runSyncExit(transition(broken, snapshot, fact))
      const exit = attempt(broken, snapshot, fact)
      if (Exit.isSuccess(port) && port.value[0].status !== "error") {
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isFailure(exit)) break
        expect(exit.value.status).not.toBe("error")
        expect(exit.value.value).toEqual(port.value[0].value)
        snapshot = exit.value
        outcomes.push(exit.value.status)
        continue
      }
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) break
      expect(Cause.hasDies(exit.cause)).toBe(true)
      outcomes.push(`died on ${fact.type} ${"task" in fact ? fact.task : ""}`)
      break
    }
    expect(outcomes.at(-1)).toBe("died on task.started T1.4")
    expect(outcomes.slice(0, -1).every((status) => status === "active")).toBe(true)
    // An error snapshot (a broken guard in the first macrostep) is never passed through either: apply dies on it.
    const early = unchecked(brokenAt(plan, "T1_1/waiting"))
    const [error] = Effect.runSync(initialTransition(early))
    expect(error.status).toBe("error")
    const f = facts()
    for (const fact of [f.runStarted(), f.started("T1.1"), f.cancelled("user stop")]) {
      const exit = attempt(early, error, fact)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(String(Cause.squash(exit.cause))).toContain("the run machine has status error")
        expect(String(Cause.squash(exit.cause))).toContain(NAMED)
      }
    }
    // The real machine folds the observed facts to an active snapshot: no error status there.
    const real = observed(plan, facts()).reduce((each, fact) => engine.apply(plan, each, fact), engine.initial(plan))
    expect(real.status).toBe("active")
  }),
)

// Every state id of a config, and every stateIn id anywhere in it (a scan of the plain data, not the generator's).
const scan = (config: unknown) => {
  const ids = new Set<string>()
  const named = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (typeof value !== "object" || value === null) return
    const record: Record<string, unknown> = { ...value }
    if (typeof record.id === "string" && typeof record.meta === "object") ids.add(record.id)
    const params = record.params
    if (record.type === "xstate.stateIn" && typeof params === "object" && params !== null) {
      const state: Record<string, unknown> = { ...params }
      if (typeof state.stateValue === "string") named.add(state.stateValue.replace(/^#/, ""))
    }
    Object.values(record).forEach(visit)
  }
  visit(config)
  return { ids, named }
}

it.live("[RM28] the generator's config scan refuses a stateIn id that names no state, plain or nested in a guard", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const refusal = (id: string) => `a guard names the unknown state id ${id}`
    // A node's rows rewritten as plain data so that its guards name another state id (the scan reads plain data).
    const renamed = (node: Node, from: string, to: string): Node =>
      JSON.parse(JSON.stringify(node).replaceAll(`"#${from}"`, `"#${to}"`))
    const cases: ReadonlyArray<readonly [string, Config]> = [
      // An eventless row that only task.started reaches: the scenario's machine.
      ["nowhere/at_all", brokenAt(plan, "T1_4/building")],
      // A known unit with a state it does not have.
      [
        "T1_4/exploded",
        edited(plan, "T1_5/waiting", (node) => ({
          ...node,
          always: [{ guard: named("#T1_4/exploded"), target: "blocked" }, ...alwaysOf(node)],
        })),
      ],
      // A unit id with its dots kept: the port splits a `#id` on `.`, so it names no state.
      [
        "T1.4/blocked",
        edited(plan, "T1_5/waiting", (node) => ({
          ...node,
          always: [{ guard: named("#T1.4/blocked"), target: "blocked" }, ...alwaysOf(node)],
        })),
      ],
      // Inside an and() of a task's eventless row.
      [
        "T9/dead",
        edited(plan, "T1_5/waiting", (node) => ({
          ...node,
          always: [{ guard: and([named("#T9/dead"), named("#T1_3/trusted")]), target: "blocked" }, ...alwaysOf(node)],
        })),
      ],
      // Inside a not() inside an or() of the outcome region's eventless row.
      [
        "S99/trusted",
        edited(plan, "run/running", (node) => ({
          ...node,
          always: [
            { guard: or([not(named("#S99/trusted")), named("#T1_1/trusted")]), target: "waiting" },
            ...alwaysOf(node),
          ],
        })),
      ],
      // Inside the and() of an obligation's event rows: the proof rows of T1.1.c1 read T1.1 proving.
      ["T1_1/provng", edited(plan, "T1_1_c1/pending", (node) => renamed(node, "T1_1/proving", "T1_1/provng"))],
    ]
    for (const [id, copy] of cases) {
      // The plain-data scan sees the unknown id in the copy.
      const found = scan(copy)
      expect(found.ids.has(id)).toBe(false)
      expect(found.named.has(id)).toBe(true)
      // The generator refuses the copy before any run: no machine, no snapshot.
      expect(() => TaskMachine.check(plan, copy)).toThrow(refusal(id))
      expect(() => TaskMachine.fromConfig(plan, copy)).toThrow(refusal(id))
    }
  }),
)

it.live(
  "[RM28] every guard of every real plan's machine names a state, and the scan passes them",
  () =>
    Effect.gen(function* () {
      for (const [name, root] of [
        ["release-notes.spec", undefined],
        ["release-notes.spec", "T1.5"],
        ["example-cascade.spec", undefined],
        ["example-scenarios.spec", undefined],
        ["example-outside-run.spec", undefined],
        ["example-outside-run.spec", "T1.2"],
        ["provider-ordering-admin.spec", undefined],
      ] as const) {
        const plan = yield* loadPlan(name, root)
        const config = TaskMachine.config(plan)
        const found = scan(config)
        expect(found.named.size).toBeGreaterThan(0)
        expect({ name, root, unknown: [...found.named].filter((id) => !found.ids.has(id)) }).toEqual({
          name,
          root,
          unknown: [],
        })
        expect(() => TaskMachine.check(plan, config)).not.toThrow()
        expect(Effect.runSync(initialTransition(TaskMachine.machine(plan)))[0].status).toBe("active")
      }
    }),
  60_000,
)
