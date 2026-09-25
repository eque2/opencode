import { run } from "@opencode-ai/tui"
import { TuiConfig } from "@opencode-ai/tui/config"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"

export function runTui(transport: { url: string; headers: RequestInit["headers"] }) {
  const config = TuiConfig.resolve({}, { terminalSuspend: false })
  return run({
    ...transport,
    args: {},
    config,
    fetch: gracefulFetch,
    // The CLI loads no TUI plugins, so both host hooks resolve at once.
    pluginHost: {
      start: () => Effect.runPromise(Effect.void),
      dispose: () => Effect.runPromise(Effect.void),
    },
  }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}

const legacyDefaults: Record<string, unknown> = {
  "/config/providers": { providers: [], default: {} },
  "/provider": { all: [], default: {}, connected: [] },
  "/agent": [],
  "/config": {},
}

// The TUI calls this as `typeof fetch`, so it keeps the Promise signature and
// runs the Effect at the boundary. A rejected fetch rejects with the same error.
const gracefulFetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* Effect.promise(() => fetch(input, init))
        if (response.status !== 404) return response
        const fallback = legacyDefaults[new URL(input instanceof Request ? input.url : input).pathname]
        if (fallback === undefined) return response
        return Response.json(fallback)
      }),
    ),
  { preconnect: fetch.preconnect },
)
