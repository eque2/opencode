import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Option } from "effect"
import path from "path"
import { createMachine, initialTransition } from "@jambudipa/xstate-effect"
import { Blend } from "@/task/blend"
import { TaskCommand } from "@/task/core/command"
import type { Fact, Plan } from "@/task/core/model"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { TaskAlphabet } from "@/task/engine-xstate/alphabet"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { exhaustLeaf, facts, loadPlan, observed, trustLeaf, unitState } from "./lib/machine"

// Scenario RM29 (spec task-harness-feedback, owner ruling 4, T1.3 and T1.10): a gap in the generated rows fails the
// structural totality check before any run.
//
//   Given a copy of the release-notes machine config with the row that blocks T1.5 on T1.4 budget exhausted removed
//   When the generator's totality check scans the copy
//   Then it fails with an error that names T1.5, its waiting state and the uncovered outcome T1.4 budget exhausted
//   And the scan of every real plan passes: each non-final unit state has a row for every final outcome of what it
//     waits on
//   And no non-final state lacks a way out except a wait on an untrusted outside or external region, and the
//     outcome can settle once every region is final
//
// The config is `TaskMachine.config` of the plan loaded by the real loader (`Blend.load`, then `TaskCommand.plan`),
// copied with `TaskMachine.mapStates`. The check is the generator's own: `TaskMachine.check` and `fromConfig`, which
// `machine(plan)` runs before every run and every walk. "Every real plan" is each `task-formats/blend` folder that
// the loader accepts, whole and as each of its task subtrees. Besides the scan, the test reads the plain-data rows of
// each real config, and walks the real machines with seeded random facts (the progress alphabet of the graph proof,
// scenario failures and stops) through the engine's `apply`.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const FORMATS = path.resolve(import.meta.dir, "../../../../task-formats/blend")
const GAP = "totality: T1.5 waiting has no row for T1.4 budget_exhausted"

// The final states of each unit kind (AD-2), and the states of a task dependency that block a dependant (AD-3).
const TASK_FINAL = ["trusted", "needs_human", "budget_exhausted", "failed", "blocked", "cancelled"]
const SCENARIO_FINAL = ["parked", "trusted", "rejected", "failed", "blocked", "cancelled"]
const BLOCKING = ["needs_human", "budget_exhausted", "failed", "blocked", "cancelled"]

type Config = ReturnType<typeof TaskMachine.config>
type Node = Parameters<Parameters<typeof TaskMachine.mapStates>[1]>[0]
type Plain = { readonly [key: string]: unknown }
const isPlain = (value: unknown): value is Plain => typeof value === "object" && value !== null && !Array.isArray(value)
const listOf = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : value === undefined ? [] : [value]
const child = (value: unknown, ...keys: ReadonlyArray<string>): Plain =>
  keys.reduce(
    (current: Plain, name): Plain => {
      const states = isPlain(current.states) ? current.states : {}
      const next = states[name]
      return isPlain(next) ? next : {}
    },
    isPlain(value) ? value : {},
  )
const alwaysOf = (node: unknown) => listOf(isPlain(node) ? node.always : undefined).filter(isPlain)
const paramsOf = (value: unknown): Plain => (isPlain(value) && isPlain(value.params) ? value.params : {})

// Every stateIn id a guard names, read from the plain data.
const stateIds = (guard: unknown): ReadonlyArray<string> => {
  if (!isPlain(guard)) return []
  const params = paramsOf(guard)
  if (guard.type === "xstate.stateIn") return [String(params.stateValue).replace(/^#/, "")]
  return [...listOf(params.guards), ...listOf(params.guard)].flatMap(stateIds)
}

/** Every plan of a folder that loads: the whole spec, and each task's subtree. */
const realPlans = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const names = (yield* fs.readDirectory(FORMATS)).filter((name) => name.endsWith(".spec")).toSorted()
  const plans: Array<{ readonly name: string; readonly root?: string; readonly plan: Plan }> = []
  for (const name of names) {
    const loaded = yield* Blend.load(path.join(FORMATS, name))
    if (!loaded.spec) continue
    const spec = loaded.spec
    const specPath = `task-formats/blend/${name}`
    plans.push({ name, plan: TaskCommand.plan({ spec, specPath, path: specPath, root: Option.none() }) })
    for (const task of spec.tasks)
      plans.push({
        name,
        root: task.id,
        plan: TaskCommand.plan({ spec, specPath, path: specPath, root: Option.some(task.id) }),
      })
  }
  return plans
})

// The release-notes config with T1.5 waiting's row for T1.4 budget_exhausted removed, and how many rows it removed.
const withoutGap = (plan: Plan) => {
  const config = TaskMachine.config(plan)
  const before = alwaysOf(child(config, "active", "T1_5", "work", "waiting"))
  const copy = TaskMachine.mapStates(config, (node) =>
    node.id === "T1_5/waiting"
      ? {
          ...node,
          always: alwaysOf(node).filter((row) => stateIds(row.guard).join() !== "T1_4/budget_exhausted"),
        }
      : node,
  )
  const after = alwaysOf(child(copy, "active", "T1_5", "work", "waiting"))
  return { config, copy, removed: before.length - after.length }
}

it.live(
  "[RM29] the totality check fails on the copy without T1.5's row for T1.4 budget exhausted, naming T1.5, waiting and the outcome",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const { config, copy, removed } = withoutGap(plan)
      expect(removed).toBe(1)
      // The removed row is the one that blocks T1.5 on T1.4 budget_exhausted.
      const original = alwaysOf(child(config, "active", "T1_5", "work", "waiting")).find(
        (row) => stateIds(row.guard).join() === "T1_4/budget_exhausted",
      )
      expect(original?.target).toBe("blocked")
      expect(listOf(original?.actions)).toContainEqual({
        type: "block",
        params: { unit: "T1.5", from: "waiting", id: "T1.4", state: "budget_exhausted" },
      })
      // The generator's check fails on the copy, before any machine or snapshot exists.
      expect(() => TaskMachine.check(plan, copy)).toThrow(GAP)
      expect(() => TaskMachine.fromConfig(plan, copy)).toThrow(GAP)
      const error = (() => {
        try {
          TaskMachine.check(plan, copy)
          return ""
        } catch (thrown) {
          return String(thrown)
        }
      })()
      for (const part of ["T1.5", "waiting", "T1.4 budget_exhausted"]) expect(error).toContain(part)
      // The original config passes the same check.
      expect(TaskMachine.check(plan, config)).toBe(config)
    }),
)

it.live("[RM29] without the check, the copy strands T1.5 on the observed facts: the stuck run the check prevents", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const { copy } = withoutGap(plan)
    const unchecked = createMachine(copy, { actions: TaskMachine.ACTIONS, guards: TaskMachine.GUARDS })
    const [first] = Effect.runSync(initialTransition(unchecked))
    const stuck = observed(plan, facts()).reduce((each, fact) => engine.applyTo(unchecked, each, fact), first)
    expect(unitState(stuck, "T1.4")).toBe("budget_exhausted")
    expect(unitState(stuck, "T1.5")).toBe("waiting")
    expect(engine.waitingOn(stuck, "T1.5")).toContain("T1.4")
    // The real machine blocks it in the same fold.
    const real = observed(plan, facts()).reduce((each, fact) => engine.apply(plan, each, fact), engine.initial(plan))
    expect(unitState(real, "T1.5")).toBe("blocked")
    expect(engine.blockedBy(real, "T1.5")).toEqual({ id: "T1.4", state: "budget_exhausted" })
  }),
)

// The plain-data rows of one unit state that waits on dependencies, checked against its dependencies.
const coverage = (plan: Plan, config: Config) => {
  const isTask = (id: string) => plan.tasks.some((task) => task.id === id)
  const units = [
    ...plan.tasks.map((task) => ({
      id: task.id,
      dependencies: [...task.afterEffective, ...task.children],
      node: (state: string) => child(config, "active", TaskMachine.key(task.id), "work", state),
    })),
    ...plan.scenarios.map((scenario) => ({
      id: scenario.id,
      dependencies: scenario.needs,
      node: (state: string) => child(config, "active", TaskMachine.key(scenario.id), state),
    })),
  ]
  return units.flatMap((unit) =>
    ["waiting", "ready"].flatMap((state) => {
      const rows = alwaysOf(unit.node(state))
      const gaps: Array<string> = []
      if (rows.length === 0 && state === "waiting") gaps.push(`${unit.id} ${state}: no rows`)
      // Every blocking end of every task dependency: a blocked row on that one state, naming it as the cause.
      for (const dependency of unit.dependencies.filter(isTask))
        for (const dead of BLOCKING) {
          const found = rows.some(
            (row) =>
              row.target === "blocked" &&
              stateIds(row.guard).join() === `${TaskMachine.key(dependency)}/${dead}` &&
              listOf(row.actions).some(
                (action) =>
                  isPlain(action) &&
                  action.type === "block" &&
                  paramsOf(action).id === dependency &&
                  paramsOf(action).state === dead,
              ),
          )
          if (!found) gaps.push(`${unit.id} ${state}: no row for ${dependency} ${dead}`)
        }
      // All trusted: the waiting state moves to ready.
      if (state === "waiting") {
        const trusted = unit.dependencies.map((id) => `${TaskMachine.key(id)}/trusted`).toSorted()
        const ready = rows.some(
          (row) => row.target === "ready" && stateIds(row.guard).toSorted().join() === trusted.join(),
        )
        if (!ready) gaps.push(`${unit.id} ${state}: no row to ready on all trusted`)
        // A scenario whose outside need is untrusted parks.
        const regions = unit.dependencies.filter((id) => !isTask(id))
        if (plan.scenarios.some((scenario) => scenario.id === unit.id) && regions.length > 0)
          if (!rows.some((row) => row.target === "parked")) gaps.push(`${unit.id} ${state}: no row to parked`)
      }
      return gaps
    }),
  )
}

it.live(
  "[RM29] the scan of every real plan passes: each waiting unit state has a row for every final outcome of what it waits on",
  () =>
    Effect.gen(function* () {
      const plans = yield* realPlans()
      // The five folders that load, whole and by subtree.
      expect([...new Set(plans.map((each) => each.name))]).toEqual([
        "example-cascade.spec",
        "example-outside-run.spec",
        "example-scenarios.spec",
        "provider-ordering-admin.spec",
        "release-notes.spec",
      ])
      for (const { name, root, plan } of plans) {
        const config = TaskMachine.config(plan)
        expect(() => TaskMachine.check(plan, config)).not.toThrow()
        expect(() => TaskMachine.machine(plan)).not.toThrow()
        expect({ name, root, gaps: coverage(plan, config) }).toEqual({ name, root, gaps: [] })
      }
      // The oracle finds the removed row of the copy.
      const notes = yield* loadPlan("release-notes.spec")
      expect(coverage(notes, withoutGap(notes).copy)).toContain("T1.5 waiting: no row for T1.4 budget_exhausted")
    }),
  120_000,
)

it.live("[RM29] on the real machine, T1.5 waiting is blocked by T1.4 for each way T1.4 ends other than trusted", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    // T1.1 to T1.3 trusted: T1.4 builds, and T1.5 waits on T1.4 and T9.
    const base = [
      f.runStarted(),
      ...trustLeaf(plan, f, "T1.1"),
      ...trustLeaf(plan, f, "T1.2"),
      ...trustLeaf(plan, f, "T1.3"),
    ]
    const ends: ReadonlyArray<readonly [string, ReadonlyArray<Fact>]> = [
      ["needs_human", [...base, f.started("T1.4"), f.needsHuman("T1.4", "spend cap reached")]],
      ["budget_exhausted", [...base, ...exhaustLeaf(f, "T1.4", "T1.4.c7")]],
      ["failed", [...base, f.started("T1.4"), f.failed("T1.4", "the builder session died")]],
      // T1.2 dies while T1.3 is trusted: T1.4 is blocked by T1.2, so T1.5 is blocked by T1.4 blocked.
      [
        "blocked",
        [
          f.runStarted(),
          ...trustLeaf(plan, f, "T1.1"),
          ...trustLeaf(plan, f, "T1.3"),
          f.started("T1.2"),
          f.failed("T1.2", "the builder session died"),
        ],
      ],
    ]
    for (const [end, list] of ends) {
      const snapshot = list.reduce((each, fact) => engine.apply(plan, each, fact), engine.initial(plan))
      expect({ end, T14: unitState(snapshot, "T1.4"), T15: unitState(snapshot, "T1.5") }).toEqual({
        end,
        T14: end,
        T15: "blocked",
      })
      expect(engine.blockedBy(snapshot, "T1.5")).toEqual({ id: "T1.4", state: end })
    }
  }),
)

it.live(
  "[RM29] the scan refuses a non-final state with no way out, and an outcome that cannot settle",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const config = TaskMachine.config(plan)
      const edit = (id: string, change: (node: Node) => Partial<Node>) =>
        TaskMachine.mapStates(config, (node) => (node.id === id ? { ...node, ...change(node) } : node))
      const cases: ReadonlyArray<readonly [string, Config]> = [
        ["totality: T1.4 building has no way out", edit("T1_4/building", () => ({ on: {}, always: [] }))],
        [
          "totality: run running has no settle row for T1 trusted",
          edit("run/running", (node) => ({ on: { ...node.on, "run.settled": [] } })),
        ],
        [
          "totality: run waiting has no settle row for T1 trusted",
          edit("run/waiting", (node) => ({ on: { ...node.on, "run.settled": [] } })),
        ],
        [
          "totality: S13 waiting has no row for T8 untrusted",
          edit("S13/waiting", (node) => ({ always: alwaysOf(node).filter((row) => row.target !== "parked") })),
        ],
      ]
      for (const [line, copy] of cases) expect(() => TaskMachine.fromConfig(plan, copy)).toThrow(line)
      // Every non-final task, scenario and outcome state of every real plan has a row out.
      for (const { name, root, plan: each } of yield* realPlans()) {
        const states: Array<Plain> = []
        const visit = (node: unknown): void => {
          if (!isPlain(node)) return
          states.push(node)
          Object.values(isPlain(node.states) ? node.states : {}).forEach(visit)
        }
        visit(TaskMachine.config(each))
        const closed = states
          .filter((node) => {
            const kind = isPlain(node.meta) ? node.meta.kind : undefined
            return (kind === "task" || kind === "scenario" || kind === "run") && node.type !== "final"
          })
          .filter((node) => {
            const on = isPlain(node.on) ? Object.values(node.on).flatMap(listOf) : []
            return on.length + alwaysOf(node).length === 0
          })
          .map((node) => String(node.id))
        expect({ name, root, closed }).toEqual({ name, root, closed: [] })
      }
    }),
  120_000,
)

// A seeded generator (mulberry32), so each walk is the same on every run.
const random = (seed: number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const shuffle = <A>(list: ReadonlyArray<A>, next: () => number): Array<A> =>
  list
    .map((item) => ({ item, at: next() }))
    .toSorted((a, b) => a.at - b.at)
    .map(({ item }) => item)

/** A fact that harms a unit: a failure, a death, a repetition, a failed proof or a rejected verdict. */
const harmful = (fact: Fact) =>
  fact.type === "task.failed" ||
  fact.type === "task.needs_human" ||
  fact.type === "task.repeated" ||
  (fact.type === "task.proved" && fact.results.some((result) => result.status === "failed")) ||
  (fact.type === "task.verified" && fact.verdicts.some((verdict) => verdict.verdict === "rejected")) ||
  (fact.type === "scenario.proved" && fact.status === "failed") ||
  (fact.type === "scenario.verified" && fact.verdict.verdict === "rejected")

// Whether a unit stands still only on an untrusted outside or external region: it waits, and each of its waits is
// such a region or a unit that has not ended and itself stands still that way. A wait on an ended unit (one that
// died, was blocked or was cancelled) is a stuck wait, never this.
const waitsOnRegion = (plan: Plan, snapshot: RunSnapshot, id: string, seen: ReadonlyArray<string> = []): boolean => {
  const needs = engine.waitingOn(snapshot, id)
  return (
    needs.length > 0 &&
    needs.every((need) => {
      if (seen.includes(need)) return false
      if (need in plan.spec.outside || plan.external.includes(need)) return unitState(snapshot, need) === "untrusted"
      const finals = plan.tasks.some((task) => task.id === need) ? TASK_FINAL : SCENARIO_FINAL
      return !finals.includes(unitState(snapshot, need)) && waitsOnRegion(plan, snapshot, need, [...seen, id])
    })
  )
}

it.live(
  "[RM29] on the real machines, a unit stands still only on an untrusted outside or external region, and the run settles once every region is final",
  () =>
    Effect.gen(function* () {
      const walked = [
        ["release-notes.spec", undefined],
        ["release-notes.spec", "T1.5"],
        ["example-cascade.spec", undefined],
        ["example-scenarios.spec", undefined],
        ["example-outside-run.spec", undefined],
        ["example-outside-run.spec", "T1.2"],
      ] as const
      const seen = { settled: 0, standstills: 0, steps: 0, outcomes: new Set<string>() }
      for (const [name, root] of walked) {
        const plan = yield* loadPlan(name, root)
        const units = [
          ...plan.tasks.map((task) => [task.id, TASK_FINAL] as const),
          ...plan.scenarios.map((scenario) => [scenario.id, SCENARIO_FINAL] as const),
        ]
        const allFinal = (snapshot: RunSnapshot) =>
          units.every(([id, finals]) => finals.includes(unitState(snapshot, id)))
        for (let seed = 1; seed <= 12; seed++) {
          const next = random(seed * 7919 + name.length)
          let snapshot = engine.initial(plan)
          // The start-up step: a subtree run trusts some of its external regions.
          for (const id of plan.external)
            if (next() < 0.5) snapshot = engine.apply(plan, snapshot, { type: "outside.trusted", at: 1, id })
          snapshot = engine.apply(plan, snapshot, { type: "run.started", at: 1 })
          for (let step = 0; step < 400 && snapshot.status === "active"; step++) {
            seen.steps++
            // The run is still active, so some task or scenario region is not final: once all are, it has settled.
            expect({ name, root, seed, step, allFinalWhileActive: allFinal(snapshot) }).toEqual({
              name,
              root,
              seed,
              step,
              allFinalWhileActive: false,
            })
            if (next() < 0.01) {
              snapshot = engine.apply(plan, snapshot, { type: "run.cancelled", at: 1, reason: "walk stop" })
              continue
            }
            const offered = TaskAlphabet.alphabet(snapshot)
            const failures: ReadonlyArray<Fact> = plan.scenarios.flatMap((scenario): ReadonlyArray<Fact> => {
              if (snapshot.hasTag(`${scenario.id}:ready`))
                return [{ type: "scenario.proved", at: 1, id: scenario.id, status: "failed", reason: "walk" }]
              if (snapshot.hasTag(`${scenario.id}:verifying`))
                return [{ type: "scenario.verified", at: 1, verdict: { id: scenario.id, verdict: "rejected" } }]
              return []
            })
            const trusts = offered.filter((fact) => fact.type === "outside.trusted")
            const work = [...offered.filter((fact) => fact.type !== "outside.trusted"), ...failures]
            // The work in two parts: the facts that make progress, and those that harm (a failure, a death, a
            // repetition, a failed proof, a rejected verdict). A walk mostly makes progress, so it gets deep.
            const harms = work.filter(harmful)
            const progress = work.filter((fact) => !harmful(fact))
            // The first fact of the list, in a seeded order, that moves the run.
            const moved = (list: ReadonlyArray<Fact>) => {
              for (const fact of shuffle(list, next)) {
                const each = engine.apply(plan, snapshot, fact)
                if (each !== snapshot) return each
              }
              return undefined
            }
            // Now and then a trust comes first, so that the walks trust a region at different points.
            const early = next() < 0.15 ? moved(trusts) : undefined
            if (early !== undefined) {
              snapshot = early
              continue
            }
            const fromWork = next() < 0.06 ? (moved(harms) ?? moved(progress)) : (moved(progress) ?? moved(harms))
            if (fromWork !== undefined) {
              snapshot = fromWork
              continue
            }
            // No fact of the work moves the run: every unit that has not ended waits on an untrusted region.
            seen.standstills++
            const still = units
              .filter(([id, finals]) => !finals.includes(unitState(snapshot, id)))
              .map(([id]) => ({ id, onRegion: waitsOnRegion(plan, snapshot, id) }))
            expect(still.length).toBeGreaterThan(0)
            expect({ name, root, seed, still }).toEqual({
              name,
              root,
              seed,
              still: still.map(({ id }) => ({ id, onRegion: true })),
            })
            const fromTrust = moved(trusts)
            if (fromTrust === undefined) break
            snapshot = fromTrust
          }
          if (snapshot.status === "done") {
            seen.settled++
            seen.outcomes.add(engine.view(snapshot).run.state)
            expect(allFinal(snapshot)).toBe(true)
          }
        }
      }
      // The walks reached both ends: runs that settled, and standstills on a region.
      expect(seen.settled).toBeGreaterThan(0)
      expect(seen.standstills).toBeGreaterThan(0)
      // The settled runs ended in each kind of outcome: done, a dead task's state, acceptance failed, and a stop.
      for (const outcome of ["done", "failed", "cancelled"]) expect([...seen.outcomes]).toContain(outcome)
      expect([...seen.outcomes].some((state) => state === "budget_exhausted" || state === "needs_human")).toBe(true)
      // The same standstill check finds the stuck wait of the copy without the gap row: once T9 is trusted, no fact
      // moves T1.5, and it waits on the ended T1.4.
      const notes = yield* loadPlan("release-notes.spec")
      const unchecked = createMachine(withoutGap(notes).copy, {
        actions: TaskMachine.ACTIONS,
        guards: TaskMachine.GUARDS,
      })
      const f = facts()
      const [first] = Effect.runSync(initialTransition(unchecked))
      const stuck = [...observed(notes, f), f.outside("T9")].reduce(
        (each, fact) => engine.applyTo(unchecked, each, fact),
        first,
      )
      const work = TaskAlphabet.alphabet(stuck).filter((fact) => fact.type !== "outside.trusted")
      expect(work.filter((fact) => "task" in fact && fact.task === "T1.5")).toEqual([])
      expect(engine.waitingOn(stuck, "T1.5")).toEqual(["T1.4"])
      expect(waitsOnRegion(notes, stuck, "T1.5")).toBe(false)
    }),
  150_000,
)

it.live(
  "[RM29] T1.5 waits on the outside T9, and in its subtree run on the external T1.3 and T1.4, until a fact trusts them",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const waiting = [
        f.runStarted(),
        ...trustLeaf(plan, f, "T1.1"),
        ...trustLeaf(plan, f, "T1.2"),
        ...trustLeaf(plan, f, "T1.3"),
        ...trustLeaf(plan, f, "T1.4"),
      ].reduce((each, fact) => engine.apply(plan, each, fact), engine.initial(plan))
      expect(unitState(waiting, "T1.5")).toBe("waiting")
      expect(engine.waitingOn(waiting, "T1.5")).toEqual(["T9"])
      expect(waiting.status).toBe("active")
      expect(unitState(engine.apply(plan, waiting, f.outside("T9")), "T1.5")).toBe("ready")
      // The T1.5 subtree: T1.3 and T1.4 are external regions.
      const sub = yield* loadPlan("release-notes.spec", "T1.5")
      expect(sub.external).toEqual(["T1.3", "T1.4"])
      const g = facts()
      const started = engine.apply(sub, engine.initial(sub), g.runStarted())
      expect(unitState(started, "T1.5")).toBe("waiting")
      expect(engine.waitingOn(started, "T1.5")).toEqual(["T1.3", "T1.4", "T9"])
      const trusted = [g.outside("T1.3"), g.outside("T1.4"), g.outside("T9")].reduce(
        (each, fact) => engine.apply(sub, each, fact),
        started,
      )
      expect(unitState(trusted, "T1.5")).toBe("ready")
    }),
)
