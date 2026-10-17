import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Exit, Layer, Option, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import { TaskHooks } from "@/task/core/hooks"
import type { Fact, Plan } from "@/task/core/model"
import type { TaskOps } from "@/task/core/ops"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { backgroundOf, git, type Jobs, jobsOf, seed, services, SESSION, SPEC } from "./lib/command"
import { facts, loadPlan, trustLeaf } from "./lib/machine"
import { eventually } from "./lib/supervise"

// Scenario SV27 (spec task-harness-feedback, AD-8; tasks T2.8, T2.9, T2.10, T2.11): a server stop leaves the run
// resumable.
//
//   Given a live run with a building task and a verifying scenario
//   When the instance scope closes without a job cancel
//   Then the store holds no run.cancelled, no task.failed and no scenario.verified from the stop, and no summary is
//     written
//   And an interrupted worker never counts as a worker failure
//   And the next /task with the same path records run.resumed
//
// Everything that runs is the real code, in a real instance (a git repository with a committed copy of the
// release-notes spec): `/task` is `TaskCommand.run`, the harness root is real, and the background job is the real
// `TaskCommand.job`: the Recorder over the real event store, its finalizers, the run supervisor, and its real task and
// scenario supervisors with their workers (real worktrees, a builder turn, a judge turn). The model side is scripted:
// a builder's or a judge's turn runs until it is stopped. The job registry is lib/command's, except that it forks each
// job into a scope the test owns, as the instance scope holds a job; closing that scope is the server stop. The
// registry's status of the job stays `running`: nobody cancelled it.
//
// The stored slice resumes with T1.1 trusted and the scenarios that this makes ready proved: S2 passed, so it waits for
// its judge (verifying), and S7 failed, so no scenario proof runs. T1.2 and T1.3 are then ready, and the live run
// builds them.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const HEADER = "Implementing spec **Release notes from conventional commits**"
// The facts a stop must never record.
const STOP_FACTS = ["run.cancelled", "task.failed", "scenario.verified"]
// The phase tags of a unit.
const PHASES = ["ready", "building", "proving", "verifying"]
// The facts that a counted worker failure records.
const FAILURE_FACTS = ["task.failed", "task.needs_human", "task.stalled", "scenario.verified", "run.ended"]

/** The stored slice: run.started on the checkout's branch, T1.1 trusted, S2 proved passed, S7 proved failed. */
const sliceOf = (plan: Plan, branch: string): ReadonlyArray<Fact> => {
  const f = facts(1)
  return [
    { type: "run.started", at: 1, base: branch, path: SPEC },
    ...trustLeaf(plan, f, "T1.1"),
    f.scenarioProved("S2", "passed"),
    f.scenarioProved("S7", "failed", "not run in this test"),
  ]
}

// What the session side saw: the command's replies, each model turn (builder or judge), each cancel and each summary.
interface Seen {
  readonly replies: Array<string>
  readonly turns: Array<{ readonly session: string; readonly agent: string }>
  readonly cancels: Array<string>
  readonly said: Array<string>
}

const opsOf = (seen: Seen): TaskOps.Ops => ({
  prompt: (input) =>
    input.noReply === true
      ? Effect.sync(() => {
          seen.replies.push(input.parts.map((part) => part.text).join("\n"))
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the command never reads the reply message, and a real WithParts needs a stored session
          return {} as SessionV1.WithParts
        })
      : Effect.sync(() => seen.turns.push({ session: input.sessionID, agent: input.agent })).pipe(
          Effect.andThen(Effect.never),
        ),
  cancel: (session) => Effect.sync(() => seen.cancels.push(session)),
  currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
  say: (input) => Effect.sync(() => seen.said.push(input.text)),
})

// The job registry of lib/command, which forks each job it starts into `scope` (the instance's part, for the test).
const registryIn = (jobs: Jobs, scope: Scope.Scope): BackgroundJob.Interface => {
  const registry = backgroundOf(jobs)
  return {
    ...registry,
    start: (input) =>
      Effect.gen(function* () {
        const info = yield* registry.start(input)
        jobs.fibers.push(yield* input.run.pipe(Effect.forkIn(scope)))
        return info
      }),
  }
}

// `/task <spec>` in the instance, its job forked into `scope`.
const runTask = (harness: TaskHarness.Interface, seen: Seen, jobs: Jobs, scope: Scope.Scope) =>
  TaskCommand.run({ sessionID: SESSION, arguments: SPEC }, opsOf(seen), harness).pipe(
    Effect.provideService(BackgroundJob.Service, registryIn(jobs, scope)),
    Effect.provide(services(jobs)),
  )

it.instance(
  "[SV27] a scope close without a job cancel records no stop, counts no worker failure, writes no summary, and the next /task resumes",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
      const plan = yield* loadPlan("release-notes.spec")
      const db = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      const runID = TaskEvents.runID(directory, SPEC)
      const read = TaskEvents.read(db.db, runID)
      const fold = (list: ReadonlyArray<Fact>) => TaskEvents.fold(TaskEngineXState.XStateEngine, plan, list)
      const harness = yield* TaskHarness.make
      for (const fact of sliceOf(plan, branch)) yield* TaskEvents.publish(events, runID, fact)
      const stored = yield* read

      // Given a live run: /task resumes the stored slice as a job held by the instance's scope.
      const instance = yield* Scope.make()
      const jobs = jobsOf()
      const seen: Seen = { replies: [], turns: [], cancels: [], said: [] }
      yield* runTask(harness, seen, jobs, instance)
      expect(seen.replies).toEqual([HEADER])
      expect(jobs.starts.map((start) => start.id)).toEqual([runID])
      expect(jobs.fibers).toHaveLength(1)
      // With a building task and a verifying scenario: T1.2 and T1.3 started and their builder turns run, and S2's
      // judge turn runs.
      const started = (list: ReadonlyArray<Fact>, task: string) =>
        list.some((fact) => fact.type === "task.started" && fact.task === task)
      yield* eventually(
        Effect.map(read, (list) => started(list, "T1.2") && started(list, "T1.3")),
        "T1.2 and T1.3 start",
      )
      yield* eventually(
        Effect.sync(
          () =>
            seen.turns.filter((turn) => turn.agent === TaskHooks.BUILDER).length === 2 &&
            seen.turns.some((turn) => turn.agent === TaskHooks.VERIFIER),
        ),
        "two builder turns and a judge turn run",
      )
      const before = yield* read
      expect(before.slice(0, stored.length)).toEqual([...stored])
      expect(before[stored.length]).toMatchObject({ type: "run.resumed", path: SPEC })
      const live = fold(before)
      expect(TaskEngineXState.unitState(live, "T1.2")).toBe("building")
      expect(TaskEngineXState.unitState(live, "T1.3")).toBe("building")
      expect(live.hasTag("S2:verifying")).toBe(true)
      expect(yield* harness.system.get(TaskHarness.systemId.task(runID, "T1.2"))).toSatisfy(Option.isSome)
      expect(yield* harness.system.get(TaskHarness.systemId.scenario(runID, "S2"))).toSatisfy(Option.isSome)
      const turns = seen.turns.length

      // When the instance scope closes without a job cancel: the job is interrupted, its status stays `running`.
      yield* Scope.close(instance, Exit.void).pipe(Effect.timeout("60 seconds"))
      expect(jobs.status).toBe("running")
      // The run's actors are gone and the lease is free.
      expect(yield* harness.running(runID)).toBe(false)
      expect(yield* harness.live(directory)).toEqual(Option.none())
      yield* Effect.sleep(500)

      // Then the store holds no run.cancelled, no task.failed and no scenario.verified from the stop.
      const after = yield* read
      expect(after.slice(0, before.length)).toEqual([...before])
      const fromStop = after.slice(before.length)
      expect(fromStop.filter((fact) => STOP_FACTS.includes(fact.type))).toEqual([])
      // And no summary is written.
      expect(seen.said).toEqual([])
      // And an interrupted worker never counts as a worker failure: no failure fact and no harness error is
      // recorded, no worker is tried again (no new turn), and the units keep their states and attempts.
      expect(fromStop.filter((fact) => FAILURE_FACTS.includes(fact.type))).toEqual([])
      expect(JSON.stringify(fromStop)).not.toContain("harness error")
      expect(seen.turns).toHaveLength(turns)
      const stopped = fold(after)
      expect(TaskEngineXState.ended(stopped)).toBe(false)
      const phase = (snapshot: typeof live, unit: string) => ({
        state: TaskEngineXState.unitState(snapshot, unit),
        phases: PHASES.filter((tag) => snapshot.hasTag(`${unit}:${tag}`)),
      })
      for (const unit of ["T1.2", "T1.3", "S2"]) expect(phase(stopped, unit)).toEqual(phase(live, unit))
      expect(TaskEngineXState.view(stopped).tasks["T1.2"]?.attempts).toBe(
        TaskEngineXState.view(live).tasks["T1.2"]?.attempts,
      )
      expect(TaskEngineXState.view(stopped).tasks["T1.3"]?.attempts).toBe(
        TaskEngineXState.view(live).tasks["T1.3"]?.attempts,
      )
      // The slice stays open: a /task of the same path resumes it.
      expect(yield* TaskCommand.sliceOf(plan, after, SPEC)).toEqual({
        kind: "resume",
        facts: Option.getOrThrow(TaskEvents.latestRun(after)),
      })

      // And the next /task with the same path records run.resumed (in the same slice).
      const next = yield* Scope.make()
      const nextJobs = jobsOf()
      const nextSeen: Seen = { replies: [], turns: [], cancels: [], said: [] }
      yield* runTask(harness, nextSeen, nextJobs, next)
      expect(nextSeen.replies).toEqual([HEADER])
      yield* eventually(
        Effect.map(read, (list) => list.slice(after.length).some((fact) => fact.type === "run.resumed")),
        "the next /task records run.resumed",
      )
      const resumed = (yield* read).slice(after.length)
      expect(resumed[0]).toMatchObject({ type: "run.resumed", path: SPEC })
      expect(resumed.some((fact) => fact.type === "run.started")).toBe(false)
      expect(TaskEvents.slices(yield* read)).toHaveLength(1)
      // The units go on where the stop left them: T1.2 and T1.3 are building again in their stored sessions.
      yield* eventually(
        Effect.sync(() => nextSeen.turns.filter((turn) => turn.agent === TaskHooks.BUILDER).length === 2),
        "the resumed builder turns",
      )
      const building = before
        .flatMap((fact) =>
          fact.type === "task.started" && (fact.task === "T1.2" || fact.task === "T1.3") ? [fact.session] : [],
        )
        .toSorted()
      expect(building).toHaveLength(2)
      expect(
        nextSeen.turns
          .filter((turn) => turn.agent === TaskHooks.BUILDER)
          .map((turn) => turn.session)
          .toSorted(),
      ).toEqual(building)
      yield* Scope.close(next, Exit.void).pipe(Effect.timeout("60 seconds"))
    }),
  { git: true },
  120_000,
)
