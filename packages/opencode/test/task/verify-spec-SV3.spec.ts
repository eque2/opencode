import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Exit, FileSystem, Layer, Option, Schema, Scope } from "effect"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact } from "@/task/core/model"
import type { TaskOps } from "@/task/core/ops"
import { TaskStatus } from "@/task/core/status"
import { TaskWorkspace } from "@/task/core/workspace"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { git, SESSION, seed, SPEC, statusFile } from "./lib/command"
import { boundary, eventually } from "./lib/supervise"

// Scenario SV3 (spec task-harness-feedback, owner ruling 3, AD-6, AD-19; tasks T2.2, T2.10, T2.11): a run resumes only
// by the same path.
//
//   Given a stored slice that has not ended, started by /task with a path
//   When /task runs again with the same path
//   Then the slice is folded, run.resumed is recorded with that path, and the supervisor starts what the folded state
//     asks for
//   And /task with a different path, or after the slice ended, starts a new slice
//
// Everything runs on the real `/task` command: the loader, the slice choice, the harness root and its lease, the real
// background job registry of opencode core, the job, the Recorder over the real event store and the real supervisors
// and workers, in a git instance seeded with the release-notes spec. Only the model side is scripted: a reply in the
// root session ends at once, and a builder or judge turn runs until the run stops it. A job ends either by a cancel
// of the registry (the slice ends with run.cancelled) or by closing the registry's scope, as a server stop does (the
// slice stays open, SV27).

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const T11_FOLDER = `${SPEC}/T1-release-notes.task/T1.1-commit-parser.task`
const STORED_SESSION = "ses_T1.1"

// What the session side saw: replies in the root session, and each child-session prompt.
interface Seen {
  readonly replies: Array<string>
  readonly prompts: Array<{ readonly session: string; readonly text: string }>
}

const opsOf = (seen: Seen): TaskOps.Ops => ({
  prompt: (input) =>
    input.sessionID === SESSION
      ? Effect.sync(() => {
          seen.replies.push(input.parts.map((part) => part.text).join("\n"))
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the command never reads the reply message
          return {} as SessionV1.WithParts
        })
      : Effect.sync(() => seen.prompts.push({ session: input.sessionID, text: input.parts[0]?.text ?? "" })).pipe(
          Effect.andThen(Effect.never),
        ),
  cancel: () => Effect.void,
  currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
  say: () => Effect.void,
})

// A real job registry in its own scope: closing the scope is a server stop, which interrupts the job uncancelled.
const registryOf = Effect.gen(function* () {
  const scope = yield* Scope.make()
  const registry = yield* CoreBackgroundJob.make.pipe(Scope.provide(scope))
  return { registry, stop: Scope.close(scope, Exit.void) }
})

// `/task <args>` on the real command with the scripted session boundary and the given job registry.
const task = (harness: TaskHarness.Interface, registry: BackgroundJob.Interface, args: string, seen: Seen) => {
  const { env } = boundary([])
  return TaskCommand.run({ sessionID: SESSION, arguments: args }, opsOf(seen), harness).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Session.Service, env.sessions),
        Layer.succeed(SessionStatus.Service, env.status),
        Layer.succeed(InstanceStore.Service, env.instances),
        Layer.succeed(BackgroundJob.Service, registry),
      ),
    ),
  )
}

// The scripted bounds for the run that `/task` starts (`TaskLimits.load` reads the variable), restored afterwards.
const scriptedLimits = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[TaskLimits.variable]
      process.env[TaskLimits.variable] = "scripted"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[TaskLimits.variable]
        else process.env[TaskLimits.variable] = previous
      }),
  )

// The seeded instance, and a stored slice that has not ended: /task <spec> started it, and T1.1 builds in a real
// worktree with its builder session.
const givenOpenSlice = Effect.gen(function* () {
  const directory = yield* seed(SPEC)
  const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
  const id = TaskEvents.runID(directory, SPEC)
  const tree = yield* TaskWorkspace.ensureWorktree(directory, id, "T1.1", branch, TaskLimits.scripted)
  const slice: ReadonlyArray<Fact> = [
    { type: "run.started", at: 1, base: branch, path: SPEC },
    {
      type: "task.started",
      at: 2,
      task: "T1.1",
      worktree: tree.worktree,
      branch: tree.branch,
      base: tree.base,
      session: STORED_SESSION,
    },
  ]
  const events = yield* EventV2Bridge.Service
  for (const fact of slice) yield* TaskEvents.publish(events, id, fact)
  const db = yield* Database.Service
  const stored = TaskEvents.read(db.db, id)
  return { directory, branch, id, tree, slice, stored }
})

const decodeStatus = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))

it.instance(
  "[SV3] /task with the same path folds the open slice, records run.resumed with that path, and the supervisor starts what the folded state asks for",
  () =>
    scriptedLimits(
      Effect.gen(function* () {
        const given = yield* givenOpenSlice
        const harness = yield* TaskHarness.make
        const { registry, stop } = yield* registryOf
        const seen: Seen = { replies: [], prompts: [] }

        // The same path, written another way: `./<spec>/` names the slice's `<spec>`.
        yield* task(harness, registry, `./${SPEC}/`, seen)
        expect(seen.replies).toEqual(["Implementing spec **Release notes from conventional commits**"])
        yield* eventually(
          Effect.map(given.stored, (list) => list.some((fact) => fact.type === "run.resumed")),
          "run.resumed",
        )
        // run.resumed with the normalised path follows the stored slice: no new slice started.
        const afterResume = yield* given.stored
        expect(afterResume.slice(0, 2)).toEqual([...given.slice])
        expect(afterResume[2]).toMatchObject({ type: "run.resumed", path: SPEC, base: given.branch })
        expect(afterResume.filter((fact) => fact.type === "run.started")).toHaveLength(1)

        // The slice is folded: the run's status carries the stored slice's history and T1.1's stored worktree.
        const fs = yield* FileSystem.FileSystem
        yield* eventually(
          Effect.map(
            fs.readFileString(statusFile(given.directory)).pipe(Effect.orElseSucceed(() => "")),
            (text) => text.includes('"T1.1"') && text.includes('"building"'),
          ),
          "status.json of the resumed run",
        )
        const status = decodeStatus(yield* fs.readFileString(statusFile(given.directory)))
        expect(status.run.path).toBe(SPEC)
        expect(status.tasks["T1.1"]).toMatchObject({ state: "building", attempts: 1, worktree: given.tree.worktree })
        expect(status.history).toEqual(
          expect.arrayContaining([expect.objectContaining({ at: 2, unit: "T1.1", to: "building" })]),
        )

        // The supervisor starts what the folded state asks for. T1.1 builds: its supervisor claims the stored builder
        // session and prompts it again, and T1.1 is not begun again. T1.2 is ready: it begins in a new session.
        // T1.3 waits on T1.1: it gets no supervisor.
        yield* eventually(
          Effect.sync(() => seen.prompts.some((prompt) => prompt.session === STORED_SESSION)),
          "a builder turn in the stored T1.1 session",
        )
        expect(yield* harness.ownerOf(STORED_SESSION)).toEqual(
          Option.some({ owner: TaskHarness.systemId.task(given.id, "T1.1"), watch: true }),
        )
        yield* eventually(
          Effect.map(given.stored, (list) => list.some((fact) => fact.type === "task.started" && fact.task === "T1.2")),
          "task.started T1.2",
        )
        const started = (yield* given.stored).filter((fact) => fact.type === "task.started")
        expect(started.map((fact) => (fact.type === "task.started" ? fact.task : ""))).toEqual(["T1.1", "T1.2"])
        const t12 = started[1]
        expect(t12?.type === "task.started" ? t12.session : "").not.toBe(STORED_SESSION)
        expect(Option.isSome(yield* harness.system.get(TaskHarness.systemId.task(given.id, "T1.1")))).toBe(true)
        expect(Option.isSome(yield* harness.system.get(TaskHarness.systemId.task(given.id, "T1.2")))).toBe(true)
        expect(Option.isNone(yield* harness.system.get(TaskHarness.systemId.task(given.id, "T1.3")))).toBe(true)

        // A server stop ends the job and leaves the slice open: no stop is stored.
        yield* stop
        expect((yield* given.stored).map((fact) => fact.type)).not.toContain("run.cancelled")
        expect(yield* harness.live(given.directory)).toEqual(Option.none())
      }),
    ),
  { git: true },
  90_000,
)

it.instance(
  "[SV3] /task with a different path starts a new slice, and so does /task with the same path after the slice ended",
  () =>
    scriptedLimits(
      Effect.gen(function* () {
        const given = yield* givenOpenSlice
        const harness = yield* TaskHarness.make
        const { registry } = yield* registryOf
        const seen: Seen = { replies: [], prompts: [] }
        const runStarts = Effect.map(given.stored, (list) =>
          list.flatMap((fact) => (fact.type === "run.started" ? [fact.path ?? ""] : [])),
        )

        // A different path while the stored slice is still open: a new slice, never a resume.
        yield* task(harness, registry, T11_FOLDER, seen)
        expect(seen.replies[0]).toStartWith("Implementing **T1.1 ")
        yield* eventually(
          Effect.map(runStarts, (paths) => paths.length === 2),
          "the new slice's run.started",
        )
        expect(yield* runStarts).toEqual([SPEC, T11_FOLDER])
        // The new slice folds from nothing: T1.1 is ready again and begins in a new session, not the stored one.
        yield* eventually(
          Effect.map(given.stored, (list) => list.filter((fact) => fact.type === "task.started").length === 2),
          "task.started T1.1 in the new slice",
        )
        const begun = (yield* given.stored).filter((fact) => fact.type === "task.started").at(-1)
        expect(begun).toMatchObject({ type: "task.started", task: "T1.1" })
        expect(begun?.type === "task.started" ? begun.session : STORED_SESSION).not.toBe(STORED_SESSION)

        // The job is cancelled: the new slice ends with run.cancelled.
        yield* registry.cancel(given.id)
        const types = (yield* given.stored).map((fact) => fact.type)
        expect(types.lastIndexOf("run.cancelled")).toBeGreaterThan(types.lastIndexOf("run.started"))
        expect(yield* harness.live(given.directory)).toEqual(Option.none())

        // The same path after its slice ended: another new slice.
        yield* task(harness, registry, T11_FOLDER, seen)
        yield* eventually(
          Effect.map(runStarts, (paths) => paths.length === 3),
          "the third slice's run.started",
        )
        expect(yield* runStarts).toEqual([SPEC, T11_FOLDER, T11_FOLDER])
        // No /task of this test resumed a slice.
        expect((yield* given.stored).some((fact) => fact.type === "run.resumed")).toBe(false)
        yield* registry.cancel(given.id)
      }),
    ),
  { git: true },
  90_000,
)
