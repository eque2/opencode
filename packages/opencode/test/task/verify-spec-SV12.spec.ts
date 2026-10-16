import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import fs from "fs"
import path from "path"
import { createActor } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { Fact } from "@/task/core/model"
import { TaskSessions } from "@/task/core/sessions"
import { TaskSupervisor } from "@/task/core/supervise/task"
import { TaskWorkers } from "@/task/core/workers"
import { TaskWorkspace } from "@/task/core/workspace"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { facts, loadPlan } from "./lib/machine"
import {
  eventually,
  move,
  repository,
  runOf,
  sent,
  stored,
  storedFacts,
  started,
  type Turn,
  unitOf,
} from "./lib/supervise"

// Scenario SV12 (spec task-harness-feedback, D7, AD-8, AD-10; tasks T2.2, T2.8): an idle builder is nudged twice,
// then the proof decides.
//
//   Given a building task whose turn ends idle without task_ready
//   When the turn ends idle a first and a second time
//   Then task.nudged is recorded with nudge 1, then with nudge 2
//   And after the last nudge the proof runs on the builder's head, or the task records "the builder ended without
//     task_ready"
//
// The task is T1.1 of the release-notes plan, building in a real git worktree of a scratch repository. Everything that
// runs is the real code: the task supervisor machine and its builder-turn, record, ready, unready and proof workers,
// the real proof runner (`bun test` in the worktree), and a real Recorder over the real event store whose run actor
// folds each fact. Only the model side is scripted: each builder turn writes into the worktree and ends, and the
// third one may call task_ready (its hook event, which the harness root routes to the session's owner, SV13). The test
// plays the run supervisor's part: after each recorded fact it sends `unit.moved` for the unit's newest entry.
// The two tests are the two outcomes after the last nudge.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

// The scripted bounds, with a stream idle time longer than any test (no stall can stand in for an idle end) and a
// proof bound that a loaded machine keeps.
const LIMITS: TaskLimits.Limits = {
  ...TaskLimits.scripted,
  streamIdle: Duration.seconds(600),
  proofTimeout: Duration.seconds(60),
}
const NO_READY = "the builder ended without task_ready"
const ATTEMPT = "task-harness role=builder task=T1.1"

let worktrees = 0

// A building T1.1 in a real worktree, the builder turns scripted by `turns`, and its task supervisor spawned as the
// run supervisor would spawn it for the unit's newest entry.
const building = Effect.fnUntraced(function* (
  turns: (worktree: string, actor: () => TaskSupervisor.TaskSupervisor) => ReadonlyArray<Turn>,
) {
  const root = yield* repository()
  const plan = yield* loadPlan("release-notes.spec")
  const f = facts()
  const begun = yield* started(root, `task_sv12tree${(worktrees++).toString(16).padStart(4, "0")}`, "T1.1", 2)
  const holder: { actor?: TaskSupervisor.TaskSupervisor } = {}
  const self = () => {
    if (holder.actor === undefined) throw new Error("the supervisor is not spawned yet")
    return holder.actor
  }
  const stored: ReadonlyArray<Fact> = [f.runStarted(plan.path), begun.fact]
  const setup = yield* runOf({
    plan,
    directory: root,
    stored,
    turns: turns(begun.tree.worktree, self),
    limits: LIMITS,
  })
  // The Given: T1.1 is building in the run actor, in its worktree, with its builder session.
  const before = yield* setup.recorder.actor.getSnapshot
  expect(TaskEngineXState.unitState(before, "T1.1")).toBe("building")
  const unit = unitOf(before, "T1.1")
  expect(unit.session).toBe("ses_T1.1")
  expect(TaskEngineXState.view(before).tasks["T1.1"]?.worktree).toBe(begun.tree.worktree)
  sent.set(`${setup.id}:T1.1`, unit.entry)
  const task = plan.tasks.find((item) => item.id === "T1.1")
  if (task === undefined) throw new Error("no task T1.1")
  const actor = yield* createActor(TaskSupervisor.machine, {
    input: {
      run: setup.run,
      events: setup.events,
      task,
      spec: plan.spec,
      owner: `task:${setup.id}:T1.1`,
      entry: unit.entry,
      tags: unit.tags,
      session: "ses_T1.1",
      runStart: 0,
    } satisfies TaskSupervisor.Input,
  })
  holder.actor = actor
  yield* actor.start
  const quiet = eventually(
    Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches({ live: { work: "quiet" } })),
    "the supervisor is quiet",
  )
  const tests = plan.spec.obligations.filter((item) => item.task === "T1.1" && item.proof.kind === "test")
  return { root, plan, begun, setup, actor, quiet, tests }
})

type Building = Effect.Success<ReturnType<typeof building>>

// The builder's work: one more line in the file it owns, so each turn leaves something to commit.
const write = (worktree: string, file: string, text: string) =>
  Effect.sync(() => {
    fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true })
    fs.appendFileSync(path.join(worktree, file), text)
  })

// The When: two turns that end idle, each nudged once the run supervisor's part sends the nudge's entry.
const nudgedTwice = Effect.fnUntraced(function* (given: Building) {
  const { setup, actor, quiet } = given
  // The first turn ends idle: nudge 1.
  yield* stored(setup.id, 1)
  yield* quiet
  expect((yield* actor.getSnapshot).context.nudges).toBe(1)
  yield* move(setup, actor, "T1.1")
  // The nudge prompt ends idle too: nudge 2.
  yield* stored(setup.id, 2)
  yield* quiet
  expect((yield* actor.getSnapshot).context.nudges).toBe(2)
  const recorded = yield* storedFacts(setup.id)
  expect(recorded.map((fact) => fact.type)).toEqual(["task.nudged", "task.nudged"])
  expect(recorded[0]).toMatchObject({ type: "task.nudged", task: "T1.1", nudge: 1, reason: NO_READY })
  expect(recorded[1]).toMatchObject({ type: "task.nudged", task: "T1.1", nudge: 2, reason: NO_READY })
  // Each nudge is a targetless building entry of the run's history: T1.1 still builds, attempt 1.
  const snapshot = yield* setup.recorder.actor.getSnapshot
  expect(TaskEngineXState.unitState(snapshot, "T1.1")).toBe("building")
  expect(TaskEngineXState.view(snapshot).tasks["T1.1"]?.attempts).toBe(1)
  const nudges = snapshot.context.log.filter((entry) => entry.unit === "T1.1" && entry.reason === NO_READY)
  expect(nudges.map((entry) => [entry.from, entry.to])).toEqual([
    ["building", "building"],
    ["building", "building"],
  ])
  // After the last nudge the third turn runs with the nudge message.
  yield* move(setup, actor, "T1.1")
})

it.live(
  "[SV12] an idle builder is nudged with nudge 1, then nudge 2; when it then calls task_ready, task.ready names its head and the proof runs on that head",
  () =>
    Effect.gen(function* () {
      const given = yield* building((worktree, self) => [
        // The attempt and the first nudge: the builder writes and ends its turn without task_ready.
        () => write(worktree, "src/commit.ts", "export const parse = (text: string) => text\n"),
        () => write(worktree, "src/commit.ts", "// still working\n"),
        // After the last nudge: a test of T1.1.c1, then task_ready.
        (prompt) =>
          write(
            worktree,
            "test/commit.test.ts",
            [
              'import { expect, test } from "bun:test"',
              'test("[T1.1.c1] a valid header gives its type", () => {',
              "  expect(1).toBe(1)",
              "})",
              "",
            ].join("\n"),
          ).pipe(Effect.andThen(self().send({ type: "hook.ready", session: prompt.session, summary: "c1 done" }))),
      ])
      const { setup, actor, quiet, begun, tests, root } = given
      yield* nudgedTwice(given)

      // task_ready after the last nudge: the work is committed and task.ready names the head.
      yield* stored(setup.id, 3)
      yield* quiet
      const ready = (yield* storedFacts(setup.id))[2]
      if (ready?.type !== "task.ready") throw new Error(`not task.ready: ${ready?.type}`)
      const head = yield* TaskWorkspace.commit(begun.tree.worktree, LIMITS, "HEAD")
      expect(ready).toMatchObject({ type: "task.ready", task: "T1.1", head })
      expect(head).not.toBe(begun.tree.base)
      expect(
        yield* TaskWorkspace.git(begun.tree.worktree, LIMITS, "show", `${head}:test/commit.test.ts`).pipe(
          Effect.map((text) => text.includes("[T1.1.c1]")),
        ),
      ).toBe(true)
      expect(TaskEngineXState.view(yield* setup.recorder.actor.getSnapshot).tasks["T1.1"]?.head).toBe(head)

      // The proof runs on the builder's head: the real proof runner in the worktree at that head.
      yield* move(setup, actor, "T1.1")
      yield* stored(setup.id, 4)
      yield* quiet
      const recorded = yield* storedFacts(setup.id)
      expect(recorded.map((fact) => fact.type)).toEqual(["task.nudged", "task.nudged", "task.ready", "task.proved"])
      const proved = recorded[3]
      if (proved?.type !== "task.proved") throw new Error("not task.proved")
      // The test that exists only in the head passed (the verifier judges it next); the others have no test there.
      expect(proved.results.find((item) => item.id === "T1.1.c1")).toEqual({ id: "T1.1.c1", status: "needs-judge" })
      for (const obligation of tests.filter((item) => item.id !== "T1.1.c1"))
        expect(proved.results.find((item) => item.id === obligation.id)).toEqual({
          id: obligation.id,
          status: "failed",
          reason: `no test titled [${obligation.id}]`,
        })
      // The proof's own log: the real bun test run in the worktree, which ran the head's test.
      const log = fs.readFileSync(path.join(root, ".opencode", "task", "proofs", "T1.1.log"), "utf8")
      expect(log).toContain("$ bun --no-env-file test --reporter=junit")
      expect(log).toContain("[T1.1.c1]")
      // The builder ended with task_ready, so no proof says it did not.
      expect(proved.reason).toBeUndefined()
      expect(JSON.stringify(proved)).not.toContain(NO_READY)
      // The prompts: the attempt, then the nudge message twice.
      expect(setup.seen.prompts.map((item) => item.text.split("\n")[0])).toEqual([
        ATTEMPT,
        TaskSessions.nudgeMessage,
        TaskSessions.nudgeMessage,
      ])
    }),
  120_000,
)

it.live(
  "[SV12] an idle builder is nudged with nudge 1, then nudge 2; when the third turn also ends idle, its work is committed and the task records 'the builder ended without task_ready'",
  () =>
    Effect.gen(function* () {
      const given = yield* building((worktree) => [
        () => write(worktree, "src/commit.ts", "export const parse = (text: string) => text\n"),
        () => write(worktree, "src/commit.ts", "// still working\n"),
        () => write(worktree, "src/commit.ts", "// almost there\n"),
      ])
      const { setup, quiet, begun, tests } = given
      yield* nudgedTwice(given)

      // The third turn ends idle too: no third nudge. The work is committed, task.ready names its head, and the proof
      // fails every test obligation with the builder's missing task_ready.
      yield* stored(setup.id, 4)
      yield* quiet
      const recorded = yield* storedFacts(setup.id)
      expect(recorded.map((fact) => fact.type)).toEqual(["task.nudged", "task.nudged", "task.ready", "task.proved"])
      const head = yield* TaskWorkspace.commit(begun.tree.worktree, LIMITS, "HEAD")
      expect(recorded[2]).toMatchObject({ type: "task.ready", task: "T1.1", head })
      expect(
        yield* TaskWorkspace.git(begun.tree.worktree, LIMITS, "show", `${head}:src/commit.ts`).pipe(
          Effect.map((text) => text.includes("almost there")),
        ),
      ).toBe(true)
      expect(recorded[3]).toEqual({
        type: "task.proved",
        at: recorded[3]?.at ?? 0,
        task: "T1.1",
        reason: NO_READY,
        results: tests.map((item) => ({ id: item.id, status: "failed", reason: NO_READY })),
      })
      expect(TaskWorkers.NO_READY).toBe(NO_READY)
      // The fold: the failed proof sends T1.1 back to building for attempt 2, with every test obligation reopened.
      yield* eventually(
        Effect.map(
          setup.recorder.actor.getSnapshot,
          (snapshot) => TaskEngineXState.view(snapshot).tasks["T1.1"]?.attempts === 2,
        ),
        "T1.1 attempt 2",
      )
      const snapshot = yield* setup.recorder.actor.getSnapshot
      expect(TaskEngineXState.unitState(snapshot, "T1.1")).toBe("building")
      for (const item of tests)
        expect(TaskEngineXState.view(snapshot).obligations[item.id]).toMatchObject({
          state: "failed",
          reason: NO_READY,
        })
      expect(setup.seen.prompts.map((item) => item.text.split("\n")[0])).toEqual([
        ATTEMPT,
        TaskSessions.nudgeMessage,
        TaskSessions.nudgeMessage,
      ])
    }),
  120_000,
)
