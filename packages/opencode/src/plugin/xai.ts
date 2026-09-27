import type { Hooks } from "@opencode-ai/plugin"
import { Clock, Duration, Effect, Fiber, Option, Schema, SynchronizedRef } from "effect"
import { OAUTH_DUMMY_KEY } from "../auth"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { errorMessage } from "../util/error"

// Public Grok-CLI OAuth client.
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const TOKEN_URL = "https://auth.x.ai/oauth2/token"
// RFC 8628 device authorization grant. Confirmed exposed by xAI's
// /.well-known/openid-configuration as `device_authorization_endpoint`
// with the matching `urn:ietf:params:oauth:grant-type:device_code` grant
// in `grant_types_supported`. This is the headless / VPS path: no
// loopback callback server, no SSH port forwarding, no inbound firewall
// holes — the user opens the URL on any device with a browser, types
// the short user_code, and the CLI long-polls the token endpoint.
const DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code"
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
const SCOPE = "openid profile email offline_access grok-cli:access api:access"

// Bounds for the device-code poll loop. xAI returns `interval` (seconds)
// but we floor it to avoid hammering and we add the spec's slow_down
// increment when xAI explicitly asks us to back off.
const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000

// Refresh the access token a little before it actually expires so a single
// long-running tool call doesn't have to recover from a mid-flight 401.
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000

interface XaiAuthPluginOptions {
  tokenUrl?: string
  deviceAuthorizationUrl?: string
}

export class XaiAuthError extends Schema.TaggedError<XaiAuthError>()("XaiAuth.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  // xAI may omit a rotated refresh_token; the caller then keeps the previous one.
  refresh_token: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
  token_type: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
}).annotate({ identifier: "XaiTokenResponse" })
type TokenResponse = typeof TokenResponse.Type
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse)

// A misbehaving device-code endpoint can send garbage such as `NaN`, `"NaN"` or
// `null` for these second counts; positiveSecondsToMs normalizes them.
const WireSeconds = Schema.Union([Schema.Number, Schema.String, Schema.Null])

const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.NonEmptyString,
  user_code: Schema.NonEmptyString,
  verification_uri: Schema.NonEmptyString,
  verification_uri_complete: Schema.optional(Schema.NullOr(Schema.String)),
  expires_in: Schema.optional(WireSeconds),
  interval: Schema.optional(WireSeconds),
}).annotate({ identifier: "XaiDeviceCodeResponse" })
export type DeviceCodeResponse = typeof DeviceCodeResponse.Type
const decodeDeviceCodeResponse = Schema.decodeUnknownEffect(DeviceCodeResponse)

const DeviceTokenErrorBody = Schema.Struct({
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
}).annotate({ identifier: "XaiDeviceTokenErrorBody" })
type DeviceTokenErrorBody = typeof DeviceTokenErrorBody.Type
const decodeDeviceTokenErrorBody = Schema.decodeUnknownEffect(DeviceTokenErrorBody)

const JwtClaims = Schema.Struct({ exp: Schema.Number }).annotate({ identifier: "XaiJwtClaims" })
const decodeJwtClaims = Schema.decodeUnknownOption(Schema.fromJsonString(JwtClaims))

// The plugin persists rotated tokens through the host auth store and needs
// nothing else from its input. The SDK client in PluginInput satisfies this.
export type XaiAuthRecord = {
  path: { id: string }
  body: { type: "oauth"; access: string; refresh: string; expires: number }
}
export type XaiPluginInput = { client: { auth: { set(request: XaiAuthRecord): PromiseLike<unknown> } } }
function authHeaders() {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": `opencode/${InstallationVersion}`,
  }
}

const postForm = (url: string, form: Record<string, string>) =>
  Effect.tryPromise({
    try: () =>
      fetch(url, {
        method: "POST",
        headers: authHeaders(),
        body: new URLSearchParams(form).toString(),
      }),
    catch: (cause) => new XaiAuthError({ message: errorMessage(cause), cause }),
  })

const readJson = (response: Response) =>
  Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: (cause) => new XaiAuthError({ message: errorMessage(cause), cause }),
  })

const readDetail = (response: Response) =>
  Effect.tryPromise(() => response.text()).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map((detail) => (detail ? `: ${detail}` : "")),
  )

const readTokens = (response: Response) =>
  readJson(response).pipe(
    Effect.flatMap(decodeTokenResponse),
    Effect.mapError((cause) =>
      cause instanceof XaiAuthError ? cause : new XaiAuthError({ message: "xAI token response is invalid", cause }),
    ),
  )

// Parse the `exp` claim out of a JWT access_token without verifying the
// signature. We only use this to decide whether to proactively refresh, never
// to make trust decisions, so unsigned decode is safe. Returns false for
// opaque tokens (no JWT shape), which conservatively skips the proactive
// refresh and lets the 401-on-call path drive the refresh instead.
export const accessTokenIsExpiring = Effect.fn("XaiAuth.accessTokenIsExpiring")(function* (
  token: string | undefined,
  skewMs: number = ACCESS_TOKEN_REFRESH_SKEW_MS,
) {
  if (!token) return false
  const parts = token.split(".")
  if (parts.length < 2) return false
  const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
  const claims = decodeJwtClaims(Buffer.from(padded, "base64").toString("utf8"))
  if (Option.isNone(claims)) return false
  const now = yield* Clock.currentTimeMillis
  return claims.value.exp * 1000 <= now + Math.max(0, skewMs)
})

const refreshAccessToken = Effect.fn("XaiAuth.refreshAccessToken")(function* (
  refreshToken: string,
  options: XaiAuthPluginOptions,
) {
  const response = yield* postForm(options.tokenUrl ?? TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  })
  if (!response.ok) {
    const detail = yield* readDetail(response)
    return yield* new XaiAuthError({ message: `xAI token refresh failed (${response.status})${detail}` })
  }
  return yield* readTokens(response)
})

export const requestDeviceCode = Effect.fn("XaiAuth.requestDeviceCode")(function* (
  options: XaiAuthPluginOptions = {},
) {
  const response = yield* postForm(options.deviceAuthorizationUrl ?? DEVICE_AUTHORIZATION_URL, {
    client_id: CLIENT_ID,
    scope: SCOPE,
    referrer: "opencode",
  })
  if (!response.ok) {
    const detail = yield* readDetail(response)
    return yield* new XaiAuthError({ message: `xAI device code request failed (${response.status})${detail}` })
  }
  const json = yield* readJson(response)
  return yield* decodeDeviceCodeResponse(json).pipe(
    Effect.mapError(
      (cause) =>
        new XaiAuthError({
          message: "xAI device code response is missing device_code / user_code / verification_uri",
          cause,
        }),
    ),
  )
})

// Normalize a server-supplied seconds value to milliseconds, falling back to
// the supplied default when the input is missing, non-positive, or not a
// finite number. Defends the polling loop against garbage like `NaN`, `"NaN"`,
// `null`, or `-5` from a misbehaving device-code endpoint — without this,
// a NaN interval would slip through `?? default` (NaN is typeof number),
// reach a zero-length sleep, and busy-loop until the hard deadline. Matches
// the defensive normalization Codex uses for the same field
// (`parseInt(deviceData.interval) || 5`).
function positiveSecondsToMs(value: unknown, defaultMs: number): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs
}

// Polls the token endpoint until xAI grants, refuses, or the device code
// expires. The Clock service supplies the time and the waits between polls,
// so a test can run the loop against a controlled clock.
export const pollDeviceCodeToken = Effect.fn("XaiAuth.pollDeviceCodeToken")(function* (
  device: DeviceCodeResponse,
  options: XaiAuthPluginOptions = {},
) {
  const expiresInMs = positiveSecondsToMs(device.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS)
  const deadline = (yield* Clock.currentTimeMillis) + expiresInMs

  const poll = (intervalMs: number): Effect.Effect<TokenResponse, XaiAuthError> =>
    Effect.gen(function* () {
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* new XaiAuthError({ message: "xAI device authorization timed out" })
      }
      const response = yield* postForm(options.tokenUrl ?? TOKEN_URL, {
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: CLIENT_ID,
        device_code: device.device_code,
      })
      if (response.ok) return yield* readTokens(response)

      const body = yield* readJson(response).pipe(
        Effect.flatMap(decodeDeviceTokenErrorBody),
        Effect.orElseSucceed((): DeviceTokenErrorBody => ({})),
      )
      const remaining = Math.max(0, deadline - (yield* Clock.currentTimeMillis))
      // RFC 8628 §3.5: authorization_pending = keep polling at the same
      // interval; slow_down = bump the interval by ≥5s and keep polling.
      // Anything else is terminal.
      if (body.error === "authorization_pending" || body.error === "slow_down") {
        const next = body.error === "slow_down" ? intervalMs + DEVICE_CODE_SLOW_DOWN_INCREMENT_MS : intervalMs
        yield* Effect.sleep(Duration.millis(Math.min(next + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining)))
        return yield* poll(next)
      }
      if (body.error === "access_denied" || body.error === "authorization_denied") {
        return yield* new XaiAuthError({ message: "xAI device authorization was denied" })
      }
      if (body.error === "expired_token") {
        return yield* new XaiAuthError({ message: "xAI device code expired - please re-run login" })
      }
      const detail = body.error_description ?? body.error ?? ""
      return yield* new XaiAuthError({
        message: `xAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`,
      })
    })

  return yield* poll(
    Math.max(positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS), DEVICE_CODE_MIN_INTERVAL_MS),
  )
})

interface RefreshResult {
  access: string
  refresh: string
  expires: number
}

// Lists the caller's headers as entries. A plain-object HeadersInit can carry
// undefined values at runtime, so the entry values allow undefined.
function headerEntries(init: HeadersInit): ReadonlyArray<readonly [string, string | undefined]> {
  if (init instanceof Headers) return [...init.entries()]
  if (Array.isArray(init)) return init.map(([key, value]) => [key, value] as const)
  return Object.entries(init)
}

export function XaiAuthPlugin(input: XaiPluginInput, options: XaiAuthPluginOptions = {}): Promise<Hooks> {
  const refresh = Effect.fn("XaiAuth.refresh")(function* (refreshToken: string) {
    const tokens = yield* refreshAccessToken(refreshToken, options)
    const refreshedExpires = (yield* Clock.currentTimeMillis) + (tokens.expires_in ?? 3600) * 1000
    const refreshedRefresh = tokens.refresh_token || refreshToken
    // Persist the rotated pair as best-effort. xAI has already consumed the
    // old refresh_token by the time we get here; an auth.set failure leaves
    // the on-disk state stale but the in-memory result is still valid for
    // this turn. The next live refresh against the stale disk state will
    // 4xx and force re-login — a known cross-process limitation.
    yield* Effect.tryPromise(() =>
      input.client.auth.set({
        path: { id: "xai" },
        body: {
          type: "oauth",
          access: tokens.access_token,
          refresh: refreshedRefresh,
          expires: refreshedExpires,
        },
      }),
    ).pipe(Effect.ignore)
    const result: RefreshResult = { access: tokens.access_token, refresh: refreshedRefresh, expires: refreshedExpires }
    return result
  })

  const loader = Effect.fn("XaiAuth.loader")(function* (getAuth: LoaderAuth) {
    // A rejection from the host auth reader passes through unchanged.
    const auth = yield* Effect.promise(() => getAuth())
    if (auth.type !== "oauth") return {}

    // Single-flight refresh: collapse concurrent fetches from this loaded
    // provider onto one HTTP call so we don't replay a rotating refresh_token.
    // The refresh runs detached from the caller, as the shared Promise did, and
    // clears the slot when it settles so a later refresh starts afresh.
    const inflight = yield* SynchronizedRef.make(Option.none<Fiber.Fiber<RefreshResult, XaiAuthError>>())
    const joinRefresh = (refreshToken: string) =>
      SynchronizedRef.modifyEffect(inflight, (current) =>
        Option.match(current, {
          onSome: (fiber) => Effect.succeed([fiber, current] as const),
          onNone: () =>
            refresh(refreshToken).pipe(
              Effect.ensuring(SynchronizedRef.set(inflight, Option.none())),
              Effect.forkDetach,
              Effect.map((fiber) => [fiber, Option.some(fiber)] as const),
            ),
        }),
      ).pipe(Effect.flatMap(Fiber.join))

    const authorizedFetch = Effect.fn("XaiAuth.fetch")(function* (requestInput: RequestInfo | URL, init?: RequestInit) {
      const currentAuth = yield* Effect.promise(() => getAuth())
      // Auth can flip from oauth to api mid-session (user re-runs
      // /connect with a pasted key). When that happens, pass the
      // request through untouched so the AI SDK's own apiKey-based
      // Authorization header reaches xAI unmodified. The AI SDK inspects a
      // fetch rejection, so Effect.promise keeps the rejection value unchanged.
      if (currentAuth.type !== "oauth") return yield* Effect.promise(() => fetch(requestInput, init))

      // Refresh either when the stored expires timestamp is within the
      // skew window, or — for JWT access tokens — when the JWT exp
      // claim itself is. The stored expires field is best-effort
      // (xAI doesn't always return expires_in) so the JWT check is the
      // load-bearing one for tokens that lack a fresh stored deadline.
      const now = yield* Clock.currentTimeMillis
      const expiresSoon =
        !currentAuth.expires ||
        currentAuth.expires - now <= ACCESS_TOKEN_REFRESH_SKEW_MS ||
        (yield* accessTokenIsExpiring(currentAuth.access))
      const access = expiresSoon ? (yield* joinRefresh(currentAuth.refresh)).access : currentAuth.access

      // Copy the caller's headers into a fresh Headers (case-insensitive)
      // so we never mutate the RequestInit the AI SDK may reuse on retry.
      // Headers.set overwrites case-insensitively, which kills the dummy
      // bearer the AI SDK injected from apiKey in a single line.
      const headers = requestInput instanceof Request ? new Headers(requestInput.headers) : new Headers()
      headerEntries(init?.headers ?? []).forEach(([key, value]) => {
        if (value !== undefined) headers.set(key, value)
      })
      headers.set("authorization", `Bearer ${access}`)
      headers.set("User-Agent", `opencode/${InstallationVersion}`)

      return yield* Effect.promise(() => fetch(requestInput, { ...init, headers }))
    })

    return {
      // Dummy bearer keeps the AI SDK from bailing on "missing apiKey"; the
      // real OAuth token is injected by the fetch override below.
      // We intentionally do NOT set baseURL — @ai-sdk/xai already defaults
      // to https://api.x.ai/v1 and overriding here would silently route
      // around a user-configured gateway.
      apiKey: OAUTH_DUMMY_KEY,
      fetch: (requestInput: RequestInfo | URL, init?: RequestInit) =>
        Effect.runPromise(authorizedFetch(requestInput, init)),
    }
  })

  const complete = Effect.fn("XaiAuth.complete")(function* (device: DeviceCodeResponse) {
    const tokens = yield* pollDeviceCodeToken(device, options)
    const now = yield* Clock.currentTimeMillis
    return {
      type: "success" as const,
      refresh: tokens.refresh_token ?? "",
      access: tokens.access_token,
      expires: now + (tokens.expires_in ?? 3600) * 1000,
    }
  })

  const authorize = Effect.fn("XaiAuth.authorize")(function* () {
    const device = yield* requestDeviceCode(options)
    return {
      url: device.verification_uri_complete ?? device.verification_uri,
      instructions: `Open ${device.verification_uri} on any device and enter code: ${device.user_code}`,
      method: "auto" as const,
      callback: () =>
        Effect.runPromise(complete(device).pipe(Effect.catch(() => Effect.succeed({ type: "failed" as const })))),
    }
  })

  const hooks: Hooks = {
    auth: {
      provider: "xai",
      loader: (getAuth) => Effect.runPromise(loader(getAuth)),
      methods: [
        {
          // RFC 8628 device-code flow. The CLI prints a verification URL
          // and a short user_code that the user enters in a browser on
          // any device. No loopback callback server runs on the CLI host,
          // so this works on VPS / SSH / Docker / CI / WSL / any
          // environment where 127.0.0.1:56121 isn't reachable from the
          // user's browser. Defends the only attack surface (the polling
          // loop) with the standard authorization_pending / slow_down
          // backoff and a hard deadline from xAI's `expires_in`.
          label: "SuperGrok Subscription",
          type: "oauth",
          authorize: () => Effect.runPromise(authorize()),
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
  return Effect.runPromise(Effect.succeed(hooks))
}

type LoaderAuth = Parameters<NonNullable<NonNullable<Hooks["auth"]>["loader"]>>[0]
