import type { AuthOAuthResult, Hooks } from "@opencode-ai/plugin"
import type { Auth, OAuth } from "@opencode-ai/sdk/v2"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { Array as Arr, Clock, Deferred, Effect, Fiber, HashSet, Option, Schema, Semaphore } from "effect"
import { createServer, type IncomingMessage, type ServerResponse } from "http"
import os from "os"
import { OAUTH_DUMMY_KEY } from "../../auth"
import { errorMessage } from "../../util/error"
import { OpenAIWebSocketPool } from "./ws-pool"

const ClientId = Schema.String.pipe(Schema.brand("CodexClientId"))
const CLIENT_ID = ClientId.make("app_EMoamEEZ73f0CkXaXp7hrann")
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT = 1455
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_PORT}/auth/callback`
const OAUTH_TIMEOUT = "5 minutes"
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600
const ALLOWED_MODELS = HashSet.make("gpt-5.5", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini")
const DISALLOWED_MODELS = HashSet.make("gpt-5.5-pro")

export class CodexAuthError extends Schema.TaggedError<CodexAuthError>()("CodexAuth.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const CodexOrganizationId = Schema.String.pipe(Schema.brand("CodexOrganizationId"))

const IdTokenClaims = Schema.Struct({
  chatgpt_account_id: Schema.optional(Schema.String),
  chatgpt_compute_residency: Schema.optional(Schema.String),
  organizations: Schema.optional(Schema.Array(Schema.Struct({ id: CodexOrganizationId }))),
  email: Schema.optional(Schema.String),
  "https://api.openai.com/auth": Schema.optional(
    Schema.Struct({
      chatgpt_account_id: Schema.optional(Schema.String),
      chatgpt_compute_residency: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "CodexIdTokenClaims" })
export type IdTokenClaims = typeof IdTokenClaims.Type
const decodeIdTokenClaims = Schema.decodeUnknownOption(Schema.fromJsonString(IdTokenClaims))

const TokenResponse = Schema.Struct({
  id_token: Schema.optional(Schema.String),
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.optional(Schema.Number),
}).annotate({ identifier: "CodexTokenResponse" })
type TokenResponse = typeof TokenResponse.Type
const decodeTokenResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(TokenResponse))

const DeviceAuthId = Schema.String.pipe(Schema.brand("CodexDeviceAuthId"))

const DeviceCode = Schema.Struct({
  device_auth_id: DeviceAuthId,
  user_code: Schema.String,
  // The device endpoint sends the poll interval in seconds, as a string.
  interval: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
}).annotate({ identifier: "CodexDeviceCode" })
type DeviceCode = typeof DeviceCode.Type
const decodeDeviceCode = Schema.decodeUnknownEffect(Schema.fromJsonString(DeviceCode))

const DeviceAuthorization = Schema.Struct({
  authorization_code: Schema.String,
  code_verifier: Schema.String,
}).annotate({ identifier: "CodexDeviceAuthorization" })
const decodeDeviceAuthorization = Schema.decodeUnknownEffect(Schema.fromJsonString(DeviceAuthorization))

const encodeUserCodeRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Struct({ client_id: ClientId })))
const encodeDeviceTokenRequest = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ device_auth_id: DeviceAuthId, user_code: Schema.String })),
)

interface PkceCodes {
  verifier: string
  challenge: string
}

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  deferred: Deferred.Deferred<TokenResponse, CodexAuthError>
}

interface RefreshedSession {
  access: string
  accountId: Option.Option<string>
}

interface CodexAuthPluginOptions {
  issuer?: string
  codexApiEndpoint?: string
  experimentalWebSockets?: boolean
}

/** The part of the plugin input that this plugin uses: it persists refreshed OAuth tokens. */
export interface CodexAuthInput {
  client: {
    auth: {
      set: (options: { path: { id: string }; body: OAuth }) => Promise<unknown>
    }
  }
}

type WebSocketFetch = ReturnType<typeof OpenAIWebSocketPool.createWebSocketFetch>

let oauthServer: Option.Option<ReturnType<typeof createServer>> = Option.none()
let pendingOAuth: Option.Option<PendingOAuth> = Option.none()

const randomBytes = (length: number) =>
  // eslint-disable-next-line effect/no-crypto-random-use-random -- (a) the PKCE verifier and OAuth state (RFC 7636) need the platform CSPRNG; Effect Random is ISAAC seeded with only 64 bits
  Effect.sync(() => crypto.getRandomValues(new Uint8Array(length)))

const generatePKCE = Effect.fn("CodexAuth.generatePKCE")(function* () {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(yield* randomBytes(43))
    .map((b) => chars[b % chars.length])
    .join("")
  const hash = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge: base64UrlEncode(hash) } satisfies PkceCodes
})

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function parseJwtClaims(token: string): Option.Option<IdTokenClaims> {
  const parts = token.split(".")
  if (parts.length !== 3) return Option.none()
  return decodeIdTokenClaims(Buffer.from(parts[1], "base64url").toString())
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

const accountIdFromToken = (token: string) =>
  parseJwtClaims(token).pipe(
    Option.flatMapNullishOr(extractAccountIdFromClaims),
    Option.filter((accountId) => accountId.length > 0),
  )

export function extractAccountId(tokens: TokenResponse): Option.Option<string> {
  const fromIdToken = tokens.id_token ? accountIdFromToken(tokens.id_token) : Option.none<string>()
  return Option.orElse(fromIdToken, () =>
    tokens.access_token ? accountIdFromToken(tokens.access_token) : Option.none<string>(),
  )
}

export function extractResidency(token: string): Option.Option<string> {
  return parseJwtClaims(token).pipe(
    Option.flatMapNullishOr(
      (claims) => claims["https://api.openai.com/auth"]?.chatgpt_compute_residency ?? claims.chatgpt_compute_residency,
    ),
    Option.filter((residency) => residency.length > 0 && residency !== "no_constraint"),
  )
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

// Read fetch at call time so a replaced global fetch applies.
const request = (url: string, init: RequestInit) =>
  Effect.tryPromise({
    try: () => fetch(url, init),
    catch: (cause) => new CodexAuthError({ message: errorMessage(cause), cause }),
  })

const readBody = (response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new CodexAuthError({ message: errorMessage(cause), cause }),
  })

const asAuthError = (cause: Schema.SchemaError) => new CodexAuthError({ message: cause.message, cause })

const requestTokens = Effect.fn("CodexAuth.requestTokens")(function* (
  issuer: string,
  action: "exchange" | "refresh",
  params: Record<string, string>,
) {
  const response = yield* request(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  })
  if (!response.ok) return yield* new CodexAuthError({ message: `Token ${action} failed: ${response.status}` })
  return yield* decodeTokenResponse(yield* readBody(response)).pipe(Effect.mapError(asAuthError))
})

const exchangeCodeForTokens = (code: string, redirectUri: string, verifier: string) =>
  requestTokens(ISSUER, "exchange", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  })

const refreshAccessToken = (refreshToken: string, issuer: string) =>
  requestTokens(issuer, "refresh", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  })

const expiresAt = Effect.fn("CodexAuth.expiresAt")(function* (tokens: TokenResponse) {
  const now = yield* Clock.currentTimeMillis
  return now + (tokens.expires_in ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000
})

// Kept as a named export for plugin.codex tests; delegates to the shared branded page.
export const renderOAuthError = (error: string) => OauthCallbackPage.error(error, { provider: "ChatGPT" })

function sendCallbackPage(res: ServerResponse, status: number, page: string) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
  res.end(page)
}

const rejectPending = Effect.fn("CodexAuth.rejectPending")(function* (message: string) {
  const current = pendingOAuth
  pendingOAuth = Option.none()
  if (Option.isSome(current)) yield* Deferred.fail(current.value.deferred, new CodexAuthError({ message }))
})

const handleOAuthRequest = Effect.fn("CodexAuth.handleOAuthRequest")(function* (
  req: IncomingMessage,
  res: ServerResponse,
) {
  const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`)

  if (url.pathname === "/cancel") {
    yield* rejectPending("Login cancelled")
    res.writeHead(200)
    res.end("Login cancelled")
    return
  }

  if (url.pathname !== "/auth/callback") {
    res.writeHead(404)
    res.end("Not found")
    return
  }

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")
  const errorDescription = url.searchParams.get("error_description")

  if (error) {
    const message = errorDescription || error
    yield* rejectPending(message)
    sendCallbackPage(res, 200, renderOAuthError(message))
    return
  }

  if (!code) {
    const message = "Missing authorization code"
    yield* rejectPending(message)
    sendCallbackPage(res, 400, renderOAuthError(message))
    return
  }

  const current = pendingOAuth
  if (Option.isNone(current) || state !== current.value.state) {
    const message = "Invalid state - potential CSRF attack"
    yield* rejectPending(message)
    sendCallbackPage(res, 400, renderOAuthError(message))
    return
  }

  pendingOAuth = Option.none()
  sendCallbackPage(res, 200, OauthCallbackPage.success({ provider: "ChatGPT" }))
  yield* Deferred.complete(
    current.value.deferred,
    exchangeCodeForTokens(code, OAUTH_REDIRECT_URI, current.value.pkce.verifier),
  )
})

const startOAuthServer = Effect.fn("CodexAuth.startOAuthServer")(function* () {
  if (Option.isSome(oauthServer)) return { port: OAUTH_PORT, redirectUri: OAUTH_REDIRECT_URI }

  // node:http calls this handler outside any fiber, so each request runs as its own fiber.
  const server = createServer((req, res) => Effect.runFork(handleOAuthRequest(req, res)))
  oauthServer = Option.some(server)

  yield* Effect.callback<void, CodexAuthError>((resume) => {
    server.listen(OAUTH_PORT, () => resume(Effect.void))
    server.on("error", (cause) => resume(Effect.fail(new CodexAuthError({ message: cause.message, cause }))))
  })

  return { port: OAUTH_PORT, redirectUri: OAUTH_REDIRECT_URI }
})

const stopOAuthServer = Effect.sync(() => {
  if (Option.isSome(oauthServer)) oauthServer.value.close()
  oauthServer = Option.none()
})

const expireOAuthCallback = Effect.fn("CodexAuth.expireOAuthCallback")(function* (
  deferred: Deferred.Deferred<TokenResponse, CodexAuthError>,
) {
  if (Option.isNone(pendingOAuth)) return
  pendingOAuth = Option.none()
  yield* Deferred.fail(
    deferred,
    new CodexAuthError({ message: "OAuth callback timeout - authorization took too long" }),
  )
})

const waitForOAuthCallback = Effect.fn("CodexAuth.waitForOAuthCallback")(function* (pkce: PkceCodes, state: string) {
  const deferred = yield* Deferred.make<TokenResponse, CodexAuthError>()
  pendingOAuth = Option.some({ pkce, state, deferred })

  // The timeout runs from the authorize call, even when no caller awaits the callback. It ends
  // early when the callback settles.
  yield* Deferred.await(deferred).pipe(
    Effect.timeoutOrElse({ duration: OAUTH_TIMEOUT, orElse: () => expireOAuthCallback(deferred) }),
    Effect.ignore,
    Effect.forkDetach,
  )
  return deferred
})

const authorizeBrowser = Effect.fn("CodexAuth.authorizeBrowser")(function* () {
  const { redirectUri } = yield* startOAuthServer()
  const pkce = yield* generatePKCE()
  const state = base64UrlEncode((yield* randomBytes(32)).buffer)
  const url = buildAuthorizeUrl(redirectUri, pkce, state)
  const deferred = yield* waitForOAuthCallback(pkce, state)

  const callback = Effect.gen(function* () {
    const tokens = yield* Deferred.await(deferred)
    yield* stopOAuthServer
    return {
      type: "success" as const,
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: yield* expiresAt(tokens),
      accountId: Option.getOrUndefined(extractAccountId(tokens)),
    }
  })

  const result: AuthOAuthResult = {
    url,
    instructions: "Complete authorization in your browser. This window will close automatically.",
    method: "auto",
    callback: () => Effect.runPromise(callback),
  }
  return result
})

function deviceHeaders() {
  return {
    "Content-Type": "application/json",
    "User-Agent": `opencode/${InstallationVersion}`,
  }
}

const pollDeviceToken = Effect.fn("CodexAuth.pollDeviceToken")(function* (device: DeviceCode, interval: number) {
  while (true) {
    const response = yield* request(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: deviceHeaders(),
      body: yield* encodeDeviceTokenRequest({
        device_auth_id: device.device_auth_id,
        user_code: device.user_code,
      }).pipe(Effect.mapError(asAuthError)),
    })

    if (response.ok) {
      const data = yield* decodeDeviceAuthorization(yield* readBody(response)).pipe(Effect.mapError(asAuthError))
      const tokens = yield* exchangeCodeForTokens(
        data.authorization_code,
        `${ISSUER}/deviceauth/callback`,
        data.code_verifier,
      )
      return {
        type: "success" as const,
        refresh: tokens.refresh_token,
        access: tokens.access_token,
        expires: yield* expiresAt(tokens),
        accountId: Option.getOrUndefined(extractAccountId(tokens)),
      }
    }

    if (response.status !== 403 && response.status !== 404) return { type: "failed" as const }

    yield* Effect.sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
  }
})

const authorizeHeadless = Effect.fn("CodexAuth.authorizeHeadless")(function* () {
  const deviceResponse = yield* request(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: deviceHeaders(),
    body: yield* encodeUserCodeRequest({ client_id: CLIENT_ID }).pipe(Effect.mapError(asAuthError)),
  })

  if (!deviceResponse.ok) return yield* new CodexAuthError({ message: "Failed to initiate device authorization" })

  const deviceData = yield* decodeDeviceCode(yield* readBody(deviceResponse)).pipe(Effect.mapError(asAuthError))
  const interval = Math.max(parseInt(String(deviceData.interval ?? "")) || 5, 1) * 1000

  const result: AuthOAuthResult = {
    url: `${ISSUER}/codex/device`,
    instructions: `Enter code: ${deviceData.user_code}`,
    method: "auto",
    callback: () => Effect.runPromise(pollDeviceToken(deviceData, interval)),
  }
  return result
})

// The AI SDK and the OpenAI provider send their own authorization header; the OAuth path replaces it.
function stripAuthorization(init: RequestInit | undefined) {
  if (!init?.headers) return
  if (init.headers instanceof Headers) {
    init.headers.delete("authorization")
    init.headers.delete("Authorization")
    return
  }
  if (Array.isArray(init.headers)) {
    init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization")
    return
  }
  delete init.headers["authorization"]
  delete init.headers["Authorization"]
}

function copyHeaders(init: RequestInit | undefined) {
  const headers = new Headers()
  if (!init?.headers) return headers
  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => headers.set(key, value))
    return headers
  }
  // Callers can pass undefined values at runtime; those headers are skipped.
  const entries = Array.isArray(init.headers) ? init.headers : Object.entries(init.headers)
  for (const [key, value] of entries) {
    if (value !== undefined) headers.set(key, value)
  }
  return headers
}

function isAllowedOAuthModel(apiID: string, reasoningMode: unknown) {
  if (reasoningMode === "pro") return false
  if (HashSet.has(ALLOWED_MODELS, apiID)) return true
  if (HashSet.has(DISALLOWED_MODELS, apiID)) return false
  if (apiID === "gpt-5.6") return false
  const match = apiID.match(/^gpt-(\d+)(?:\.(\d+))?/)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major > 5 || (major === 5 && minor > 4)
}

export function CodexAuthPlugin(input: CodexAuthInput, options: CodexAuthPluginOptions = {}): Promise<Hooks> {
  const issuer = options.issuer ?? ISSUER
  const codexApiEndpoint = options.codexApiEndpoint ?? CODEX_API_ENDPOINT
  let websocketFetchInstalled = false
  let websocketFetches: ReadonlyArray<WebSocketFetch> = []

  const loadOptions = Effect.fn("CodexAuth.loader")(function* (getAuth: () => Promise<Auth>) {
    // A rejection from the host auth reader passes through unchanged.
    const auth = yield* Effect.promise(() => getAuth())
    const websocketFetch = options.experimentalWebSockets
      ? Option.some(OpenAIWebSocketPool.createWebSocketFetch({ httpFetch: fetch }))
      : Option.none<WebSocketFetch>()
    if (Option.isSome(websocketFetch)) {
      websocketFetches = Arr.append(websocketFetches, websocketFetch.value)
      websocketFetchInstalled = true
    }
    if (auth.type !== "oauth") {
      return Option.match(websocketFetch, { onNone: () => ({}), onSome: (fetch) => ({ fetch }) })
    }

    // The AI SDK inspects a fetch rejection (abort, network failure), so a rejected request must
    // reach it unchanged. Effect.promise keeps the rejection as a defect, and runPromise rejects
    // with that same value.
    const send = (url: RequestInfo | URL, init: RequestInit | undefined) =>
      Effect.promise(() => (Option.isSome(websocketFetch) ? websocketFetch.value(url, init) : fetch(url, init)))

    const refreshSession = Effect.fn("CodexAuth.refreshSession")(function* (current: OAuth) {
      const tokens = yield* refreshAccessToken(current.refresh, issuer)
      const accountId = Option.orElse(extractAccountId(tokens), () => Option.fromNullishOr(current.accountId))
      const expires = yield* expiresAt(tokens)
      yield* Effect.tryPromise({
        try: () =>
          input.client.auth.set({
            path: { id: "openai" },
            body: {
              type: "oauth",
              refresh: tokens.refresh_token,
              access: tokens.access_token,
              expires,
              ...Option.match(accountId, { onNone: () => ({}), onSome: (accountId) => ({ accountId }) }),
            },
          }),
        catch: (cause) => new CodexAuthError({ message: errorMessage(cause), cause }),
      })
      return { access: tokens.access_token, accountId } satisfies RefreshedSession
    })

    // Concurrent requests share one in-flight refresh. The lock makes the check and the fork atomic.
    const refreshLock = Semaphore.makeUnsafe(1)
    let inflight: Option.Option<Fiber.Fiber<RefreshedSession, CodexAuthError>> = Option.none()
    const refresh = Effect.fn("CodexAuth.refresh")(function* (current: OAuth) {
      const fiber = yield* refreshLock.withPermits(1)(
        Effect.gen(function* () {
          if (Option.isSome(inflight)) return inflight.value
          const started = yield* Effect.forkDetach(refreshSession(current))
          inflight = Option.some(started)
          return started
        }),
      )
      return yield* Fiber.join(fiber).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (Option.isSome(inflight) && inflight.value === fiber) inflight = Option.none()
          }),
        ),
      )
    })

    const codexFetch = Effect.fn("CodexAuth.fetch")(function* (requestInput: RequestInfo | URL, init?: RequestInit) {
      stripAuthorization(init)

      const currentAuth = yield* Effect.promise(() => getAuth())
      if (currentAuth.type !== "oauth") return yield* send(requestInput, init)

      const now = yield* Clock.currentTimeMillis
      const session: RefreshedSession =
        !currentAuth.access || currentAuth.expires < now
          ? yield* refresh(currentAuth)
          : { access: currentAuth.access, accountId: Option.fromNullishOr(currentAuth.accountId) }

      const headers = copyHeaders(init)
      headers.set("authorization", `Bearer ${session.access}`)
      if (Option.isSome(session.accountId)) headers.set("ChatGPT-Account-Id", session.accountId.value)

      const parsed =
        requestInput instanceof URL
          ? requestInput
          : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
      const rewrite = parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
      const url = rewrite ? new URL(codexApiEndpoint) : parsed
      if (rewrite) {
        const residency = extractResidency(session.access)
        if (Option.isSome(residency)) headers.set("x-openai-internal-codex-residency", residency.value)
      }

      const requestInit = {
        ...init,
        body: init?.body,
        headers,
      }
      if (Option.isSome(websocketFetch) && parsed.pathname.endsWith("/responses")) {
        return yield* Effect.promise(() => websocketFetch.value(url, requestInit))
      }
      return yield* Effect.promise(() => fetch(url, OpenAIWebSocketPool.withoutInternalHeaders(requestInit)))
    })

    return {
      apiKey: OAUTH_DUMMY_KEY,
      fetch: (requestInput: RequestInfo | URL, init?: RequestInit) => Effect.runPromise(codexFetch(requestInput, init)),
    }
  })

  const hooks: Hooks = {
    dispose: () =>
      Effect.runPromise(
        Effect.sync(() => {
          for (const websocketFetch of websocketFetches) websocketFetch.close()
          websocketFetches = []
        }),
      ),
    event: (input) =>
      Effect.runPromise(
        Effect.sync(() => {
          if (input.event.type !== "session.deleted") return
          for (const websocketFetch of websocketFetches) websocketFetch.remove(input.event.properties.info.id)
        }),
      ),
    provider: {
      id: "openai",
      models: (provider, ctx) =>
        Effect.runPromise(
          Effect.sync(() => {
            if (ctx.auth?.type !== "oauth") return provider.models

            return Object.fromEntries(
              Object.entries(provider.models)
                .filter(([, model]) => isAllowedOAuthModel(model.api.id, model.options.reasoningMode))
                .map(([modelID, model]) => [
                  modelID,
                  {
                    ...model,
                    cost: {
                      input: 0,
                      output: 0,
                      cache: { read: 0, write: 0 },
                    },
                    limit:
                      model.id.includes("gpt-5.5") || model.id.includes("gpt-5.6")
                        ? {
                            context: 400_000,
                            input: 272_000,
                            output: 128_000,
                          }
                        : model.limit,
                  },
                ]),
            )
          }),
        ),
    },
    auth: {
      provider: "openai",
      loader: (getAuth) => Effect.runPromise(loadOptions(getAuth)),
      methods: [
        {
          label: "ChatGPT Pro/Plus (browser)",
          type: "oauth",
          authorize: () => Effect.runPromise(authorizeBrowser()),
        },
        {
          label: "ChatGPT Pro/Plus (headless)",
          type: "oauth",
          authorize: () => Effect.runPromise(authorizeHeadless()),
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
    "chat.headers": (input, output) =>
      Effect.runPromise(
        Effect.sync(() => {
          if (input.model.providerID !== "openai") return
          output.headers.originator = "opencode"
          output.headers["User-Agent"] =
            `opencode/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`
          output.headers["session-id"] = input.sessionID
          // Temporary fetch-layer hack: title generation currently shares the conversation
          // session ID, so the OpenAI plugin marks it for HTTP fallback until transport
          // context can be passed directly instead of smuggled through headers.
          if (websocketFetchInstalled && input.agent === "title") {
            output.headers[OpenAIWebSocketPool.TITLE_HEADER] = "true"
          }
        }),
      ),
    "chat.params": (input, output) =>
      Effect.runPromise(
        Effect.sync(() => {
          if (input.model.providerID !== "openai") return
          // Match codex cli
          // eslint-disable-next-line effect/no-undefined-use-option -- (a) the plugin SDK chat.params output declares maxOutputTokens as number | undefined, and the JavaScript undefined value clears the limit
          output.maxOutputTokens = undefined
        }),
      ),
  }
  return Effect.runPromise(Effect.succeed(hooks))
}
