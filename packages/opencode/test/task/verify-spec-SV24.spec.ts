import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Fiber, Layer, Option, Schema } from "effect"
import fs from "fs"
import path from "path"
import type { Tool as AITool } from "ai"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import { TaskHooks } from "@/task/core/hooks"
import type { Fact } from "@/task/core/model"
import type { TaskOps } from "@/task/core/ops"
import { TaskWorkspace } from "@/task/core/workspace"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { git, jobsOf, SESSION, seed, services, SPEC } from "./lib/command"
import { loadPlan } from "./lib/machine"
import { eventually } from "./lib/supervise"

// Scenario SV24 (spec task-harness-feedback, AD-6, AD-8, AD-11; tasks T2.8, T2.10): a reused builder session is
// claimed again on resume.
//
//   Given an unended slice whose T1.2 builder session exists
//   When the run resumes and the new task supervisor prompts that session
//   Then it claims the session and waits for the index entry before the prompt
//   And task_ready from that session reaches the new supervisor
//
// Everything is the real `/task` resume: TaskCommand.run (the slice choice resumes the latest slice of the same path),
// the real TaskHarness root (its session index and the hook routing to the owner), the real event store, a seeded git
// instance with a real worktree for T1.2. The background-job registry is the project's test registry (lib/command) in
// "run" mode, so the job runs for real: the Recorder restored from the stored slice, the run supervisor, and the task
// supervisors it spawns. The harness's `claimSession` is wrapped only to note each claim and, once the real claim
// returns, whether the index holds it. The model side is scripted and calls the REAL `task_ready` tool
// (SessionPrompt's createTaskHarnessTools with the root's hooks, as prompt.ts builds it for a turn).

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))
const LIMITS = TaskLimits.scripted

const BUILDER = "ses_sv24_T1.2_builder"
const NO_OWNER = "No task harness run owns this session. Nothing was recorded."
const READY = "Ready recorded. End your turn now: the harness runs the proofs."

const ToolResult = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
  metadata: Schema.Struct({ valid: Schema.Boolean }),
})

// Runs a harness tool's `execute` as the AI SDK does for a tool call, and reads its result.
const exec = (tool: AITool | undefined, input: unknown) =>
  Effect.promise(() => {
    if (tool?.execute === undefined) throw new Error("no such harness tool")
    return Promise.resolve(tool.execute(input, { toolCallId: "call_1", messages: [] }))
  }).pipe(Effect.map(Schema.decodeUnknownSync(ToolResult)))

// The REAL task_ready tool of a builder turn in `session`, as prompt.ts gives it.
const taskReady = (harness: TaskHarness.Interface, session: string, summary: string) =>
  Effect.flatMap(
    SessionPrompt.createTaskHarnessTools(TaskHooks.BUILDER, SessionID.make(session), harness.hooks),
    (tools) => exec(tools.task_ready, { summary }),
  )

it.instance(
  "[SV24] on resume the new task supervisor claims the reused T1.2 builder session, waits for the index entry before the prompt, and task_ready from it reaches the supervisor",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
      const events = yield* EventV2Bridge.Service
      const db = yield* Database.Service
      const plan = yield* loadPlan("release-notes.spec")
      const id = TaskEvents.runID(directory, SPEC)
      const owner = TaskHarness.systemId.task(id, "T1.2")
      const real = yield* TaskHarness.make

      // Given an unended slice whose T1.2 builder session exists: T1.2 started in its worktree with that session.
      const tree = yield* TaskWorkspace.ensureWorktree(directory, id, "T1.2", branch, LIMITS)
      const slice: ReadonlyArray<Fact> = [
        { type: "run.started", at: 1, base: branch, path: SPEC },
        {
          type: "task.started",
          at: 2,
          task: "T1.2",
          worktree: tree.worktree,
          branch: tree.branch,
          base: tree.base,
          session: BUILDER,
        },
      ]
      for (const fact of slice) yield* TaskEvents.publish(events, id, fact)
      const given = TaskEvents.fold(TaskEngineXState.XStateEngine, plan, slice)
      expect(TaskEngineXState.ended(given)).toBe(false)
      expect(TaskEngineXState.unitState(given, "T1.2")).toBe("building")
      expect(TaskEngineXState.view(given).tasks["T1.2"]?.session).toBe(BUILDER)
      expect(yield* TaskCommand.sliceOf(plan, slice, SPEC)).toEqual({ kind: "resume", facts: slice })
      // Control: before the resume no supervisor owns the session, so its task_ready records nothing and says so.
      expect(yield* taskReady(real, BUILDER, "too early")).toEqual({
        title: "Task ready",
        output: NO_OWNER,
        metadata: { valid: false },
      })

      // The claims the run makes, each noted before the real claim and once the real claim has returned.
      const order: Array<string> = []
      const harness: TaskHarness.Interface = {
        ...real,
        claimSession: (input) =>
          Effect.gen(function* () {
            order.push(`claim ${input.session} ${input.owner} watch=${String(input.watch)}`)
            yield* real.claimSession(input)
            const entry = yield* real.ownerOf(input.session)
            order.push(`indexed ${input.session} ${Option.isSome(entry) ? entry.value.owner : "none"}`)
          }),
      }
      // The session side: the command's reply; T1.2's first builder turn writes its work and calls task_ready; every
      // other turn runs until it is stopped.
      const replies: Array<string> = []
      const atPrompt: Array<{ readonly entry: Option.Option<TaskHooks.Owner>; readonly live: boolean }> = []
      const answers: Array<typeof ToolResult.Type> = []
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the harness never reads the reply message, and a real WithParts needs a stored session
      const reply = {} as SessionV1.WithParts
      const ops: TaskOps.Ops = {
        prompt: (input) => {
          if (input.sessionID === SESSION)
            return Effect.sync(() => {
              replies.push(input.parts.map((part) => part.text).join("\n"))
              return reply
            })
          if (input.sessionID !== BUILDER || atPrompt.length > 0) return Effect.never
          return Effect.gen(function* () {
            order.push(`prompt ${input.sessionID}`)
            atPrompt.push({
              entry: yield* real.ownerOf(BUILDER),
              live: Option.isSome(yield* real.system.get(owner)),
            })
            fs.writeFileSync(path.join(tree.worktree, "bump.ts"), "export const bump = (v: string) => v\n")
            answers.push(yield* taskReady(real, BUILDER, "version bump done"))
            return reply
          })
        },
        cancel: () => Effect.void,
        currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
        say: () => Effect.void,
      }

      // When the run resumes: /task on the same path, as a real job.
      const jobs = jobsOf()
      jobs.mode = "run"
      yield* TaskCommand.run({ sessionID: SESSION, arguments: SPEC }, ops, harness).pipe(Effect.provide(services(jobs)))
      expect(replies).toEqual(["Implementing spec **Release notes from conventional commits**"])
      expect(jobs.starts.map((start) => start.id)).toEqual([id])
      const stored = Effect.map(TaskEvents.read(db.db, id), (list) => list.slice(slice.length))
      yield* eventually(
        Effect.map(stored, (list) => list.some((fact) => fact.type === "task.ready")),
        "the new supervisor records task.ready",
      )

      // The run resumed the slice: its first new fact is run.resumed with the same path.
      const added = yield* stored
      expect(added[0]).toMatchObject({ type: "run.resumed", path: SPEC })
      expect(added.some((fact) => fact.type === "run.started")).toBe(false)

      // And the new task supervisor prompted that same session: it claimed it, the index held it, then the prompt.
      const mine = order.filter((line) => line.includes(BUILDER))
      expect(mine).toEqual([`claim ${BUILDER} ${owner} watch=true`, `indexed ${BUILDER} ${owner}`, `prompt ${BUILDER}`])
      // At the prompt the index names the new supervisor, which is live in the harness system.
      expect(atPrompt).toEqual([{ entry: Option.some({ owner, watch: true }), live: true }])
      // No new session was made for T1.2: the run actor still names the stored one.
      const snapshot = TaskEngineXState.view(
        TaskEvents.fold(TaskEngineXState.XStateEngine, plan, yield* TaskEvents.read(db.db, id)),
      )
      expect(snapshot.tasks["T1.2"]?.session).toBe(BUILDER)

      // And task_ready from that session reached the new supervisor: the tool says so, and the supervisor records
      // task.ready with the head of the work the builder left, once the turn ended.
      expect(answers).toEqual([{ title: "Task ready", output: READY, metadata: { valid: true } }])
      const ready = added.find((fact) => fact.type === "task.ready")
      if (ready?.type !== "task.ready") throw new Error("no task.ready")
      expect(ready.task).toBe("T1.2")
      expect(ready.head).toBe(yield* git(tree.worktree, "rev-parse", "HEAD"))
      expect(yield* git(tree.worktree, "show", `${ready.head}:bump.ts`)).toContain("export const bump")
      expect(added.filter((fact) => fact.type === "task.ready")).toHaveLength(1)

      // The job is cancelled to end the test; the directory is free again.
      jobs.status = "cancelled"
      for (const fiber of jobs.fibers) yield* Fiber.interrupt(fiber).pipe(Effect.timeout(60_000))
      expect((yield* stored).map((fact) => fact.type)).toContain("run.cancelled")
      expect(yield* real.live(directory)).toEqual(Option.none())
      expect(yield* real.ownerOf(BUILDER)).toEqual(Option.none())
    }),
  { git: true },
  120_000,
)
