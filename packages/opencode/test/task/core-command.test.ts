import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, FileSystem, Layer, Option, Path } from "effect"
import path from "path"
import { assign, setup } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact, Plan } from "@/task/core/model"
import type { TaskOps } from "@/task/core/ops"
import { TaskWorkspace } from "@/task/core/workspace"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskLimits } from "@/task/limits"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, trustLeaf } from "./lib/machine"
import { boundary, eventually } from "./lib/supervise"

// `/task` (spine AD-8, AD-19, AD-6). A refusal needs no session runtime, so the ops only record the reply. A run
// needs the services the command resolves: the session side comes from a scripted boundary and the background jobs
// from a registry that records each start; the event store, the database and the harness root are real.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))
const limits = TaskLimits.scripted
const SPEC = "task-formats/blend/release-notes.spec"
const source = path.resolve(import.meta.dir, "../../../..", SPEC)
const SESSION = SessionID.make("ses_task_command")

const git = (cwd: string, ...args: ReadonlyArray<string>) => TaskWorkspace.git(cwd, limits, ...args)

// A committed copy of the release-notes spec and one tracked source file in the instance's repository.
const seeded = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = (yield* TestInstance).directory
  yield* fs.copy(source, path.join(directory, SPEC))
  yield* fs.writeFileString(path.join(directory, "app.ts"), "export const app = 1\n")
  yield* git(directory, "add", "-A")
  yield* git(directory, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "seed")
  return directory
})

// What the background job registry saw, and how it answers a start.
interface Jobs {
  readonly starts: Array<BackgroundJob.StartInput>
  mode: "start" | "fail" | "elsewhere"
  status: BackgroundJob.Status
}

const jobsOf = (): Jobs => ({ starts: [], mode: "start", status: "running" })

// The job registry: it records each start and runs nothing.
const backgroundOf = (jobs: Jobs): BackgroundJob.Interface => ({
  list: () => Effect.succeed([]),
  get: (id) =>
    Effect.succeed(
      jobs.starts.some((start) => start.id === id)
        ? { id, type: "task-harness", status: jobs.status, started_at: 0 }
        : undefined,
    ),
  start: (input) =>
    jobs.mode === "fail"
      ? Effect.die(new Error("the background job did not start"))
      : Effect.sync(() => {
          jobs.starts.push(input)
          // A job of that id already running answers with its own info, not this start's.
          return {
            id: input.id ?? "",
            type: input.type,
            status: "running" as const,
            started_at: 0,
            metadata: jobs.mode === "elsewhere" ? {} : input.metadata,
          }
        }),
  extend: () => Effect.succeed(false),
  wait: () => Effect.succeed({ timedOut: true }),
  waitForPromotion: () => Effect.die(new Error("no promotion in a test")),
  promote: () => Effect.succeed(undefined),
  cancel: () => Effect.succeed(undefined),
})

// The services `/task` resolves for a run.
const services = (jobs: Jobs) => {
  const { env } = boundary([])
  return Layer.mergeAll(
    Layer.succeed(Session.Service, env.sessions),
    Layer.succeed(SessionStatus.Service, env.status),
    Layer.succeed(InstanceStore.Service, env.instances),
    Layer.succeed(BackgroundJob.Service, backgroundOf(jobs)),
  )
}

// `/task <args>` in the instance: the replies it sent.
const runTask = (harness: TaskHarness.Interface, args: string = SPEC, jobs: Jobs = jobsOf()) =>
  Effect.gen(function* () {
    const replies: string[] = []
    const ops: TaskOps.Ops = {
      // The reply's message is not read.
      prompt: (input) =>
        Effect.sync(() => {
          replies.push(input.parts.map((part) => part.text).join(""))
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the command never reads the reply message, and a real WithParts needs a stored session
          return {} as SessionV1.WithParts
        }),
      cancel: () => Effect.void,
      currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
    }
    yield* TaskCommand.run({ sessionID: SESSION, arguments: args }, ops, harness).pipe(Effect.provide(services(jobs)))
    return replies
  })

const statusFile = (directory: string) => path.join(directory, ".opencode", "task", "status.json")

const refusalOf = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const status = JSON.parse(yield* fs.readFileString(statusFile(directory)))
    return status.run
  })

const BUSY =
  "Not started: the run of task-formats/blend/release-notes.spec is live in this directory (/task task-formats/blend/release-notes.spec). One run at a time: wait for it to end, or stop it in its own session with ctrl+x w, then esc twice."

describe("/task on a root checkout that cannot take a run", () => {
  it.instance(
    "refuses a tracked change and names it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* seeded
        yield* fs.writeFileString(path.join(directory, "app.ts"), "export const app = 2\n")

        const replies = yield* runTask(yield* TaskHarness.make)

        expect(replies).toEqual([
          `Task harness: refused ${SPEC}: the checkout has uncommitted changes or untracked files: app.ts`,
        ])
        expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC })
      }),
    { git: true },
  )

  it.instance(
    "refuses a detached HEAD",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        yield* git(directory, "switch", "-q", "--detach", "HEAD")

        const replies = yield* runTask(yield* TaskHarness.make)

        expect(replies).toEqual([`Task harness: refused ${SPEC}: the checkout is not on a branch (detached HEAD)`])
        expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC })
      }),
    { git: true },
  )
})

describe("one run per directory (AD-19, SV8)", () => {
  it.instance(
    "with a run live, a valid spec gets one busy line naming the live run, writes no file and starts nothing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        yield* harness.claim({ directory, runID: "task_live", spec: SPEC, path: SPEC })
        const jobs = jobsOf()
        expect(yield* runTask(harness, SPEC, jobs)).toEqual([BUSY])
        expect(jobs.starts).toEqual([])
        expect(yield* fs.exists(statusFile(directory))).toBe(false)
        // The same line answers a second /task of another path of the spec.
        expect(yield* runTask(harness, `${SPEC}/T1-release-notes.task`, jobs)).toEqual([BUSY])
      }),
    { git: true },
  )

  it.instance(
    "with a run live, a loader refusal and a task-folder refusal answer in the session only",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        yield* harness.claim({ directory, runID: "task_live", spec: SPEC, path: SPEC })
        expect(yield* runTask(harness, "nowhere")).toEqual([
          "Task harness: refused nowhere: R1 nowhere: not inside a `<slug>.spec` folder",
        ])
        // The acceptance folder loads, and is not a task folder.
        expect(yield* runTask(harness, `${SPEC}/acceptance`)).toEqual([
          `Task harness: refused ${SPEC}/acceptance: R2 acceptance: not a \`<task id>-<slug>.task\` folder`,
        ])
        expect(yield* fs.exists(statusFile(directory))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "starts the job as the run id under the root session and claims the lease with the normalised path",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        const jobs = jobsOf()
        const replies = yield* runTask(harness, `./${SPEC}/`, jobs)
        expect(replies).toEqual([
          `Task harness: running ./${SPEC}/ in the background. Its status is in .opencode/task/status.json.`,
        ])
        const id = TaskEvents.runID(directory, SPEC)
        expect(jobs.starts).toHaveLength(1)
        expect(jobs.starts[0]).toMatchObject({
          id,
          type: "task-harness",
          title: `/task ./${SPEC}/`,
          metadata: { parentSessionId: SESSION },
        })
        // `./spec/`, `spec/` and `spec` name one run: the lease holds the normalised path.
        expect(yield* harness.live(directory)).toEqual(Option.some({ runID: id, spec: SPEC, path: SPEC }))
        expect(yield* runTask(harness, SPEC, jobs)).toEqual([BUSY])
        expect(jobs.starts).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "frees the claim of a job that did not start, so the next /task is not busy",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        const jobs = jobsOf()
        jobs.mode = "fail"
        const failed = yield* Effect.exit(runTask(harness, SPEC, jobs))
        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* harness.live(directory)).toEqual(Option.none())
        jobs.mode = "start"
        expect((yield* runTask(harness, SPEC, jobs))[0]).toStartWith("Task harness: running")
        expect(jobs.starts).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "frees this call's claim when a job of that id is already running",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        const jobs = jobsOf()
        jobs.mode = "elsewhere"
        expect(yield* runTask(harness, SPEC, jobs)).toEqual([`Task harness: the run of ${SPEC} is already going on.`])
        expect(yield* harness.live(directory)).toEqual(Option.none())
      }),
    { git: true },
  )

  it.instance(
    "answers busy to the second of two calls that both passed the live check, and keeps the first claim",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        // The first call has claimed after this call read the lease as free.
        yield* harness.claim({ directory, runID: "task_first", spec: SPEC, path: SPEC })
        const stale: TaskHarness.Interface = { ...harness, live: () => Effect.succeed(Option.none()) }
        const jobs = jobsOf()
        expect(yield* runTask(stale, SPEC, jobs)).toEqual([BUSY])
        expect(jobs.starts).toEqual([])
        expect(yield* harness.live(directory)).toEqual(Option.some({ runID: "task_first", spec: SPEC, path: SPEC }))
      }),
    { git: true },
  )

  it.instance(
    "SV20 records /task trust on the directory aggregate, then forwards it to the live run of the directory",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        const listener = setup({
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- xstate reads `types` for its type parameters only
          types: {} as { context: { trusts: ReadonlyArray<string> }; events: { type: "run.trust"; id: string } },
        }).createMachine({
          context: { trusts: [] },
          on: { "run.trust": { actions: assign({ trusts: ({ context, event }) => [...context.trusts, event.id] }) } },
        })
        yield* harness.claim({ directory, runID: "task_live", spec: SPEC, path: SPEC })
        yield* harness.spawnRun("task_live", listener)
        expect(yield* runTask(harness, "trust T9")).toEqual([
          "Task harness: recorded the outside precondition T9 as trusted.",
        ])
        const db = yield* Database.Service
        const recorded = yield* TaskEvents.read(db.db, TaskEvents.directoryID(directory))
        expect(TaskEvents.trustedOutside(recorded)).toEqual(["T9"])
        yield* eventually(
          Effect.gen(function* () {
            const ref = yield* harness.system.get("run:task_live")
            if (Option.isNone(ref)) return false
            return JSON.stringify((yield* ref.value.getSnapshot).context).includes('"T9"')
          }),
          "the live run got the trust",
        )
      }),
    { git: true },
  )
})

const WHOLE = "task-formats/blend/release-notes.spec"
const SUBTREE = `${WHOLE}/T1-release-notes.task/T1.5-issue-links.task`

describe("the slice a /task starts from (SV3, RM8, SV26)", () => {
  it.live("RM8b resumes an old slice with no path and no end for the whole spec, written any way", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const stored: ReadonlyArray<Fact> = [f.runStarted(), f.started("T1.1")]
      expect(yield* TaskCommand.sliceOf(plan, stored, WHOLE)).toEqual({ kind: "resume", facts: stored })
      const paths = yield* Path.Path
      const directory = "/repo"
      for (const written of [WHOLE, `${WHOLE}/`, `./${WHOLE}`, `./${WHOLE}/`])
        expect(TaskCommand.normalizedPath(paths, directory, paths.resolve(directory, written))).toBe(WHOLE)
    }),
  )

  it.live("SV3 resumes the slice of the same path and starts a new slice for another path", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const subtree: ReadonlyArray<Fact> = [f.runStarted(SUBTREE), f.started("T1.1")]
      expect(yield* TaskCommand.sliceOf(plan, subtree, SUBTREE)).toEqual({ kind: "resume", facts: subtree })
      expect(yield* TaskCommand.sliceOf(plan, subtree, WHOLE)).toEqual({ kind: "new", died: Option.none() })
      // Only the latest slice counts: an earlier one of the same path does not resume.
      const later: ReadonlyArray<Fact> = [...subtree, f.runStarted(WHOLE)]
      expect(yield* TaskCommand.sliceOf(plan, later, SUBTREE)).toEqual({ kind: "new", died: Option.none() })
      expect(yield* TaskCommand.sliceOf(plan, [], WHOLE)).toEqual({ kind: "new", died: Option.none() })
    }),
  )

  it.live("RM8a starts a new slice after a stored stop", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      for (const stop of [f.cancelled("user stop"), f.ended("failed", "wall clock")])
        expect(yield* TaskCommand.sliceOf(plan, [f.runStarted(WHOLE), stop], WHOLE)).toEqual({
          kind: "new",
          died: Option.none(),
        })
    }),
  )

  it.live("RM8c starts a new slice after a slice whose fold is done with no stop", () =>
    Effect.gen(function* () {
      // The subtree of the leaf T1.1: T1.1, the scenarios that need only it, and the spec's outside preconditions.
      const plan = yield* loadPlan("release-notes.spec", "T1.1")
      expect(plan.scenarios.map((item) => item.id)).toEqual(["S2", "S7"])
      const f = facts()
      const stored: ReadonlyArray<Fact> = [
        f.runStarted(plan.path),
        f.outside("T8"),
        f.outside("T9"),
        ...trustLeaf(plan, f, "T1.1"),
        ...["S2", "S7"].flatMap((id) => [
          f.scenarioProved(id, "passed"),
          f.scenarioVerified({ id, verdict: "trusted" }),
        ]),
      ]
      expect(TaskEngineXState.ended(TaskEvents.fold(TaskEngineXState.XStateEngine, plan, stored))).toBe(true)
      expect(yield* TaskCommand.sliceOf(plan, stored, plan.path)).toEqual({ kind: "new", died: Option.none() })
    }),
  )

  it.live("folds a slice that names an id the spec dropped without a throw, and resumes it", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const stored: ReadonlyArray<Fact> = [f.runStarted(WHOLE), f.started("T1.9"), f.started("T1.1")]
      expect(yield* TaskCommand.sliceOf(plan, stored, WHOLE)).toEqual({ kind: "resume", facts: stored })
    }),
  )

  it.live("SV26 counts a slice whose fold dies as ended, names the defect, and starts a new slice", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      // Two tasks with one id: the run machine of this plan cannot be built, so the fold dies.
      const broken: Plan = { ...plan, tasks: [...plan.tasks, ...plan.tasks.slice(0, 1)] }
      const slice = yield* TaskCommand.sliceOf(broken, [facts().runStarted(WHOLE)], WHOLE)
      expect(slice.kind).toBe("new")
      expect(slice.kind === "new" && Option.isSome(slice.died)).toBe(true)
    }),
  )
})

describe("the job of a run (AD-8, SV4, SV21, SV27)", () => {
  // The job of a whole-spec run in the seeded repository: its harness, its fiber, and the job registry's answer.
  const started = Effect.fnUntraced(function* (directory: string) {
    const harness = yield* TaskHarness.make
    const plan = yield* loadPlan("release-notes.spec")
    const id = TaskEvents.runID(directory, SPEC)
    const claimed = yield* harness.claim({ directory, runID: id, spec: SPEC, path: SPEC })
    if (claimed.kind !== "claimed") return yield* Effect.die(new Error("not claimed"))
    const jobs = jobsOf()
    jobs.starts.push({ id, type: "task-harness", run: Effect.succeed("") })
    const { env } = boundary([])
    const background = backgroundOf(jobs)
    const events = yield* EventV2Bridge.Service
    const db = yield* Database.Service
    const fiber = yield* Effect.forkChild(
      TaskCommand.job({
        harness,
        env: { ...env, events, db: db.db, background },
        id,
        directory,
        base: "dev",
        specDir: path.join(directory, SPEC),
        plan: { ...plan, specPath: SPEC, path: SPEC },
        path: SPEC,
        slice: { kind: "new", died: Option.none() },
        root: SESSION,
        model: { providerID: "test", modelID: "test" },
        limits,
        locks: claimed.locks,
      }),
    )
    const stored = Effect.gen(function* () {
      return (yield* TaskEvents.read(db.db, id)).map((fact) => fact.type)
    })
    yield* eventually(
      Effect.map(stored, (types) => types.includes("run.started")),
      "run.started",
    )
    return { harness, id, jobs, fiber, stored }
  })

  it.instance(
    "SV4 a cancelled job records run.cancelled, its supervisor closes, and the next /task is not busy (SV21)",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        yield* git(directory, "branch", "-m", "dev")
        const job = yield* started(directory)
        job.jobs.status = "cancelled"
        yield* Fiber.interrupt(job.fiber)
        expect(yield* job.stored).toContain("run.cancelled")
        expect(yield* job.harness.running(job.id)).toBe(false)
        expect(yield* job.harness.live(directory)).toEqual(Option.none())
      }),
    { git: true },
  )

  it.instance(
    "SV27 a scope that closes without a job cancel records nothing more, frees the lease, and leaves the slice open",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        yield* git(directory, "branch", "-m", "dev")
        const job = yield* started(directory)
        yield* Fiber.interrupt(job.fiber)
        expect(yield* job.stored).not.toContain("run.cancelled")
        expect(yield* job.harness.running(job.id)).toBe(false)
        expect(yield* job.harness.live(directory)).toEqual(Option.none())
        // The next /task of the same path resumes: the slice has not ended.
        const db = yield* Database.Service
        const plan = yield* loadPlan("release-notes.spec")
        const slice = yield* TaskCommand.sliceOf(plan, yield* TaskEvents.read(db.db, job.id), SPEC)
        expect(slice.kind).toBe("resume")
      }),
    { git: true },
  )

  it.instance(
    "frees the lease when the job body dies",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        const plan = yield* loadPlan("release-notes.spec")
        const id = TaskEvents.runID(directory, SPEC)
        const claimed = yield* harness.claim({ directory, runID: id, spec: SPEC, path: SPEC })
        if (claimed.kind !== "claimed") return yield* Effect.die(new Error("not claimed"))
        const { env } = boundary([])
        const events = yield* EventV2Bridge.Service
        const db = yield* Database.Service
        // A plan whose run machine cannot be built: the Recorder dies in the job body.
        const broken: Plan = { ...plan, tasks: [...plan.tasks, ...plan.tasks.slice(0, 1)] }
        const exit = yield* Effect.exit(
          TaskCommand.job({
            harness,
            env: { ...env, events, db: db.db },
            id,
            directory,
            base: "dev",
            specDir: path.join(directory, SPEC),
            plan: broken,
            path: SPEC,
            slice: { kind: "new", died: Option.none() },
            root: SESSION,
            model: { providerID: "test", modelID: "test" },
            limits,
            locks: claimed.locks,
          }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* harness.live(directory)).toEqual(Option.none())
        return yield* Effect.void
      }),
    { git: true },
  )
})
