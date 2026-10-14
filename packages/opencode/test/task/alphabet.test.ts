import { NodeServices } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Fact, Plan } from "@/task/core/model"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskAlphabet } from "@/task/engine-xstate/alphabet"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { facts, fail, loadPlan, trustLeaf } from "./lib/machine"

// The progress alphabet and the walk key of the graph proof (spine AD-7).

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const fold = (plan: Plan, list: ReadonlyArray<Fact>) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), engine.initial(plan))

// Each fact of the alphabet as `type unit [detail]`.
const names = (list: ReadonlyArray<Fact>) =>
  list.map((fact) => {
    switch (fact.type) {
      case "task.proved":
        return `${fact.type} ${fact.task} ${fact.results.map((result) => result.status).join(",")}`
      case "task.verified":
        return `${fact.type} ${fact.task} ${fact.verdicts.map((verdict) => verdict.verdict).join(",")}`
      case "scenario.proved":
        return `${fact.type} ${fact.id} ${fact.status}`
      case "scenario.verified":
        return `${fact.type} ${fact.verdict.id} ${fact.verdict.verdict}`
      case "outside.trusted":
      case "obligation.stale":
        return `${fact.type} ${fact.id}`
      case "run.started":
      case "run.resumed":
      case "run.cancelled":
      case "run.ended":
        return fact.type
      default:
        return `${fact.type} ${fact.task}`
    }
  })

describe("the progress alphabet", () => {
  it.live(
    "gives a ready leaf its start and failure, a ready parent its review and failure, ready scenarios their proofs",
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan("example-scenarios.spec")
        const f = facts()
        expect(names(TaskAlphabet.alphabet(fold(plan, [f.runStarted()])))).toEqual([
          "task.started T1.1",
          "task.failed T1.1",
        ])
        const trusted = fold(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1")])
        expect(names(TaskAlphabet.alphabet(trusted))).toEqual([
          "task.proved T1 ",
          "task.failed T1",
          "scenario.proved S1 passed",
        ])
      }),
  )

  it.live("gives an active task phase its abstract outcomes, and an active scenario one success path", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const building = fold(plan, [f.runStarted(), f.started("T1.3")])
      expect(names(TaskAlphabet.alphabet(building)).filter((name) => name.includes("T1.3"))).toEqual([
        "task.ready T1.3",
        "task.repeated T1.3",
        "task.needs_human T1.3",
        "task.failed T1.3",
      ])
      const proving = fold(plan, [f.runStarted(), f.started("T1.3"), f.ready("T1.3")])
      expect(names(TaskAlphabet.alphabet(proving)).filter((name) => name.includes("T1.3"))).toEqual([
        "task.proved T1.3 passed",
        "task.proved T1.3 failed",
        "task.needs_human T1.3",
        "task.failed T1.3",
      ])
      const verifying = fold(plan, [f.runStarted(), f.started("T1.3"), f.ready("T1.3"), f.proved("T1.3", [])])
      expect(names(TaskAlphabet.alphabet(verifying)).filter((name) => name.includes("T1.3"))).toEqual([
        "task.verified T1.3 trusted",
        "task.verified T1.3 rejected",
        "task.needs_human T1.3",
        "task.failed T1.3",
      ])
      const scenarios = yield* loadPlan("example-scenarios.spec")
      const judged = fold(scenarios, [
        f.runStarted(),
        ...trustLeaf(scenarios, f, "T1.1"),
        f.scenarioProved("S1", "passed"),
      ])
      expect(names(TaskAlphabet.alphabet(judged)).filter((name) => name.includes("S1"))).toEqual([
        "scenario.verified S1 trusted",
      ])
    }),
  )

  it.live("trusts an untrusted outside region, never stops or stalls the run, and stamps every fact alike", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const list = TaskAlphabet.alphabet(fold(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1")]))
      expect(names(list)).toContain("outside.trusted T8")
      expect(names(list)).toContain("outside.trusted T9")
      const types = new Set<string>(list.map((fact) => fact.type))
      for (const type of ["run.cancelled", "run.ended", "task.stalled", "obligation.stale", "run.started"])
        expect(types.has(type)).toBe(false)
      expect(new Set(list.map((fact) => fact.at))).toEqual(new Set([TaskAlphabet.AT]))
    }),
  )

  it.live("trusts an external region only in the start-up step", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec", "T1.5")
      const start = engine.initial(plan)
      expect(names(TaskAlphabet.alphabet(start)).filter((name) => name.startsWith("outside.trusted"))).toEqual([
        "outside.trusted T8",
        "outside.trusted T9",
        "outside.trusted T1.3",
        "outside.trusted T1.4",
      ])
      const later = fold(plan, [facts().outside("T8")])
      expect(names(TaskAlphabet.alphabet(later)).filter((name) => name.startsWith("outside.trusted"))).toEqual([
        "outside.trusted T9",
      ])
    }),
  )
})

describe("the walk key", () => {
  it.live("lists the units in plan order by machine state, with the attempts of each task that has not ended", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const key = TaskAlphabet.walkKey(plan)
      const f = facts()
      // T1.1 and T1.3 are ready, which the status shows as waiting; the key tells them apart.
      const start = key(fold(plan, [f.runStarted()]))
      expect(start).toContain("T1.1:ready")
      expect(start).toContain("T1.2:waiting")
      expect(start.indexOf("T1:")).toBeLessThan(start.indexOf("T1.1:"))
      expect(start.indexOf("T1.1:")).toBeLessThan(start.indexOf("T1.3:"))
      const dead = fold(plan, [
        f.runStarted(),
        f.started("T1.1"),
        f.ready("T1.1"),
        f.proved("T1.1", [fail("T1.1.c1", "BUILD-1 exited 1")]),
      ])
      // An ended task is keyed by its state alone; a task in work keeps its attempts and obligations.
      expect(key(dead)).toContain("T1.1:budget_exhausted|")
      expect(key(dead)).not.toContain("T1.1:budget_exhausted@")
      const building = key(fold(plan, [f.runStarted(), f.started("T1.3")]))
      expect(building).toContain("T1.3:building@1[pending]")
      expect(key(fold(plan, [f.runStarted(), f.started("T1.3")]))).toBe(building)
      expect(key(dead)).not.toBe(building)
    }),
  )

  test("covers every context path that a guard reads", () => {
    const read = Object.values(TaskMachine.GUARDS).flatMap((guard) =>
      Array.from(guard.toString().matchAll(/context\.(\w+)/g), (match) => match[1] ?? ""),
    )
    expect(read.length).toBeGreaterThan(0)
    for (const path of new Set(read)) expect(TaskAlphabet.KEYED).toContain(path)
  })
})
