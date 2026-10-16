import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, Predicate } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { EventV2 } from "@opencode-ai/core/event"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact } from "@/task/core/model"
import type { TaskOps } from "@/task/core/ops"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { backgroundOf, git, jobsOf, seed, services, SESSION, SPEC } from "./lib/command"
import { facts, loadPlan, trustLeaf } from "./lib/machine"
import { eventually } from "./lib/supervise"

// Scenario SV25 (spec task-harness-feedback, AD-6, AD-8; tasks T2.10, T2.11): a cancel before the new slice starts
// never lands in the previous slice.
//
//   Given a stored release-notes slice that ended, and a new /task whose run supervisor has not yet stored run.started
//   When the background job is cancelled
//   Then the store holds the new slice's run.started before its run.cancelled
//   And the previous slice folds to the same snapshot as before the cancel
//
// Everything that runs is the real code, in a real instance (a git repository with a committed copy of the
// release-notes spec): `/task` is `TaskCommand.run`, the harness root is real, and the background job runs the real
// `TaskCommand.job` on its own fiber (lib/command, "run" mode): the Recorder over the real event store, its cancel
// finalizer, and the run supervisor spawned as `run:<runID>`. A model turn never ends.
//
// Two seams only observe or delay; neither decides anything. The event store the run is given holds the publish of the
// new slice's `run.started` until the test opens a gate, so the run supervisor stays in its first state (`starting`)
// while the job is cancelled: a slow store. The job registry notes when the job's cancel finalizer reads the cancelled
// status, so the test knows the cancel has reached the job before it lets `run.started` through.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const HEADER = "Implementing spec **Release notes from conventional commits**"

// The parts of a snapshot that a fold decides.
const folded = (snapshot: RunSnapshot) => ({
  status: snapshot.status,
  value: snapshot.value,
  context: snapshot.context,
  view: TaskEngineXState.view(snapshot),
})

// The `/task` command's ops: the replies are recorded; a model turn never ends.
const opsOf = (replies: Array<string>): TaskOps.Ops => ({
  prompt: (input) =>
    input.noReply === true
      ? Effect.sync(() => {
          replies.push(input.parts.map((part) => part.text).join("\n"))
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the command never reads the reply message, and a real WithParts needs a stored session
          return {} as SessionV1.WithParts
        })
      : Effect.never,
  cancel: () => Effect.void,
  currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
  say: () => Effect.void,
})

// Whether an event's data is the stored fact `run.started` on the aggregate `runID`.
const isRunStarted = (data: unknown, runID: string) =>
  Predicate.hasProperty(data, "runID") &&
  data.runID === runID &&
  Predicate.hasProperty(data, "fact") &&
  Predicate.hasProperty(data.fact, "type") &&
  data.fact.type === "run.started"

it.instance(
  "[SV25] a job cancelled before the new slice stores run.started records run.cancelled after it, and the previous slice is unchanged",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
      const plan = yield* loadPlan("release-notes.spec")
      const db = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      const runID = TaskEvents.runID(directory, SPEC)
      const harness = yield* TaskHarness.make
      const read = TaskEvents.read(db.db, runID)
      const fold = (list: ReadonlyArray<Fact>) => TaskEvents.fold(TaskEngineXState.XStateEngine, plan, list)

      // Given a stored release-notes slice that ended: T1.1 trusted, then the run was cancelled.
      const f = facts(1)
      const previous: ReadonlyArray<Fact> = [
        { type: "run.started", at: 1, base: branch, path: SPEC },
        ...trustLeaf(plan, f, "T1.1"),
        f.cancelled("cancelled"),
      ]
      for (const fact of previous) yield* TaskEvents.publish(events, runID, fact)
      const storedBefore = yield* read
      expect(storedBefore).toEqual(previous)
      const before = folded(fold(storedBefore))
      expect(TaskEngineXState.ended(fold(storedBefore))).toBe(true)
      expect(TaskEngineXState.view(fold(storedBefore)).run.state).toBe("cancelled")
      // So a /task of the same path starts a new slice.
      expect(yield* TaskCommand.sliceOf(plan, storedBefore, SPEC)).toEqual({ kind: "new", died: Option.none() })

      // The event store the run gets: it holds the new slice's run.started until the gate opens.
      const gate = yield* Deferred.make<void>()
      const held = yield* Deferred.make<void>()
      const slow: EventV2.Interface = {
        ...events,
        publish: (definition, data, options) =>
          Effect.gen(function* () {
            if (isRunStarted(data, runID)) {
              yield* Deferred.succeed(held, undefined)
              yield* Deferred.await(gate)
            }
            return yield* events.publish(definition, data, options)
          }),
      }
      // The job registry of lib/command; it notes when the job's cancel finalizer reads the cancelled status.
      const jobs = jobsOf()
      jobs.mode = "run"
      const registry = backgroundOf(jobs)
      const seenCancel = yield* Deferred.make<void>()
      const background: BackgroundJob.Interface = {
        ...registry,
        get: (id) =>
          Effect.tap(registry.get(id), (info) =>
            info?.status === "cancelled" ? Deferred.succeed(seenCancel, undefined) : Effect.void,
          ),
      }

      // A new /task of that path: the job starts, and its run supervisor is spawned.
      const replies: Array<string> = []
      yield* TaskCommand.run({ sessionID: SESSION, arguments: SPEC }, opsOf(replies), harness).pipe(
        Effect.provideService(EventV2Bridge.Service, slow),
        Effect.provideService(BackgroundJob.Service, background),
        Effect.provide(services(jobs)),
      )
      expect(replies).toEqual([HEADER])
      expect(jobs.starts.map((start) => start.id)).toEqual([runID])
      expect(jobs.fibers).toHaveLength(1)
      // Its run supervisor has not yet stored run.started: it waits in `starting` on the held publish.
      yield* Deferred.await(held).pipe(Effect.timeout("60 seconds"))
      const supervisor = Option.getOrThrow(yield* harness.system.get(TaskHarness.systemId.run(runID)))
      expect((yield* supervisor.getSnapshot).value).toBe("starting")
      expect(yield* read).toEqual(storedBefore)

      // When the background job is cancelled (as the job registry does: the status, then the fiber's interrupt).
      jobs.status = "cancelled"
      const cancelling = yield* Effect.forkChild(
        Effect.forEach(jobs.fibers, (fiber) => Fiber.interrupt(fiber), { discard: true }),
      )
      // The cancel reached the job: its cancel finalizer read the cancelled status.
      yield* Deferred.await(seenCancel).pipe(Effect.timeout("60 seconds"))
      // While run.started is still held, the cancel records nothing: not in the previous slice, not anywhere.
      yield* Effect.sleep(500)
      expect(yield* read).toEqual(storedBefore)
      expect((yield* supervisor.getSnapshot).value).toBe("starting")

      // The store lets run.started through; the cancel completes.
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(cancelling).pipe(Effect.timeout("60 seconds"))

      // Then the store holds the new slice's run.started before its run.cancelled.
      const after = yield* read
      expect(after.slice(0, storedBefore.length)).toEqual([...storedBefore])
      const added = after.slice(storedBefore.length)
      expect(added[0]).toMatchObject({ type: "run.started", base: branch, path: SPEC })
      const cancels = added.flatMap((fact, index) => (fact.type === "run.cancelled" ? [index] : []))
      expect(cancels).toHaveLength(1)
      expect(cancels[0]).toBeGreaterThan(0)
      expect(added[cancels[0] ?? -1]).toMatchObject({ type: "run.cancelled", reason: "cancelled" })
      expect(added.filter((fact) => fact.type === "run.started")).toHaveLength(1)
      // The store has two slices: the previous one, unchanged, then the new one, which holds the cancel.
      const slices = TaskEvents.slices(after)
      expect(slices).toHaveLength(2)
      expect(slices[0]).toEqual(storedBefore)
      expect(slices[1]).toEqual(added)
      expect([...Option.getOrThrow(TaskEvents.latestRun(after))]).toEqual(added)
      expect(TaskEngineXState.view(fold(added)).run.state).toBe("cancelled")

      // And the previous slice folds to the same snapshot as before the cancel.
      expect(folded(fold(slices[0] ?? []))).toEqual(before)

      // The job ended: the run supervisor is gone and the directory's lease is free.
      expect(yield* harness.running(runID)).toBe(false)
      expect(yield* harness.live(directory)).toEqual(Option.none())
    }),
  { git: true },
  120_000,
)
