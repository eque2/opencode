import { describe, expect, test } from "bun:test"
import { Effect, Random } from "effect"
import { Worktree } from "./worktree"
import { ServerScope } from "./server-scope"

// A unique directory per test, because the worktree state is module-level.
const dir = (name: string) => Random.nextInt.pipe(Effect.map((id) => `/tmp/opencode-worktree-${name}-${id}`))

describe("Worktree", () => {
  const scope = ServerScope.local
  test("normalizes trailing slashes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* dir("normalize")
        Worktree.ready(scope, `${key}/`)

        expect(Worktree.get(scope, key)).toEqual({ status: "ready" })
      }),
    ))

  test("pending does not overwrite a terminal state", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* dir("pending")
        Worktree.failed(scope, key, "boom")
        Worktree.pending(scope, key)

        expect(Worktree.get(scope, key)).toEqual({ status: "failed", message: "boom" })
      }),
    ))

  test("wait resolves shared pending waiter when ready", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* dir("wait-ready")
        Worktree.pending(scope, key)

        const a = Worktree.wait(scope, key)
        const b = Worktree.wait(scope, `${key}/`)

        expect(a).toBe(b)

        Worktree.ready(scope, key)

        expect(yield* Effect.promise(() => a)).toEqual({ status: "ready" })
        expect(yield* Effect.promise(() => b)).toEqual({ status: "ready" })
      }),
    ))

  test("wait resolves with failure message", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* dir("wait-failed")
        const waiting = Worktree.wait(scope, key)

        Worktree.failed(scope, key, "permission denied")

        expect(yield* Effect.promise(() => waiting)).toEqual({ status: "failed", message: "permission denied" })
        expect(yield* Effect.promise(() => Worktree.wait(scope, key))).toEqual({
          status: "failed",
          message: "permission denied",
        })
      }),
    ))

  test("isolates identical directories by server scope", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* dir("scope")
        const remote = ServerScope.make("https://debian.example")
        Worktree.ready(scope, key)
        Worktree.failed(remote, key, "remote failed")

        expect(Worktree.get(scope, key)).toEqual({ status: "ready" })
        expect(Worktree.get(remote, key)).toEqual({ status: "failed", message: "remote failed" })
      }),
    ))
})
