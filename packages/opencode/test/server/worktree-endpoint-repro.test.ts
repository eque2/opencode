import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { GlobalBus } from "@/bus/global"
import { Worktree } from "@/worktree"
import { Server } from "../../src/server/server"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { WorkspacePaths } from "../../src/server/routes/instance/httpapi/groups/workspace"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestFailure } from "../fixture/test-failure"
import { takeGlobalBusEvent } from "./global-bus"

const stateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
  }),
)

const it = testEffect(stateLayer)
const worktreeTest = process.platform === "win32" ? it.instance.skip : it.instance
type TestServer = ReturnType<typeof Server.Default>["app"]
type CreatedWorktree = { directory: string }
type ScopedWorktree = { directory: string; body: CreatedWorktree; ready: Effect.Effect<void, TestFailure> }

function serverScoped() {
  return Effect.sync(() => Server.Default().app)
}

function request(server: TestServer, input: string, init?: RequestInit) {
  return Effect.promise(() => Promise.resolve(server.request(input, init)))
}

function withRequestTimeout(effect: Effect.Effect<Response>, label: string, ms = 5_000) {
  return effect.pipe(
    Effect.timeoutOrElse({
      duration: `${ms} millis`,
      orElse: () => Effect.fail(new TestFailure({ message: `${label} timed out after ${ms}ms` })),
    }),
  )
}

function json<S extends Schema.Constraint>(response: Response, schema: S) {
  return Effect.promise(() => response.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))
}

// The create routes return a Worktree.Info or a Workspace.Info; the tests read directory and
// assert other fields, so the rest of the body is kept.
const CreatedWorktree = Schema.StructWithRest(Schema.Struct({ directory: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
])

function readyWatcher() {
  return Effect.gen(function* () {
    const subscription = yield* GlobalBus.subscribe

    return (directory: string) =>
      takeGlobalBusEvent(
        subscription,
        (event) => event.payload.type === Worktree.Event.Ready.type && event.directory === directory,
      ).pipe(
        Effect.asVoid,
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new TestFailure({ message: `timed out waiting for worktree.ready: ${directory}` })),
        }),
      )
  })
}

function removeCreatedWorktree(input: {
  server: TestServer
  rootDirectory: string
  worktreeDirectory: string
  ready: Effect.Effect<void, TestFailure>
}) {
  return Effect.gen(function* () {
    yield* input.ready.pipe(Effect.timeout("1 second"), Effect.ignore)
    yield* Effect.promise(() => disposeAllInstances()).pipe(Effect.ignore)

    const removed = yield* request(
      input.server,
      `${ExperimentalPaths.worktree}?directory=${encodeURIComponent(input.rootDirectory)}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory: input.worktreeDirectory }),
      },
    )
    if (removed.status !== 200) {
      const message = yield* Effect.promise(() => removed.text())
      throw new Error(`failed to remove worktree: ${removed.status} ${message}`)
    }
    const ok = yield* json(removed, Schema.Boolean)
    if (!ok) throw new Error(`failed to remove worktree ${input.worktreeDirectory}`)
  })
}

function createWorktreeScoped(input: {
  server: TestServer
  directory: string
  path: string
  init: RequestInit
  timeoutLabel: string
  timeoutMs?: number
}) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const waitReady = yield* readyWatcher()
      const response = yield* withRequestTimeout(
        request(input.server, input.path, input.init),
        input.timeoutLabel,
        input.timeoutMs,
      )
      if (response.status !== 200) {
        const message = yield* Effect.promise(() => response.text())
        throw new Error(`${input.timeoutLabel} failed: ${response.status} ${message}`)
      }
      expect(response.status).toBe(200)
      const body = yield* json(response, CreatedWorktree)
      return { directory: body.directory, body, ready: waitReady(body.directory) } satisfies ScopedWorktree
    }),
    (created) =>
      removeCreatedWorktree({
        server: input.server,
        rootDirectory: input.directory,
        worktreeDirectory: created.directory,
        ready: created.ready,
      }).pipe(Effect.orDie),
  ).pipe(Effect.map((created) => created.body))
}

function setProjectStartCommand(input: { server: TestServer; directory: string; command: string }) {
  return Effect.gen(function* () {
    const current = yield* request(input.server, `/project/current?directory=${encodeURIComponent(input.directory)}`)
    expect(current.status).toBe(200)
    const project = yield* json(current, Schema.Struct({ id: Schema.String }))
    const updated = yield* request(
      input.server,
      `/project/${project.id}?directory=${encodeURIComponent(input.directory)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commands: { start: input.command } }),
      },
    )
    expect(updated.status).toBe(200)
  })
}

describe("worktree endpoint reproduction", () => {
  worktreeTest(
    "direct HttpApi worktree create returns without waiting for boot",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const server = yield* serverScoped()

        const response = yield* createWorktreeScoped({
          server,
          directory: test.directory,
          path: `${ExperimentalPaths.worktree}?directory=${encodeURIComponent(test.directory)}`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          },
          timeoutLabel: "direct worktree create",
        })

        expect(response).toMatchObject({ directory: expect.any(String) })
      }),
    { git: true },
  )

  worktreeTest(
    "direct HttpApi worktree create accepts missing body",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const server = yield* serverScoped()

        const response = yield* createWorktreeScoped({
          server,
          directory: test.directory,
          path: `${ExperimentalPaths.worktree}?directory=${encodeURIComponent(test.directory)}`,
          init: { method: "POST", headers: { "content-type": "application/json" } },
          timeoutLabel: "direct worktree create without body",
        })

        expect(response).toMatchObject({ directory: expect.any(String) })
      }),
    { git: true },
  )

  worktreeTest(
    "direct HttpApi worktree create accepts missing content type and body",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const server = yield* serverScoped()

        const response = yield* createWorktreeScoped({
          server,
          directory: test.directory,
          path: `${ExperimentalPaths.worktree}?directory=${encodeURIComponent(test.directory)}`,
          init: { method: "POST" },
          timeoutLabel: "direct worktree create without content type or body",
        })

        expect(response).toMatchObject({ directory: expect.any(String) })
      }),
    { git: true },
  )

  worktreeTest(
    "direct HttpApi worktree create rejects explicit null payload",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const server = yield* serverScoped()

        const response = yield* request(
          server,
          `${ExperimentalPaths.worktree}?directory=${encodeURIComponent(test.directory)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "null",
          },
        )

        expect(response.status).toBe(400)
      }),
    { git: true },
  )

  worktreeTest(
    "workspace worktree create does not hang",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const server = yield* serverScoped()

        const response = yield* createWorktreeScoped({
          server,
          directory: test.directory,
          path: `${WorkspacePaths.list}?directory=${encodeURIComponent(test.directory)}`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "worktree", branch: null }),
          },
          timeoutLabel: "workspace worktree create",
          timeoutMs: 8_000,
        })

        expect(response).toMatchObject({
          type: "worktree",
          directory: expect.any(String),
        })
      }),
    { git: true },
  )

  worktreeTest(
    "workspace worktree create returns without waiting for project start command",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const server = yield* serverScoped()
        yield* setProjectStartCommand({
          server,
          directory: test.directory,
          command: 'bun -e "setTimeout(() => {}, 2000)"',
        })

        const started = Date.now()
        yield* createWorktreeScoped({
          server,
          directory: test.directory,
          path: `${WorkspacePaths.list}?directory=${encodeURIComponent(test.directory)}`,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "worktree", branch: null }),
          },
          timeoutLabel: "workspace worktree create with project start command",
          timeoutMs: 6_000,
        })

        expect(Date.now() - started).toBeLessThan(1_500)
      }),
    { git: true },
  )
})
