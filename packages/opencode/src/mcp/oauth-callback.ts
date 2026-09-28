import { createConnection } from "net"
import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { Array as Arr, Deferred, Duration, Effect, MutableHashMap, Option, Schema } from "effect"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH, parseRedirectUri } from "./oauth-provider"

const OAUTH_CALLBACK_HOST = "127.0.0.1"

export class McpOAuthCallbackError extends Schema.TaggedError<McpOAuthCallbackError>()("McpOAuthCallbackError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// Current callback server configuration (may differ from defaults if custom redirectUri is used)
let currentPort = OAUTH_CALLBACK_PORT
let currentPath = OAUTH_CALLBACK_PATH

type Server = ReturnType<typeof createServer>

let server = Option.none<Server>()
// Keyed by oauthState. Each entry settles the matching waitForCallback.
const pendingAuths = MutableHashMap.empty<string, Deferred.Deferred<string, McpOAuthCallbackError>>()
// Reverse index: mcpName → oauthState, so cancelPending(mcpName) can
// find the right entry in pendingAuths (which is keyed by oauthState).
const mcpNameToState = MutableHashMap.empty<string, string>()

const CALLBACK_TIMEOUT = Duration.minutes(5)

function cleanupStateIndex(oauthState: string) {
  const found = Arr.findFirst(mcpNameToState, ([, state]) => state === oauthState)
  if (Option.isSome(found)) MutableHashMap.remove(mcpNameToState, found.value[0])
}

function stopIfIdle() {
  if (MutableHashMap.size(pendingAuths) > 0 || Option.isNone(server)) return

  server.value.close()
  server = Option.none()
}

function rejectPending(pending: Deferred.Deferred<string, McpOAuthCallbackError>, message: string) {
  Deferred.doneUnsafe(pending, Effect.fail(new McpOAuthCallbackError({ message })))
}

function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${currentPort}`)

  if (url.pathname !== currentPath) {
    res.writeHead(404)
    res.end("Not found")
    return
  }

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")
  const errorDescription = url.searchParams.get("error_description")

  // Enforce state parameter presence
  if (!state) {
    const errorMsg = "Missing required state parameter - potential CSRF attack"
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.error(errorMsg, { provider: "MCP" }))
    return
  }

  const pending = MutableHashMap.get(pendingAuths, state)

  if (error) {
    const errorMsg = errorDescription || error
    if (Option.isSome(pending)) {
      MutableHashMap.remove(pendingAuths, state)
      cleanupStateIndex(state)
      rejectPending(pending.value, errorMsg)
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.error(errorMsg, { provider: "MCP" }))
    stopIfIdle()
    return
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.error("No authorization code provided", { provider: "MCP" }))
    return
  }

  // Validate state parameter
  if (Option.isNone(pending)) {
    const errorMsg = "Invalid or expired state parameter - potential CSRF attack"
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.error(errorMsg, { provider: "MCP" }))
    return
  }

  MutableHashMap.remove(pendingAuths, state)
  cleanupStateIndex(state)
  Deferred.doneUnsafe(pending.value, Effect.succeed(code))

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(OauthCallbackPage.success({ provider: "MCP" }))
  stopIfIdle()
}

const listen = (next: Server, port: number) =>
  Effect.callback<void, McpOAuthCallbackError>((resume) => {
    next.listen(port, OAUTH_CALLBACK_HOST, () => resume(Effect.void))
    next.on("error", (cause) =>
      resume(Effect.fail(new McpOAuthCallbackError({ message: "OAuth callback server failed to listen", cause }))),
    )
  })

const ensureRunningEffect = Effect.fn("McpOAuthCallback.ensureRunning")(function* (redirectUri?: string) {
  // Parse the redirect URI to get port and path (uses defaults if not provided)
  const { port, path } = parseRedirectUri(redirectUri)

  // If server is running on a different port/path, stop it first
  if (Option.isSome(server) && (currentPort !== port || currentPath !== path)) {
    yield* stopEffect()
  }

  if (Option.isSome(server)) return

  if (yield* portInUse(port)) return

  currentPort = port
  currentPath = path

  const next = createServer(handleRequest)
  server = Option.some(next)
  yield* listen(next, currentPort)
})

const waitForCallbackEffect = Effect.fn("McpOAuthCallback.waitForCallback")(function* (
  oauthState: string,
  mcpName?: string,
) {
  if (mcpName) MutableHashMap.set(mcpNameToState, mcpName, oauthState)
  const pending = Deferred.makeUnsafe<string, McpOAuthCallbackError>()
  MutableHashMap.set(pendingAuths, oauthState, pending)

  return yield* Deferred.await(pending).pipe(
    Effect.timeoutOrElse({
      duration: CALLBACK_TIMEOUT,
      orElse: () =>
        Effect.suspend(() => {
          if (Option.contains(MutableHashMap.get(pendingAuths, oauthState), pending)) {
            MutableHashMap.remove(pendingAuths, oauthState)
            if (mcpName) MutableHashMap.remove(mcpNameToState, mcpName)
            stopIfIdle()
          }
          return Effect.fail(
            new McpOAuthCallbackError({ message: "OAuth callback timeout - authorization took too long" }),
          )
        }),
    }),
  )
})

const portInUse = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = createConnection(port, "127.0.0.1")
    socket.on("connect", () => {
      socket.destroy()
      resume(Effect.succeed(true))
    })
    socket.on("error", () => {
      resume(Effect.succeed(false))
    })
  })

const stopEffect = Effect.fn("McpOAuthCallback.stop")(function* () {
  if (Option.isSome(server)) {
    const running = server.value
    yield* Effect.callback<void>((resume) => {
      running.close(() => resume(Effect.void))
    })
    server = Option.none()
  }

  for (const pending of MutableHashMap.values(pendingAuths)) {
    rejectPending(pending, "OAuth callback server stopped")
  }
  MutableHashMap.clear(pendingAuths)
  MutableHashMap.clear(mcpNameToState)
})

// The exports below keep the Promise-based module contract that src/mcp/index.ts and the MCP
// tests call. Each one runs its Effect at this boundary.

export function ensureRunning(redirectUri?: string): Promise<void> {
  return Effect.runPromise(ensureRunningEffect(redirectUri))
}

export function waitForCallback(oauthState: string, mcpName?: string): Promise<string> {
  return Effect.runPromise(waitForCallbackEffect(oauthState, mcpName))
}

export function cancelPending(mcpName: string): void {
  // Look up the oauthState for this mcpName via the reverse index
  const key = Option.getOrElse(MutableHashMap.get(mcpNameToState, mcpName), () => mcpName)
  const pending = MutableHashMap.get(pendingAuths, key)
  if (Option.isNone(pending)) return
  MutableHashMap.remove(pendingAuths, key)
  MutableHashMap.remove(mcpNameToState, mcpName)
  rejectPending(pending.value, "Authorization cancelled")
  stopIfIdle()
}

export function isPortInUse(port: number = OAUTH_CALLBACK_PORT): Promise<boolean> {
  return Effect.runPromise(portInUse(port))
}

export function stop(): Promise<void> {
  return Effect.runPromise(stopEffect())
}

export function isRunning(): boolean {
  return Option.isSome(server)
}

export * as McpOAuthCallback from "./oauth-callback"
