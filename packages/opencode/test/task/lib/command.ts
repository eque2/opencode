import { Effect, type Fiber, FileSystem, Layer } from "effect"
import path from "path"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { TaskCommand } from "@/task/core/command"
import type { TaskHarness } from "@/task/core/harness"
import type { TaskOps } from "@/task/core/ops"
import { TaskWorkspace } from "@/task/core/workspace"
import { TaskLimits } from "@/task/limits"
import { TestInstance } from "../../fixture/fixture"
import { boundary } from "./supervise"

// The harness of a `/task` test (spine AD-8, AD-19). A refusal needs no session runtime, so the ops only record the
// reply. A run needs the services the command resolves: the session side comes from a scripted boundary and the
// background jobs from a registry that records each start; the event store, the database and the harness root are
// the test's own.

const limits = TaskLimits.scripted
/** The spec most `/task` tests run: the release-notes fixture. */
export const SPEC = "task-formats/blend/release-notes.spec"
export const SESSION = SessionID.make("ses_task_command")

export const git = (cwd: string, ...args: ReadonlyArray<string>) => TaskWorkspace.git(cwd, limits, ...args)

/** A committed copy of each spec folder of the repository, and one tracked source file, in the instance's repository. */
export const seed = (...specs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = (yield* TestInstance).directory
    for (const spec of specs)
      yield* fs.copy(path.resolve(import.meta.dir, "../../../../..", spec), path.join(directory, spec))
    yield* fs.writeFileString(path.join(directory, "app.ts"), "export const app = 1\n")
    yield* git(directory, "add", "-A")
    yield* git(directory, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "seed")
    return directory
  })

// What the background job registry saw, and how it answers a start.
export interface Jobs {
  readonly starts: Array<BackgroundJob.StartInput>
  mode: "start" | "fail" | "elsewhere" | "run"
  status: BackgroundJob.Status
  /** The jobs that ran, in the "run" mode. */
  readonly fibers: Array<Fiber.Fiber<string, unknown>>
}

export const jobsOf = (): Jobs => ({ starts: [], mode: "start", status: "running", fibers: [] })

// The job registry: it records each start and runs nothing.
export const backgroundOf = (jobs: Jobs): BackgroundJob.Interface => ({
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
          // The "run" mode runs the job on its own fiber, as the registry would.
          if (jobs.mode === "run") jobs.fibers.push(Effect.runFork(input.run))
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
export const services = (jobs: Jobs) => {
  const { env } = boundary([])
  return Layer.mergeAll(
    Layer.succeed(Session.Service, env.sessions),
    Layer.succeed(SessionStatus.Service, env.status),
    Layer.succeed(InstanceStore.Service, env.instances),
    Layer.succeed(BackgroundJob.Service, backgroundOf(jobs)),
  )
}

// `/task <args>` in the instance: the replies it sent.
export const runTask = (harness: TaskHarness.Interface, args: string = SPEC, jobs: Jobs = jobsOf()) =>
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

export const statusFile = (directory: string) => path.join(directory, ".opencode", "task", "status.json")

export const refusalOf = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const status = JSON.parse(yield* fs.readFileString(statusFile(directory)))
    return status.run
  })
