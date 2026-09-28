import { Data, Effect, Option, Predicate } from "effect"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

export type ServerProtocol = "v1" | "v2"

/** A health probe request, or the read of its JSON body, that failed. */
class ServerProbeError extends Data.TaggedError("App.ServerProbeError")<{ readonly cause: unknown }> {}

// A server with no password gets a request with no headers key.
function authorization(server: ServerConnection.HttpBase): { headers?: Record<string, string> } {
  if (!server.password) return {}
  return {
    headers: {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    },
  }
}

// Gives the JSON object at `path`, or none for a response that is not a JSON object.
function probe(server: ServerConnection.HttpBase, fetch: typeof globalThis.fetch, path: string) {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(new URL(path, server.url), {
          ...authorization(server),
          signal: AbortSignal.timeout(5_000),
        }),
      catch: (cause) => new ServerProbeError({ cause }),
    })
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      return Option.none<object>()
    }
    const value: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new ServerProbeError({ cause }),
    })
    return Predicate.isObjectOrArray(value) ? Option.some(value) : Option.none<object>()
  })
}

// A probe that fails counts as a missing endpoint.
function probeOption(server: ServerConnection.HttpBase, fetch: typeof globalThis.fetch, path: string) {
  return probe(server, fetch, path).pipe(Effect.orElseSucceed(() => Option.none<object>()))
}

const healthy = (value: object) => "healthy" in value && value.healthy === true

/** Detects the API generation of a server. It never fails: a server that answers no probe counts as V2. */
export function detectServerProtocol(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
): Effect.Effect<ServerProtocol> {
  return Effect.gen(function* () {
    const legacy = yield* probeOption(server, fetch, "/global/health")
    if (Option.exists(legacy, healthy)) return "v1"

    const current = yield* probeOption(server, fetch, "/api/health")
    if (Option.exists(current, (value) => "pid" in value && typeof value.pid === "number")) return "v2"
    if (Option.exists(current, healthy)) return "v1"
    return "v2"
  })
}
