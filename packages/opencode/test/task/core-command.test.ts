import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, FileSystem } from "effect"
import path from "path"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionID } from "@/session/schema"
import { TaskCommand } from "@/task/core/command"
import type { TaskOps } from "@/task/core/ops"
import { TaskWorkspace } from "@/task/core/workspace"
import { TaskLimits } from "@/task/limits"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// `/task` refuses, with no model turn and no run, when the root checkout cannot take the leaves' merges: a detached
// HEAD or a tracked change. The refusal needs no session runtime, so the ops only record the reply.

const it = testEffect(NodeServices.layer)
const limits = TaskLimits.scripted
const SPEC = "task-formats/blend/release-notes.spec"
const source = path.resolve(import.meta.dir, "../../../..", SPEC)

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

const runTask = Effect.gen(function* () {
  const replies: string[] = []
  const ops: TaskOps.Ops = {
    // The reply's message is not read on a refusal.
    prompt: (input) =>
      Effect.sync(() => {
        replies.push(input.parts.map((part) => part.text).join(""))
        return {} as SessionV1.WithParts
      }),
    cancel: () => Effect.void,
    currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
  }
  yield* TaskCommand.run({ sessionID: SessionID.make("ses_task_command_refusal"), arguments: SPEC }, ops)
  return replies
})

const refusalOf = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const status = JSON.parse(yield* fs.readFileString(path.join(directory, ".opencode", "task", "status.json")))
    return status.run
  })

describe("/task on a root checkout that cannot take a run", () => {
  it.instance(
    "refuses a tracked change and names it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* seeded
        yield* fs.writeFileString(path.join(directory, "app.ts"), "export const app = 2\n")

        const replies = yield* runTask

        expect(replies).toEqual([`Task harness: refused ${SPEC}: the checkout has uncommitted changes: app.ts`])
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

        const replies = yield* runTask

        expect(replies).toEqual([`Task harness: refused ${SPEC}: the checkout is not on a branch (detached HEAD)`])
        expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC })
      }),
    { git: true },
  )
})
