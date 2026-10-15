import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, FileSystem, Layer } from "effect"
import path from "path"
import { createActor, fromEffect, SimulatedClock } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { Plan, Verdict } from "@/task/core/model"
import { ScenarioSupervisor } from "@/task/core/supervise/scenario"
import { TaskWorkers } from "@/task/core/workers"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, trustLeaf } from "./lib/machine"
import {
  eventually,
  hang,
  move,
  prompted,
  repository,
  type Run,
  runOf,
  sent,
  settle,
  stored,
  storedFacts,
  storedTypes,
  type Turn,
  unitOf,
} from "./lib/supervise"

// The scenario supervisor (spine AD-8): the judge round of one scenario in `verifying`, in the root checkout, and
// `scenario.verified` as its only fact. Each test plays the run supervisor's part and scripts the judge's turns.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

// S2 needs only T1.1: once T1.1 is trusted and S2's tagged tests pass, S2 waits for its judge.
const verifyingS2 = (plan: Plan) => {
  const f = facts()
  return [f.runStarted(), ...trustLeaf(plan, f, "T1.1"), f.scenarioProved("S2", "passed")]
}

const scenarioOf = (plan: Plan, id: string) => {
  const scenario = plan.spec.scenarios.find((item) => item.id === id)
  if (scenario === undefined) throw new Error(`no scenario ${id}`)
  return scenario
}

const spawn = Effect.fnUntraced(function* (
  setup: Run & { readonly plan: Plan },
  id: string,
  options: {
    readonly clock?: SimulatedClock
    readonly actors?: Parameters<typeof ScenarioSupervisor.machine.provide>[0]["actors"]
  } = {},
) {
  const unit = unitOf(yield* setup.recorder.actor.getSnapshot, id)
  sent.set(`${setup.id}:${id}`, unit.entry)
  const logic = options.actors
    ? ScenarioSupervisor.machine.provide({ actors: options.actors })
    : ScenarioSupervisor.machine
  const actor = yield* createActor(logic, {
    input: {
      run: setup.run,
      scenario: scenarioOf(setup.plan, id),
      owner: `scenario:${setup.id}:${id}`,
      entry: unit.entry,
      tags: unit.tags,
    },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
  yield* actor.start
  return actor
})

type Supervisor = Effect.Success<ReturnType<typeof spawn>>

const quiet = (actor: Supervisor) =>
  eventually(
    Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches("quiet")),
    "the supervisor is quiet",
  )

// The supervisor of a test, once spawned: a turn can start before `spawn` returns, so a turn waits for it.
const spawned = (holder: { actor?: Supervisor }): Effect.Effect<Supervisor> =>
  Effect.suspend(() =>
    holder.actor ? Effect.succeed(holder.actor) : Effect.sleep(5).pipe(Effect.andThen(spawned(holder))),
  )

// A judge's turn that calls `verdict` with these verdicts.
const judging =
  (holder: { actor?: Supervisor }, verdicts: ReadonlyArray<Verdict>): Turn =>
  (prompt) =>
    Effect.flatMap(spawned(holder), (actor) => actor.send({ type: "hook.verdicts", session: prompt.session, verdicts }))

const S2_TRUSTED: Verdict = { id: "S2", verdict: "trusted" }

describe("the scenario supervisor", () => {
  it.live("judges a verifying scenario in the root checkout for its owner and records scenario.verified", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const holder: { actor?: Supervisor } = {}
      // The judge leaves a file behind: the round restores the root checkout after it.
      const left: Turn = (prompt) =>
        fs
          .writeFileString(path.join(root, "judge-notes.md"), "x")
          .pipe(Effect.orDie, Effect.andThen(judging(holder, [S2_TRUSTED])(prompt)))
      const setup = { plan, ...(yield* runOf({ plan, directory: root, stored: verifyingS2(plan), turns: [left] })) }
      const actor = yield* spawn(setup, "S2")
      holder.actor = actor
      yield* stored(setup.id, 1)
      yield* quiet(actor)
      expect(yield* storedFacts(setup.id)).toMatchObject([{ type: "scenario.verified", verdict: S2_TRUSTED }])
      const scenario = scenarioOf(plan, "S2")
      const lines = (setup.seen.prompts[0]?.text ?? "").split("\n")
      expect(lines.slice(0, 2)).toEqual(["task-harness role=verifier scenario=S2", `judge S2: ${scenario.title}`])
      expect(setup.seen.claims).toEqual([
        { session: setup.seen.prompts[0]?.session, owner: `scenario:${setup.id}:S2`, watch: false },
      ])
      expect(yield* fs.exists(path.join(root, "judge-notes.md"))).toBe(false)
      // The run actor folds the verdict: S2 is trusted.
      yield* eventually(
        Effect.map(setup.recorder.actor.getSnapshot, (snapshot) => unitOf(snapshot, "S2").state === "trusted"),
        "S2 trusted",
      )
    }),
  )

  it.live("asks once more in the same session when the judge gave no verdict for the scenario, then records it", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const holder: { actor?: Supervisor } = {}
      const rejected: Verdict = { id: "S2", verdict: "rejected", reason: "the notes miss the scope" }
      const turns = [judging(holder, [{ id: "S9", verdict: "trusted" }]), judging(holder, [rejected])]
      const setup = { plan, ...(yield* runOf({ plan, directory: root, stored: verifyingS2(plan), turns })) }
      holder.actor = yield* spawn(setup, "S2")
      yield* stored(setup.id, 1)
      expect(yield* storedFacts(setup.id)).toMatchObject([{ type: "scenario.verified", verdict: rejected }])
      const [ask, missing] = setup.seen.prompts
      expect(missing?.session).toBe(ask?.session)
      expect(missing?.text.split("\n")[0]).toBe(`judge S2: ${scenarioOf(plan, "S2").title}`)
      expect(setup.seen.prompts).toHaveLength(2)
    }),
  )

  it.live("asks in a second session when the first gave nothing, and rejects with no verdict after that", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const setup = { plan, ...(yield* runOf({ plan, directory: root, stored: verifyingS2(plan) })) }
      const actor = yield* spawn(setup, "S2")
      yield* stored(setup.id, 1)
      yield* quiet(actor)
      expect(yield* storedFacts(setup.id)).toMatchObject([
        { type: "scenario.verified", verdict: { id: "S2", verdict: "rejected", reason: "no verdict" } },
      ])
      // Two asks, each in its own session, and no askMissing (the judge never called verdict).
      expect(setup.seen.prompts).toHaveLength(2)
      expect(setup.seen.prompts[1]?.session).not.toBe(setup.seen.prompts[0]?.session)
      expect(setup.seen.prompts.every((item) => item.text.startsWith("task-harness role=verifier scenario=S2"))).toBe(
        true,
      )
    }),
  )

  it.live("SV6 rejects the scenario with harness error after three judge failures in a row", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const clock = new SimulatedClock()
      const setup = { plan, ...(yield* runOf({ plan, directory: "/root", stored: verifyingS2(plan) })) }
      let tries = 0
      const broken = fromEffect<
        { run: TaskWorkers.Run } & Parameters<typeof TaskWorkers.scenarioJudge>[1],
        TaskWorkers.Turn,
        TaskWorkers.WorkerError,
        never
      >(({ input }) =>
        Effect.gen(function* () {
          tries++
          return yield* new TaskWorkers.WorkerError({ message: `the judge of ${input.scenario.id} broke` })
        }),
      )
      yield* spawn(setup, "S2", { clock, actors: { judge: broken } })
      yield* eventually(
        Effect.sync(() => tries === 1),
        "try 1",
      )
      yield* settle
      yield* clock.increment(1_000)
      yield* eventually(
        Effect.sync(() => tries === 2),
        "try 2",
      )
      yield* settle
      expect(yield* storedTypes(setup.id)).toEqual([])
      yield* clock.increment(1_000)
      yield* stored(setup.id, 1)
      expect(tries).toBe(3)
      expect(yield* storedFacts(setup.id)).toMatchObject([
        {
          type: "scenario.verified",
          verdict: { id: "S2", verdict: "rejected", reason: "harness error: the judge of S2 broke" },
        },
      ])
    }),
  )

  it.live(
    "SV9 records only scenario.verified: other hooks do nothing, and a scenario not in verifying gets no judge",
    () =>
      Effect.gen(function* () {
        const root = yield* repository()
        const plan = yield* loadPlan("release-notes.spec")
        const holder: { actor?: Supervisor } = {}
        const other: Turn = (prompt) =>
          Effect.gen(function* () {
            const actor = yield* spawned(holder)
            yield* actor.send({ type: "hook.ready", session: prompt.session })
            yield* actor.send({ type: "hook.repeated", session: prompt.session, reason: "repetition" })
            yield* judging(holder, [S2_TRUSTED])(prompt)
          })
        const setup = { plan, ...(yield* runOf({ plan, directory: root, stored: verifyingS2(plan), turns: [other] })) }
        const actor = yield* spawn(setup, "S2")
        holder.actor = actor
        yield* stored(setup.id, 1)
        yield* quiet(actor)
        yield* settle
        expect(yield* storedTypes(setup.id)).toEqual(["scenario.verified"])
        // Spawned for a scenario that only waits: no judge, no fact.
        const waiting = { plan, ...(yield* runOf({ plan, directory: root, stored: [facts().runStarted()] })) }
        const idle = yield* spawn(waiting, "S2")
        yield* quiet(idle)
        yield* settle
        expect(waiting.seen.prompts).toEqual([])
        expect(yield* storedTypes(waiting.id)).toEqual([])
      }),
  )

  it.live("SV27 a stopped supervisor cancels its judge's turn, counts no failure and records nothing", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const setup = { plan, ...(yield* runOf({ plan, directory: root, stored: verifyingS2(plan), turns: [hang] })) }
      const actor = yield* spawn(setup, "S2")
      yield* prompted(setup.seen, 1)
      yield* actor.stop
      yield* eventually(
        Effect.sync(() => setup.seen.cancels.length === 1),
        "the cancel",
      )
      yield* Effect.sleep(200)
      expect(setup.seen.cancels).toEqual([setup.seen.prompts[0]?.session])
      expect(yield* storedTypes(setup.id)).toEqual([])
      expect((yield* actor.getSnapshot).status).toBe("stopped")
    }),
  )

  it.live("judges again on a new verifying entry, as after a stale rejudge", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      const plan = yield* loadPlan("release-notes.spec")
      const holder: { actor?: Supervisor } = {}
      const setup = {
        plan,
        ...(yield* runOf({ plan, directory: root, stored: verifyingS2(plan), turns: [judging(holder, [S2_TRUSTED])] })),
      }
      const actor = yield* spawn(setup, "S2")
      holder.actor = actor
      yield* stored(setup.id, 1)
      yield* quiet(actor)
      // An old entry or one that is not the newest starts nothing.
      const snapshot = yield* setup.recorder.actor.getSnapshot
      yield* actor.send({ type: "unit.moved", unit: "S2", latest: false, ...unitOf(snapshot, "S2"), entry: 999 })
      yield* settle
      expect(setup.seen.prompts).toHaveLength(1)
      const event = yield* move(setup, actor, "S2")
      expect(event.tags).not.toContain("verifying")
      yield* quiet(actor)
      expect(setup.seen.prompts).toHaveLength(1)
    }),
  )
})
