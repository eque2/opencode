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
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"

// The heap monitor is a detached fiber; the TUI ends this worker with terminate().
Effect.runFork(Heap.start())

const onUnhandledRejection = (_error: unknown) => {}

const onUncaughtException = (_error: Error) => {}

process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

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
      yield* upgrade().pipe(Effect.catchCause(() => Effect.void))
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
      process.off("unhandledRejection", onUnhandledRejection)
      process.off("uncaughtException", onUncaughtException)
    }),
}

Rpc.listen(rpc, (effect) => AppRuntime.runFork(effect))
