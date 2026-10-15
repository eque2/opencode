import { NodeServices } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import path from "path"
import { createMachine, initialTransition, stateIn } from "@jambudipa/xstate-effect"
import { TaskEvents } from "@/task/core/events"
import type { Fact } from "@/task/core/model"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { facts, fail, loadPlan, observed, trust, trustLeaf } from "./lib/machine"

// The engine API over snapshots (spine AD-6): `initial`, a pure `apply`, the selectors and `view`.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState
const fold = (plan: Parameters<typeof engine.initial>[0], list: ReadonlyArray<Fact>) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), engine.initial(plan))

describe("TaskEngineXState", () => {
  it.live("initial gives an active snapshot, apply the next one, and view the State shape", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const first = engine.initial(plan)
      expect(first.status).toBe("active")
      const f = facts()
      const next = engine.apply(plan, first, f.runStarted())
      expect(next).not.toBe(first)
      const state = engine.view(next)
      expect(state.run).toEqual({ state: "running", spec: plan.specPath, path: plan.path })
      expect(state.tasks["T1.1"]).toEqual({ id: "T1.1", leaf: true, state: "waiting", attempts: 0 })
      expect(state.tasks.T1).toEqual({ id: "T1", leaf: false, state: "waiting", attempts: 0 })
      expect(state.obligations["T1.1.c1"]).toEqual({
        id: "T1.1.c1",
        task: "T1.1",
        state: "pending",
        hash: plan.spec.obligations.find((item) => item.id === "T1.1.c1")?.hash ?? "no hash",
      })
      expect(state.scenarios).toEqual({})
      expect(state.history).toEqual([{ at: 1, unit: "run", from: "running", to: "running" }])
    }),
  )

  it.live("RM6 returns its input once the run is done, for any fact", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const done = fold(plan, [f.runStarted(), f.cancelled("user stop")])
      expect(done.status).toBe("done")
      for (const fact of [f.started("T1.1"), f.stale("T1.3.c1"), f.outside("T9"), f.runStarted()])
        expect(engine.apply(plan, done, fact)).toBe(done)
    }),
  )

  it.live("dies on a snapshot of another plan's machine, and ignores an unknown id", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const other = yield* loadPlan("example-scenarios.spec")
      const f = facts()
      expect(() => engine.apply(plan, engine.initial(other), f.runStarted())).toThrow(/another plan/)
      const started = engine.apply(plan, engine.initial(plan), f.runStarted())
      for (const fact of [f.started("T7"), f.stale("T7.c1"), f.scenarioProved("S99", "passed"), f.outside("T1.1")])
        expect(engine.apply(plan, started, fact)).toBe(started)
    }),
  )

  it.live("returns the identical snapshot for a fact that changes nothing, and never mutates its input", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const started = engine.apply(plan, engine.initial(plan), f.runStarted())
      expect(engine.apply(plan, started, f.ready("T1.1"))).toBe(started)
      const before = JSON.stringify(started.context)
      const moved = engine.apply(plan, started, f.started("T1.1"))
      expect(moved).not.toBe(started)
      expect(JSON.stringify(started.context)).toBe(before)
    }),
  )

  it.live("RM8a folds every stored fact type, a run.started with no path and a stored run.ended done", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      // Two old engine slices, stored before `run.started` had a path. Each fact meets the run while it is still
      // active, so each one must move it. The first slice has no dead task, so its stored `run.ended { state: "done" }`
      // stops the run with its own state. The second kills two tasks, then is cancelled: the task that died first
      // decides the outcome (SD-18).
      const ended: ReadonlyArray<Fact> = [
        f.runStarted(),
        f.runResumed(),
        f.outside("T9"),
        ...trustLeaf(plan, f, "T1.1"),
        f.scenarioProved("S2", "passed"),
        f.scenarioVerified(trust("S2")),
        f.started("T1.2"),
        f.stalled("T1.2", "no stream for 120 s"),
        f.nudged("T1.2", 1, "idle without task_ready"),
        f.repeated("T1.2", "read src/bump.ts 5 times"),
        f.ready("T1.2"),
        f.proved("T1.2", [fail("T1.2.c1", "red")]),
        f.stale("T1.1.c1"),
        f.proved("T1.1", [fail("T1.1.c1", "red")]),
        f.ended("done"),
      ]
      const cancelled: ReadonlyArray<Fact> = [
        f.runStarted(),
        ...trustLeaf(plan, f, "T1.1"),
        f.started("T1.3"),
        f.failed("T1.3", "the merge failed"),
        f.started("T1.2"),
        f.needsHuman("T1.2", "spend cap: $5.00 reached"),
        f.cancelled("user stop"),
      ]
      // Every member of the stored-fact schema is in one of the two slices, so each decodes and folds.
      const types: ReadonlyArray<string> = [...new Set([...ended, ...cancelled].map((fact) => fact.type))]
      expect(types.toSorted()).toEqual(
        [
          "run.started",
          "run.resumed",
          "outside.trusted",
          "task.started",
          "task.ready",
          "task.proved",
          "task.verified",
          "task.stalled",
          "task.nudged",
          "task.repeated",
          "task.needs_human",
          "task.failed",
          "obligation.stale",
          "scenario.proved",
          "scenario.verified",
          "run.cancelled",
          "run.ended",
        ].toSorted(),
      )
      expect(types.length).toBe(TaskEvents.FactSchema.members.length)
      for (const fact of [...ended, ...cancelled]) {
        expect(Schema.decodeUnknownSync(TaskEvents.FactSchema)(fact)).toEqual(fact)
        expect("path" in fact).toBe(false)
      }

      const each = (slice: ReadonlyArray<Fact>) => {
        let snapshot = engine.initial(plan)
        for (const fact of slice) {
          expect({ fact: fact.type, status: snapshot.status }).toEqual({ fact: fact.type, status: "active" })
          const next = engine.apply(plan, snapshot, fact)
          expect({ fact: fact.type, moved: next !== snapshot }).toEqual({ fact: fact.type, moved: true })
          snapshot = next
        }
        return snapshot
      }
      const stopped = each(ended)
      expect(stopped.status).toBe("done")
      expect(engine.view(stopped).run.state).toBe("done")
      expect(engine.ended(stopped)).toBe(true)

      const stop = each(cancelled)
      expect(stop.status).toBe("done")
      expect(engine.view(stop).run.state).toBe("failed")
      expect(engine.view(stop).tasks["T1.2"]?.state).toBe("needs_human")
    }),
  )

  it.live("reads units through tags and meta: unitState, tags, waitingOn, blockedBy and ended", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const trusted = fold(plan, [
        f.runStarted(),
        ...trustLeaf(plan, f, "T1.1"),
        ...trustLeaf(plan, f, "T1.2"),
        ...trustLeaf(plan, f, "T1.3"),
      ])
      expect(engine.unitState(trusted, "T1.4")).toBe("waiting")
      expect(engine.unitState(trusted, "T1.3")).toBe("trusted")
      expect(engine.unitState(trusted, "S2")).toBe("pending")
      expect(engine.unitState(trusted, "run")).toBe("running")
      expect(engine.tags(trusted, "T1.4")).toEqual(["waiting"])
      expect(engine.tags(trusted, "T1.3")).toEqual(["ended"])
      expect(engine.waitingOn(trusted, "T1.5")).toEqual(["T1.4", "T9"])
      expect(engine.waitingOn(trusted, "T1.3")).toEqual([])
      expect(engine.ended(trusted)).toBe(false)
      const blocked = fold(plan, observed(plan))
      expect(engine.tags(blocked, "T1.5")).toEqual(["ended", "stopped", "blocked"])
      expect(engine.tags(blocked, "T1.4")).toEqual(["ended", "stopped", "dead"])
      expect(engine.blockedBy(blocked, "T1.5")).toEqual({ id: "T1.4", state: "budget_exhausted" })
      expect(engine.blockedBy(blocked, "T1.4")).toBeUndefined()
      expect(engine.waitingOn(blocked, "T1.5")).toEqual([])
    }),
  )

  it.live("RM28 dies on a machine error after task.started, and on an error snapshot", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      // A copy of the machine with a guard on an unknown id: the checks would refuse it, so it is built directly.
      const broken = (id: string) =>
        createMachine(
          TaskMachine.mapStates(TaskMachine.config(plan), (node) =>
            node.id === id ? { ...node, always: [{ guard: stateIn("#nowhere/at_all"), target: "blocked" }] } : node,
          ),
          { actions: TaskMachine.ACTIONS, guards: TaskMachine.GUARDS },
        )
      const building = broken("T1_1/building")
      const [ready] = Effect.runSync(initialTransition(building))
      const f = facts()
      expect(() => engine.applyTo(building, ready, f.started("T1.1"))).toThrow(/nowhere/)
      const waiting = broken("T1_1/waiting")
      const [error] = Effect.runSync(initialTransition(waiting))
      expect(error.status).toBe("error")
      expect(() => engine.applyTo(waiting, error, f.runStarted())).toThrow(/status error/)
    }),
  )

  test("RM3 the engine module no longer defines the four machines or the fold code", () => {
    const source = readFileSync(path.resolve(import.meta.dir, "../../src/task/engine-xstate/index.ts"), "utf8")
    for (const name of [
      "obligationMachine",
      "taskMachine",
      "scenarioMachine",
      "runMachine",
      "stepTask",
      "stepRun",
      "cancel",
      "staleAlone",
      "follows",
      "runSnapshot",
      "settled",
    ])
      expect(source).not.toMatch(new RegExp(`\\b(const|function|let)\\s+${name}\\b`))
    const events = readFileSync(path.resolve(import.meta.dir, "../../src/task/core/events.ts"), "utf8")
    expect(events).not.toMatch(/\bENDED\b/)
  })
})
