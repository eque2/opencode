import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { NodeCrypto } from "@effect/platform-node"
import { Clock, Crypto, Deferred, Effect, Fiber, MutableRef, Option, Schema } from "effect"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { text } from "node:stream/consumers"
import open from "open"
import { errorMessage } from "../util/error"

const DO_OAUTH_CLIENT_ID = "b1a6c5158156caac821fd1b30253ca8acb52454a48fa744420e41889cb589f82"
const DO_AUTHORIZE_URL = "https://cloud.digitalocean.com/v1/oauth/authorize"
const DO_API_BASE = "https://api.digitalocean.com"
const DO_GENAI_API = `${DO_API_BASE}/v2/gen-ai`
const DO_INFERENCE_BASE = "https://inference.do-ai.run/v1"
const OAUTH_PORT = 1456
const OAUTH_REDIRECT_PATH = "/auth/callback"
const OAUTH_TOKEN_PATH = "/auth/token"
const ROUTER_REFRESH_INTERVAL_MS = 5 * 60 * 1000
const OAUTH_SCOPES = "genai:read inference:query"

export class DigitalOceanAuthError extends Schema.TaggedError<DigitalOceanAuthError>()("DigitalOceanAuth.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

interface ImplicitTokenPayload {
  access_token: string
  expires_in: number
  state: string
}

interface PendingOAuth {
  state: string
  tokens: Deferred.Deferred<ImplicitTokenPayload, DigitalOceanAuthError>
}

const RouterEntry = Schema.Struct({
  name: Schema.String,
  uuid: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "DigitalOceanRouterEntry" })
type RouterEntry = typeof RouterEntry.Type

const RouterList = Schema.Struct({
  model_routers: Schema.optional(Schema.Array(RouterEntry)),
}).annotate({ identifier: "DigitalOceanRouterList" })
const decodeRouterList = Schema.decodeUnknownEffect(RouterList)

// Auth metadata stores the router list as a JSON string.
const CachedRouters = Schema.fromJsonString(Schema.Array(RouterEntry))
const decodeCachedRouters = Schema.decodeUnknownOption(CachedRouters)
const encodeCachedRouters = Schema.encodeEffect(CachedRouters)

// The body that the callback page posts: either the implicit-grant token
// fields from the URL fragment, or the OAuth error fields.
const CallbackBody = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
}).annotate({ identifier: "DigitalOceanCallbackBody" })
type CallbackBody = typeof CallbackBody.Type
const decodeCallbackBody = Schema.decodeUnknownOption(Schema.fromJsonString(CallbackBody))

const CallbackReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ error: Schema.String }),
]).annotate({ identifier: "DigitalOceanCallbackReply" })
const encodeCallbackReply = Schema.encodeEffect(Schema.fromJsonString(CallbackReply))

type ProviderHook = NonNullable<Hooks["provider"]>
type ModelsHook = NonNullable<ProviderHook["models"]>

// The callback server and the one pending authorization are process-wide,
// because the server binds a fixed port.
const oauthServer = MutableRef.make(Option.none<Server>())
const pendingOAuth = MutableRef.make(Option.none<PendingOAuth>())

const generateState = Effect.gen(function* () {
  const cryptoService = yield* Crypto.Crypto
  const bytes = yield* cryptoService.randomBytes(32)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}).pipe(
  Effect.provide(NodeCrypto.layer),
  Effect.mapError((cause) => new DigitalOceanAuthError({ message: errorMessage(cause), cause })),
)

function redirectUri(): string {
  return `http://localhost:${OAUTH_PORT}${OAUTH_REDIRECT_PATH}`
}

function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "token",
    client_id: DO_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: OAUTH_SCOPES,
    state,
  })
  return `${DO_AUTHORIZE_URL}?${params.toString()}`
}

const respondJson = Effect.fn("DigitalOceanAuth.respondJson")(function* (
  res: ServerResponse,
  status: number,
  reply: typeof CallbackReply.Type,
) {
  const body = yield* encodeCallbackReply(reply)
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(body)
})

// Settles the pending authorization with the callback page's body and gives
// the reply for the page.
const settlePending = Effect.fn("DigitalOceanAuth.settlePending")(function* (
  res: ServerResponse,
  pending: PendingOAuth,
  body: CallbackBody,
) {
  MutableRef.set(pendingOAuth, Option.none())
  if (body.error) {
    const message = body.error_description || body.error
    yield* Deferred.fail(pending.tokens, new DigitalOceanAuthError({ message }))
    return yield* respondJson(res, 200, { ok: true })
  }
  if (!body.access_token) {
    yield* Deferred.fail(pending.tokens, new DigitalOceanAuthError({ message: "Missing access_token in callback" }))
    return yield* respondJson(res, 400, { error: "missing_access_token" })
  }
  if (body.state !== pending.state) {
    yield* Deferred.fail(pending.tokens, new DigitalOceanAuthError({ message: "Invalid state - potential CSRF attack" }))
    return yield* respondJson(res, 400, { error: "invalid_state" })
  }
  const expires = parseInt(body.expires_in || "0", 10)
  yield* Deferred.succeed(pending.tokens, {
    access_token: body.access_token,
    expires_in: Number.isFinite(expires) && expires > 0 ? expires : 60 * 60 * 24 * 30,
    state: body.state,
  })
  return yield* respondJson(res, 200, { ok: true })
})

const handleRequest = Effect.fn("DigitalOceanAuth.handleRequest")(function* (
  req: IncomingMessage,
  res: ServerResponse,
) {
  const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`)

  if (req.method === "GET" && url.pathname === OAUTH_REDIRECT_PATH) {
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(OauthCallbackPage.bootstrap({ tokenPath: OAUTH_TOKEN_PATH, provider: "DigitalOcean" }))
    return
  }

  if (req.method === "POST" && url.pathname === OAUTH_TOKEN_PATH) {
    const raw = yield* Effect.tryPromise(() => text(req)).pipe(Effect.orElseSucceed(() => ""))
    // An empty or malformed body counts as a body with no fields.
    const body = Option.getOrElse(decodeCallbackBody(raw), (): CallbackBody => ({}))
    yield* Option.match(MutableRef.get(pendingOAuth), {
      onNone: () => respondJson(res, 409, { error: "no_pending_oauth" }),
      onSome: (pending) => settlePending(res, pending, body),
    })
    return
  }

  res.writeHead(404)
  res.end("Not found")
})

const startOAuthServer = Effect.gen(function* () {
  if (Option.isSome(MutableRef.get(oauthServer))) return
  const server = createServer((req, res) => {
    // node:http owns this callback; the handler runs as its own fiber.
    Effect.runFork(handleRequest(req, res))
  })
  MutableRef.set(oauthServer, Option.some(server))
  yield* Effect.callback<void, DigitalOceanAuthError>((resume) => {
    server.on("error", (cause) => resume(Effect.fail(new DigitalOceanAuthError({ message: cause.message, cause }))))
    server.listen(OAUTH_PORT, () => resume(Effect.void))
  })
})

const stopOAuthServer = Effect.sync(() => {
  const server = MutableRef.get(oauthServer)
  if (Option.isNone(server)) return
  server.value.close()
  MutableRef.set(oauthServer, Option.none())
})

// Registers the authorization that the callback page will settle.
const registerPending = Effect.fn("DigitalOceanAuth.registerPending")(function* (state: string) {
  const pending: PendingOAuth = {
    state,
    tokens: yield* Deferred.make<ImplicitTokenPayload, DigitalOceanAuthError>(),
  }
  MutableRef.set(pendingOAuth, Option.some(pending))
  return pending
})

// Waits for the callback page, for at most five minutes. A timed-out
// authorization stops accepting callbacks.
const awaitCallback = (pending: PendingOAuth) =>
  Deferred.await(pending.tokens).pipe(
    Effect.timeoutOrElse({
      duration: "5 minutes",
      orElse: () =>
        Effect.suspend(() => {
          const current = MutableRef.get(pendingOAuth)
          if (Option.isSome(current) && current.value === pending) MutableRef.set(pendingOAuth, Option.none())
          return Effect.fail(
            new DigitalOceanAuthError({ message: "OAuth callback timeout - authorization took too long" }),
          )
        }),
    }),
  )

// Lists the account's Inference Routers. Gives none when the request fails,
// times out, or is refused.
const listRouters = Effect.fn("DigitalOceanAuth.listRouters")(function* (bearer: string) {
  const res = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(`${DO_GENAI_API}/models/routers`, {
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "application/json",
          "User-Agent": `opencode/${InstallationVersion}`,
        },
        signal,
      }),
    catch: (cause) => new DigitalOceanAuthError({ message: errorMessage(cause), cause }),
  }).pipe(Effect.timeoutOption("10 seconds"), Effect.orElseSucceed(Option.none<Response>))
  if (Option.isNone(res) || !res.value.ok) return Option.none<ReadonlyArray<RouterEntry>>()
  // A body that is not the router list counts as no routers.
  const routers = yield* Effect.tryPromise((): Promise<unknown> => res.value.json()).pipe(
    Effect.flatMap(decodeRouterList),
    Effect.map((body) => body.model_routers ?? []),
    Effect.orElseSucceed((): ReadonlyArray<RouterEntry> => []),
  )
  return Option.some(routers)
})

function routerModel(router: RouterEntry, providerID: string): Model {
  const id = `router:${router.name}`
  return {
    id,
    providerID,
    name: router.name,
    family: "digitalocean-inference-routers",
    api: { id, url: DO_INFERENCE_BASE, npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 8_192 },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

function parseRoutersJSON(raw: string | undefined): ReadonlyArray<RouterEntry> {
  if (!raw) return []
  return Option.getOrElse(decodeCachedRouters(raw), (): ReadonlyArray<RouterEntry> => [])
}

export function DigitalOceanAuthPlugin(input: PluginInput): Promise<Hooks> {
  const models = Effect.fn("DigitalOceanAuth.models")(function* (
    provider: Parameters<ModelsHook>[0],
    ctx: Parameters<ModelsHook>[1],
  ) {
    const baseModels = provider.models
    if (ctx.auth?.type !== "api") return baseModels
    const auth = ctx.auth

    const metadata = auth.metadata ?? {}
    const oauthAccess = metadata["oauth_access"]
    const oauthExpires = parseInt(metadata["oauth_expires"] || "0", 10)
    const fetchedAt = parseInt(metadata["routers_fetched_at"] || "0", 10)
    const cached = parseRoutersJSON(metadata["routers"])

    const now = yield* Clock.currentTimeMillis
    const stale = now - fetchedAt > ROUTER_REFRESH_INTERVAL_MS
    const bearerValid = oauthAccess && oauthExpires > now
    const fresh = bearerValid && stale ? yield* listRouters(oauthAccess) : Option.none<ReadonlyArray<RouterEntry>>()

    if (Option.isSome(fresh)) {
      const updated: Record<string, string> = {
        ...metadata,
        routers: yield* encodeCachedRouters(fresh.value),
        routers_fetched_at: String(yield* Clock.currentTimeMillis),
      }
      yield* Effect.tryPromise(() =>
        input.client.auth.set({
          path: { id: "digitalocean" },
          body: { type: "api", key: auth.key, metadata: updated },
        }),
      ).pipe(Effect.ignore)
    }

    const routers = Option.getOrElse(fresh, () => cached)
    const merged: Record<string, Model> = { ...baseModels }
    for (const router of routers) {
      const id = `router:${router.name}`
      if (merged[id]) continue
      merged[id] = routerModel(router, "digitalocean")
    }
    return merged
  })

  const complete = Effect.fn("DigitalOceanAuth.complete")(function* (
    waiting: Fiber.Fiber<ImplicitTokenPayload, DigitalOceanAuthError>,
  ) {
    const tokens = yield* Fiber.join(waiting)
    const routers = Option.getOrElse(yield* listRouters(tokens.access_token), (): ReadonlyArray<RouterEntry> => [])
    const now = yield* Clock.currentTimeMillis
    return {
      type: "success" as const,
      provider: "digitalocean",
      key: tokens.access_token,
      metadata: {
        oauth_access: tokens.access_token,
        oauth_expires: String(now + tokens.expires_in * 1000),
        oauth_scopes: OAUTH_SCOPES,
        routers: yield* encodeCachedRouters(routers),
        routers_fetched_at: String(now),
      },
    }
  })

  const authorize = Effect.fn("DigitalOceanAuth.authorize")(function* () {
    yield* startOAuthServer
    const state = yield* generateState
    const pending = yield* registerPending(state)
    // The five-minute wait starts now, as the user signs in, not when the host
    // asks for the result.
    const waiting = yield* Effect.forkDetach(awaitCallback(pending))
    const url = buildAuthorizeUrl(state)
    yield* Effect.tryPromise(() => open(url)).pipe(Effect.ignore)
    return {
      url,
      instructions:
        "Sign in to DigitalOcean in your browser. OpenCode will use your DigitalOcean API token directly for inference and load your Inference Routers. Re-run /connect to refresh routers later.",
      method: "auto" as const,
      callback: () =>
        Effect.runPromise(
          complete(waiting).pipe(
            Effect.catch(() => Effect.succeed({ type: "failed" as const })),
            Effect.ensuring(stopOAuthServer),
          ),
        ),
    }
  })

  const hooks: Hooks = {
    provider: {
      id: "digitalocean",
      models: (provider, ctx) => Effect.runPromise(models(provider, ctx)),
    },
    auth: {
      provider: "digitalocean",
      methods: [
        {
          type: "oauth",
          label: "Login with DigitalOcean",
          authorize: () => Effect.runPromise(authorize()),
        },
        {
          type: "api",
          label: "Paste Model Access Key",
        },
      ],
    },
  }
  return Effect.runPromise(Effect.succeed(hooks))
}
