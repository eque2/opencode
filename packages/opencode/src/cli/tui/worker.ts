import { Server } from "@/server/server"
import { InstanceStore } from "@/project/instance-store"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Cause, Effect, Stream } from "effect"
import { Telemetry } from "@opencode-ai/core/observability/telemetry"
import { Datadog } from "@opencode-ai/core/observability/datadog"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"

// The heap monitor is a detached fiber; the TUI ends this worker with terminate().
Effect.runFork(Heap.start())

// The worker must survive a stray rejection or exception, but each one is recorded. These records run on the bare
// runtime on purpose: a handler can fire before AppRuntime is built, and AppRuntime.runFork would then build the
// whole app from a crash handler. `Telemetry.record` needs no services, because the Datadog sink registry is
// process-global; `Effect.runFork` accepts only an Effect with no requirements, so the type checker would reject
// these calls if that changed.
const onUnhandledRejection = (error: unknown) => {
  Effect.runFork(Telemetry.record("Error", "TUI worker unhandled rejection", { category: "cli.worker", error }))
}

const onUncaughtException = (error: Error) => {
  Effect.runFork(Telemetry.record("Error", "TUI worker uncaught exception", { category: "cli.worker", error }))
}

process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

// Forward global events via RPC. runFork subscribes synchronously, and the fiber lives as long as the worker.
Effect.runFork(GlobalBus.stream.pipe(Stream.runForEach((event) => Effect.sync(() => Rpc.emit("global.event", event)))))

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

// ServerApp.fetch returns Response | Promise<Response>.
const fetchApp = (request: Request) =>
  Effect.suspend(() => {
    const response = Server.Default().app.fetch(request)
    return response instanceof Response ? Effect.succeed(response) : Effect.promise(() => response)
  })

const stopServer = Effect.suspend(() => {
  const current = server
  return current ? Effect.promise(() => current.stop(true)) : Effect.void
})

// Rpc.listen runs each method's Effect on AppRuntime and posts its success value.
export const rpc = {
  fetch: (input: { url: string; method: string; headers: Record<string, string>; body?: string }) =>
    Effect.gen(function* () {
      const auth = yield* ServerAuth.header()
      const headers =
        auth && !input.headers["authorization"] && !input.headers["Authorization"]
          ? { ...input.headers, Authorization: auth }
          : { ...input.headers }
      const request = new Request(input.url, {
        method: input.method,
        headers,
        body: input.body,
      })
      const response = yield* fetchApp(request)
      const body = yield* Effect.promise(() => response.text())
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      }
    }),
  snapshot: () => Effect.sync(() => writeHeapSnapshot("server.heapsnapshot")),
  server: (input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) =>
    Effect.gen(function* () {
      yield* stopServer
      const next = yield* Effect.promise(() => Server.listen(input))
      server = next
      return { url: next.url.toString() }
    }),
  checkUpgrade: (input: { directory: string }) =>
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: input.directory })
      // The update check is best effort; no failure reaches the TUI.
      yield* upgrade().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("update check failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.annotateLogs({ category: "cli.upgrade" }),
          ),
        ),
      )
    }),
  reload: () =>
    Effect.gen(function* () {
      const cfg = yield* Config.Service
      yield* cfg.invalidate()
      yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
    }),
  shutdown: () =>
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      yield* store.disposeAll()
      yield* stopServer
      // The main thread terminates this worker next, which skips the runtime finalizers.
      yield* Datadog.flushAll
      process.off("unhandledRejection", onUnhandledRejection)
      process.off("uncaughtException", onUncaughtException)
    }),
}

Rpc.listen(rpc, (effect) => AppRuntime.runFork(effect))
