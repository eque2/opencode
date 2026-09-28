import type { AuthOAuthResult, Hooks } from "@opencode-ai/plugin"
import type { Auth, OAuth } from "@opencode-ai/sdk/v2"
import { OAUTH_DUMMY_KEY } from "../auth"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { Clock, Deferred, Effect, Fiber, Function, Option, Schema, Semaphore, Stream } from "effect"
import { createServer, type IncomingMessage, type ServerResponse } from "http"
import open from "open"
import { errorMessage } from "../util/error"

const OAUTH_CLIENT_ID = "LOCAL_APPLICATION"
const OAUTH_CALLBACK_HOST = "127.0.0.1"
const OAUTH_CALLBACK_PATH = "/"
const OAUTH_TIMEOUT = "5 minutes"
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000
const DEFAULT_TOKEN_LIFETIME_SECONDS = 600

export class SnowflakeAuthError extends Schema.TaggedError<SnowflakeAuthError>()("SnowflakeAuth.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// Snowflake may send null for an absent field, so each optional field also accepts null.
const TokenResponse = Schema.Struct({
  access_token: Schema.optional(Schema.NullOr(Schema.String)),
  refresh_token: Schema.optional(Schema.NullOr(Schema.String)),
  expires_in: Schema.optional(Schema.NullOr(Schema.Number)),
}).annotate({ identifier: "SnowflakeTokenResponse" })
type TokenResponse = typeof TokenResponse.Type
const decodeTokenResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(TokenResponse))

const ErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "SnowflakeErrorBody" })
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))

const decodeJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject))
const encodeJsonObject = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.JsonObject))

interface PkceCodes {
  verifier: string
  challenge: string
}

interface Tokens {
  access: string
  refresh: string
  expires: number
}

interface PendingOAuth {
  account: string
  state: string
  verifier: string
  redirectUri: string
  deferred: Deferred.Deferred<Tokens, SnowflakeAuthError>
}

/** The part of the plugin input that this plugin uses: it persists refreshed OAuth tokens. */
export interface SnowflakeCortexInput {
  client: {
    auth: {
      set: (options: { path: { id: string }; body: OAuth }) => Promise<unknown>
    }
  }
}

let oauthServer: Option.Option<ReturnType<typeof createServer>> = Option.none()
let oauthServerPort: Option.Option<number> = Option.none()
let pendingOAuth: Option.Option<PendingOAuth> = Option.none()

function normalizeAccount(input: string) {
  return input
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\.snowflakecomputing\.com\/?$/, "")
    .replace(/\/+$/, "")
}

const generateRandomString = (length: number) =>
  Effect.sync(() => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    // eslint-disable-next-line effect/no-crypto-random-use-random -- (a) the PKCE verifier and OAuth state (RFC 7636) need the platform CSPRNG; Effect Random is ISAAC seeded with only 64 bits
    return Array.from(crypto.getRandomValues(new Uint8Array(length)))
      .map((b) => chars[b % chars.length])
      .join("")
  })

function base64UrlEncode(buffer: ArrayBuffer) {
  const binary = String.fromCharCode(...new Uint8Array(buffer))
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const generatePKCE = Effect.fn("SnowflakeCortex.generatePKCE")(function* () {
  const verifier = yield* generateRandomString(64)
  const hash = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge: base64UrlEncode(hash) } satisfies PkceCodes
})

const callbackUrl = Effect.suspend(() =>
  Option.match(oauthServerPort, {
    onNone: () => Effect.fail(new SnowflakeAuthError({ message: "Snowflake OAuth callback server is not running" })),
    onSome: (port) => Effect.succeed(`http://${OAUTH_CALLBACK_HOST}:${port}${OAUTH_CALLBACK_PATH}`),
  }),
)

export function oauthScope(role: string | undefined) {
  if (!role) return "refresh_token"
  return /^[-_A-Za-z0-9]+$/.test(role)
    ? `refresh_token session:role:${role}`
    : `refresh_token session:role-encoded:${encodeURIComponent(role)}`
}

function authHeaders() {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": `opencode/${InstallationVersion}`,
    Authorization: `Basic ${Buffer.from(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_ID}`).toString("base64")}`,
  }
}

function buildAuthorizeUrl(account: string, role: string, state: string, challenge: string, redirectUri: string) {
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: oauthScope(role),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  return `https://${account}.snowflakecomputing.com/oauth/authorize?${params.toString()}`
}

const expiresAt = Effect.fn("SnowflakeCortex.expiresAt")(function* (token: TokenResponse) {
  const now = yield* Clock.currentTimeMillis
  return now + (token.expires_in ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000
})

const requestToken = Effect.fn("SnowflakeCortex.requestToken")(function* (
  account: string,
  action: "exchange" | "refresh",
  params: Record<string, string>,
) {
  const response = yield* Effect.tryPromise({
    // Read fetch at call time so a replaced global fetch applies.
    try: () =>
      fetch(`https://${account}.snowflakecomputing.com/oauth/token-request`, {
        method: "POST",
        headers: authHeaders(),
        body: new URLSearchParams(params).toString(),
      }),
    catch: (cause) => new SnowflakeAuthError({ message: errorMessage(cause), cause }),
  })

  if (!response.ok) {
    const detail = yield* Effect.tryPromise(() => response.text()).pipe(Effect.orElseSucceed(() => ""))
    return yield* new SnowflakeAuthError({
      message: `Snowflake token ${action} failed (${response.status})${detail ? `: ${detail}` : ""}`,
    })
  }

  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new SnowflakeAuthError({ message: errorMessage(cause), cause }),
  })
  return yield* decodeTokenResponse(body).pipe(
    Effect.mapError((cause) => new SnowflakeAuthError({ message: cause.message, cause })),
  )
})

const exchangeCodeForToken = Effect.fn("SnowflakeCortex.exchangeCodeForToken")(function* (
  pending: Pick<PendingOAuth, "account" | "verifier" | "redirectUri">,
  code: string,
) {
  const token = yield* requestToken(pending.account, "exchange", {
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirectUri,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: pending.verifier,
  })
  if (!token.access_token) {
    return yield* new SnowflakeAuthError({ message: "Snowflake token response did not include access_token" })
  }
  if (!token.refresh_token) {
    return yield* new SnowflakeAuthError({
      message:
        "Snowflake token response did not include refresh_token. Ensure integration issues refresh tokens and scope includes refresh_token.",
    })
  }
  return { access: token.access_token, refresh: token.refresh_token, expires: yield* expiresAt(token) } satisfies Tokens
})

const refreshAccessToken = Effect.fn("SnowflakeCortex.refreshAccessToken")(function* (
  account: string,
  refreshToken: string,
) {
  const token = yield* requestToken(account, "refresh", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  })
  if (!token.access_token) {
    return yield* new SnowflakeAuthError({ message: "Snowflake refresh response did not include access_token" })
  }
  return {
    access: token.access_token,
    refresh: token.refresh_token || refreshToken,
    expires: yield* expiresAt(token),
  } satisfies Tokens
})

function sendCallbackPage(res: ServerResponse, status: number, page: string) {
  res.writeHead(status, { "Content-Type": "text/html" })
  res.end(page)
}

const handleOAuthCallback = Effect.fn("SnowflakeCortex.handleOAuthCallback")(function* (
  req: IncomingMessage,
  res: ServerResponse,
) {
  const host = req.headers.host || `${OAUTH_CALLBACK_HOST}:${Option.getOrElse(oauthServerPort, () => 0)}`
  const url = new URL(req.url || "/", `http://${host}`)

  if (url.pathname !== OAUTH_CALLBACK_PATH) {
    res.writeHead(404)
    res.end("Not found")
    return
  }

  const state = url.searchParams.get("state")
  const code = url.searchParams.get("code")
  const error = url.searchParams.get("error")
  const errorDescription = url.searchParams.get("error_description")
  const current = pendingOAuth
  pendingOAuth = Option.none()

  // CSRF guard: validate state before processing any callback
  if (Option.isNone(current) || state !== current.value.state) {
    const message = "Invalid state - potential CSRF attack"
    if (Option.isSome(current)) yield* Deferred.fail(current.value.deferred, new SnowflakeAuthError({ message }))
    sendCallbackPage(res, 400, OauthCallbackPage.error(message, { provider: "Snowflake" }))
    return
  }

  if (error) {
    const message = errorDescription || error
    yield* Deferred.fail(current.value.deferred, new SnowflakeAuthError({ message }))
    sendCallbackPage(res, 200, OauthCallbackPage.error(message, { provider: "Snowflake" }))
    return
  }

  if (!code) {
    const message = "Missing authorization code"
    yield* Deferred.fail(current.value.deferred, new SnowflakeAuthError({ message }))
    sendCallbackPage(res, 400, OauthCallbackPage.error(message, { provider: "Snowflake" }))
    return
  }

  sendCallbackPage(res, 200, OauthCallbackPage.success({ provider: "Snowflake" }))
  yield* Deferred.complete(current.value.deferred, exchangeCodeForToken(current.value, code))
})

const startOAuthServer = Effect.fn("SnowflakeCortex.startOAuthServer")(function* () {
  if (Option.isSome(oauthServer)) return

  // node:http calls this handler outside any fiber, so each request runs as its own fiber.
  const server = createServer((req, res) => Effect.runFork(handleOAuthCallback(req, res)))
  oauthServer = Option.some(server)

  yield* Effect.callback<void, SnowflakeAuthError>((resume) => {
    server.listen(0, OAUTH_CALLBACK_HOST, () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        resume(Effect.fail(new SnowflakeAuthError({ message: "Unable to resolve Snowflake OAuth callback port" })))
        return
      }
      oauthServerPort = Option.some(address.port)
      resume(Effect.void)
    })
    server.on("error", (cause) => resume(Effect.fail(new SnowflakeAuthError({ message: cause.message, cause }))))
  })
})

const stopOAuthServer = Effect.sync(() => {
  if (Option.isSome(oauthServer)) oauthServer.value.close()
  oauthServer = Option.none()
  oauthServerPort = Option.none()
})

const expireOAuthCallback = Effect.fn("SnowflakeCortex.expireOAuthCallback")(function* (
  deferred: Deferred.Deferred<Tokens, SnowflakeAuthError>,
) {
  if (Option.isNone(pendingOAuth) || pendingOAuth.value.deferred !== deferred) return
  pendingOAuth = Option.none()
  yield* stopOAuthServer
  yield* Deferred.fail(
    deferred,
    new SnowflakeAuthError({ message: "Snowflake OAuth callback timeout - authorization took too long" }),
  )
})

const waitForOAuthCallback = Effect.fn("SnowflakeCortex.waitForOAuthCallback")(function* (
  pending: Omit<PendingOAuth, "deferred">,
) {
  if (Option.isSome(pendingOAuth)) {
    yield* Deferred.fail(
      pendingOAuth.value.deferred,
      new SnowflakeAuthError({ message: "Superseded by a newer Snowflake authorize request" }),
    )
    pendingOAuth = Option.none()
  }

  const deferred = yield* Deferred.make<Tokens, SnowflakeAuthError>()
  pendingOAuth = Option.some({ ...pending, deferred })

  // The timeout runs from the authorize call, even when no caller awaits the callback. It ends
  // early when the callback settles, and it stops the callback server when it fires.
  yield* Deferred.await(deferred).pipe(
    Effect.timeoutOrElse({ duration: OAUTH_TIMEOUT, orElse: () => expireOAuthCallback(deferred) }),
    Effect.ignore,
    Effect.forkDetach,
  )
  return deferred
})

const authorize = Effect.fn("SnowflakeCortex.authorize")(function* (inputs: Record<string, string>) {
  const account = normalizeAccount(inputs.account || "")
  if (!account) return yield* new SnowflakeAuthError({ message: "Snowflake account is required" })

  yield* startOAuthServer()
  const pkce = yield* generatePKCE()
  const state = yield* generateRandomString(64)
  const role = (inputs.role || "").trim()
  const redirectUri = yield* callbackUrl
  const url = buildAuthorizeUrl(account, role, state, pkce.challenge, redirectUri)
  const deferred = yield* waitForOAuthCallback({ account, state, verifier: pkce.verifier, redirectUri })
  yield* Effect.tryPromise(() => open(url)).pipe(Effect.ignore)

  const callback = Deferred.await(deferred).pipe(
    Effect.map((tokens) => ({
      type: "success" as const,
      refresh: tokens.refresh,
      access: tokens.access,
      expires: tokens.expires,
      accountId: account,
    })),
    Effect.orElseSucceed(() => ({ type: "failed" as const })),
    Effect.ensuring(stopOAuthServer),
  )

  const result: AuthOAuthResult = {
    url,
    instructions:
      "Complete Snowflake sign-in in your browser. OpenCode will capture the OAuth callback and store the bearer token automatically.",
    method: "auto",
    callback: () => Effect.runPromise(callback),
  }
  return result
})

function persistTokens(input: SnowflakeCortexInput, accountId: string, tokens: Tokens) {
  return Effect.tryPromise(() =>
    input.client.auth.set({
      path: { id: "snowflake-cortex" },
      body: { type: "oauth", access: tokens.access, refresh: tokens.refresh, expires: tokens.expires, accountId },
    }),
  ).pipe(Effect.ignore)
}

function initHeaderEntries(headers: HeadersInit): Iterable<readonly [string, string | undefined]> {
  if (headers instanceof Headers) return headers.entries()
  if (Array.isArray(headers)) return headers
  // Callers can pass a record with undefined values at runtime; those headers are skipped.
  return Object.entries<string | undefined>(headers)
}

function renameMaxTokens(body: string) {
  return decodeJsonObject(body).pipe(
    Option.filter((parsed) => "max_tokens" in parsed),
    Option.flatMap(({ max_tokens, ...rest }) => encodeJsonObject({ ...rest, max_completion_tokens: max_tokens })),
    Option.getOrElse(() => body),
  )
}

function prepareRequest(requestInput: RequestInfo | URL, init: RequestInit | undefined, access: string) {
  const headers = requestInput instanceof Request ? new Headers(requestInput.headers) : new Headers()
  if (init?.headers) {
    for (const [key, value] of initHeaderEntries(init.headers)) {
      if (value !== undefined) headers.set(key, value)
    }
  }
  headers.set("authorization", `Bearer ${access}`)
  headers.set("User-Agent", `opencode/${InstallationVersion}`)

  const body = init?.body && typeof init.body === "string" ? renameMaxTokens(init.body) : init?.body
  return { ...init, headers, body }
}

const transformResponse = Effect.fn("SnowflakeCortex.transformResponse")(function* (response: Response) {
  if (!response.ok && response.status === 400) {
    const text = yield* Effect.tryPromise(() => response.clone().text()).pipe(Effect.option)
    const message = Option.flatMap(text, decodeErrorBody).pipe(
      Option.map((body) => body.message || body.error || ""),
      Option.getOrElse(() => ""),
    )
    if (message.toLowerCase().includes("conversation complete")) {
      return Response.json(
        { choices: [{ finish_reason: "stop", message: { content: "", role: "assistant" } }] },
        { status: 200, headers: new Headers({ "content-type": "application/json" }) },
      )
    }
  }

  const body = response.body
  if (body && response.headers.get("content-type")?.includes("text/event-stream")) {
    const stream = Stream.fromReadableStream({ evaluate: () => body, onError: Function.identity }).pipe(
      Stream.decodeText(),
      Stream.map((text) => text.replace(/"role"\s*:\s*""/g, '"role":"assistant"')),
      Stream.encodeText,
      Stream.toReadableStream(),
    )
    return new Response(stream, { headers: response.headers, status: response.status })
  }

  return response
})

const loadOptions = Effect.fn("SnowflakeCortex.loader")(function* (
  input: SnowflakeCortexInput,
  getAuth: () => Promise<Auth>,
) {
  // A rejection from the host auth reader passes through unchanged.
  const auth = yield* Effect.promise(() => getAuth())
  if (auth.type !== "oauth") return {}

  const now = yield* Clock.currentTimeMillis
  if (auth.accountId && auth.refresh && auth.expires && auth.expires <= now) {
    const accountId = auth.accountId
    yield* refreshAccessToken(accountId, auth.refresh).pipe(
      Effect.flatMap((tokens) => persistTokens(input, accountId, tokens)),
      Effect.ignore,
    )
  }

  // Concurrent requests share one in-flight refresh. The lock makes the check and the fork atomic.
  const refreshLock = Semaphore.makeUnsafe(1)
  let inflight: Option.Option<Fiber.Fiber<Tokens, SnowflakeAuthError>> = Option.none()
  const refresh = (accountId: string, refreshToken: string) =>
    refreshLock
      .withPermits(1)(
        Effect.gen(function* () {
          if (Option.isSome(inflight)) return inflight.value
          const fiber = yield* refreshAccessToken(accountId, refreshToken).pipe(
            Effect.tap((tokens) => persistTokens(input, accountId, tokens)),
            Effect.ensuring(
              Effect.sync(() => {
                inflight = Option.none()
              }),
            ),
            Effect.forkDetach,
          )
          inflight = Option.some(fiber)
          return fiber
        }),
      )
      .pipe(Effect.flatMap(Fiber.join))

  // The AI SDK inspects a fetch rejection (abort, network failure), so a rejected request must
  // reach it unchanged. Effect.promise keeps the rejection as a defect, and runPromise rejects
  // with that same value.
  const send = (requestInput: RequestInfo | URL, init: RequestInit) => Effect.promise(() => fetch(requestInput, init))

  const authorizedFetch = Effect.fn("SnowflakeCortex.fetch")(function* (
    requestInput: RequestInfo | URL,
    init?: RequestInit,
  ) {
    const current = yield* Effect.promise(() => getAuth())
    if (current.type !== "oauth") return yield* Effect.promise(() => fetch(requestInput, init))
    const accountId = current.accountId
    if (!accountId) return yield* new SnowflakeAuthError({ message: "Snowflake OAuth auth is missing accountId" })

    const at = yield* Clock.currentTimeMillis
    const expiresSoon = !current.expires || !current.access || current.expires - at <= ACCESS_TOKEN_REFRESH_SKEW_MS
    const session: Tokens = expiresSoon ? yield* refresh(accountId, current.refresh) : current

    const response = yield* send(requestInput, prepareRequest(requestInput, init, session.access))
    if (response.status !== 401) return yield* transformResponse(response)

    const refreshed = yield* refresh(accountId, session.refresh)
    return yield* transformResponse(yield* send(requestInput, prepareRequest(requestInput, init, refreshed.access)))
  })

  return {
    apiKey: OAUTH_DUMMY_KEY,
    fetch: (requestInput: RequestInfo | URL, init?: RequestInit) =>
      Effect.runPromise(authorizedFetch(requestInput, init)),
  }
})

export function SnowflakeCortexAuthPlugin(input: SnowflakeCortexInput): Promise<Hooks> {
  const prompts = [
    {
      type: "text" as const,
      key: "account",
      message: "Snowflake Account Identifier",
      placeholder: "myorg-myaccount",
      validate: (value: string) => {
        if (value && value.trim().length > 0) return undefined
        return "Required"
      },
    },
    {
      type: "text" as const,
      key: "role",
      message: "Snowflake Role (optional)",
      placeholder: "PUBLIC",
    },
  ]

  return Effect.runPromise(
    Effect.sync(
      (): Hooks => ({
        auth: {
          provider: "snowflake-cortex",
          loader: (getAuth) => Effect.runPromise(loadOptions(input, getAuth)),
          methods: [
            {
              type: "oauth",
              label: "Login with Snowflake (External Browser)",
              prompts,
              authorize: (inputs = {}) => Effect.runPromise(authorize(inputs)),
            },
            {
              type: "api",
              label: "Paste PAT or bearer token manually",
              prompts: prompts.filter((item) => item.key === "account"),
            },
          ],
        },
      }),
    ),
  )
}
