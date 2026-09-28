import { createServer } from "node:http"
import { NodeCrypto } from "@effect/platform-node"
import type { IntegrationOAuthMethodRegistration } from "@opencode-ai/plugin/v2/effect/integration"
import { define } from "@opencode-ai/plugin/v2/effect/plugin"
import type { CredentialOAuth } from "@opencode-ai/sdk/v2/types"
import { Clock, Crypto, Deferred, Effect, Option, Predicate, Schema } from "effect"
import type { Scope } from "effect"
import { Credential } from "../../credential"
import { InstallationVersion } from "../../installation/version"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { OauthCallbackPage } from "../../oauth/page"
import { ProviderV2 } from "../../provider"
import type { PluginInternal } from "../internal"

const clientID = "app_EMoamEEZ73f0CkXaXp7hrann"
const issuer = "https://auth.openai.com"
const callbackPort = 1455
const pollingSafetyMargin = 3000
const browserMethodID = Integration.MethodID.make("chatgpt-browser")
const headlessMethodID = Integration.MethodID.make("chatgpt-headless")
const verifierChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"

type Pkce = {
  verifier: string
  challenge: string
}

class OpenAIAuthError extends Schema.TaggedError<OpenAIAuthError>()("OpenAIPlugin.AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const DeviceAuthID = Schema.String.pipe(Schema.brand("OpenAIPlugin.DeviceAuthID"))
const AccountID = Schema.String.pipe(Schema.brand("OpenAIPlugin.AccountID"))

const DeviceCode = Schema.Struct({
  device_auth_id: DeviceAuthID,
  user_code: Schema.String,
  // The API sends the poll interval as a string; a number or a missing value still falls back below.
  interval: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
}).annotate({ identifier: "OpenAIPlugin.DeviceCode" })

const DeviceToken = Schema.Struct({
  authorization_code: Schema.String,
  code_verifier: Schema.String,
}).annotate({ identifier: "OpenAIPlugin.DeviceToken" })

const TokenResponse = Schema.Struct({
  id_token: Schema.String,
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.optional(Schema.Number),
}).annotate({ identifier: "OpenAIPlugin.TokenResponse" })
type TokenResponse = typeof TokenResponse.Type

const Claims = Schema.Struct({
  chatgpt_account_id: Schema.optional(AccountID),
  organizations: Schema.optional(Schema.Array(Schema.Struct({ id: AccountID }))),
  "https://api.openai.com/auth": Schema.optional(Schema.Struct({ chatgpt_account_id: Schema.optional(AccountID) })),
}).annotate({ identifier: "OpenAIPlugin.Claims" })

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims))
const decodeMetadata = Schema.decodeUnknownOption(Schema.JsonObject)

const requestError = (cause: unknown) =>
  new OpenAIAuthError({ message: Predicate.isError(cause) ? cause.message : "Request failed", cause })

const browser = {
  integrationID: Integration.ID.make("openai"),
  method: {
    id: browserMethodID,
    type: "oauth",
    label: "ChatGPT Pro/Plus (browser)",
  },
  authorize: () =>
    Effect.gen(function* () {
      const cryptoService = yield* Crypto.Crypto
      const pkce = yield* generatePKCE()
      const state = base64UrlEncode(yield* cryptoService.randomBytes(32))
      const code = yield* Deferred.make<string, OpenAIAuthError>()
      const redirect = `http://localhost:${callbackPort}/auth/callback`
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", `http://localhost:${callbackPort}`)
        if (url.pathname !== "/auth/callback") {
          response.writeHead(404).end("Not found")
          return
        }
        const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
        const value = url.searchParams.get("code")
        if (error) {
          Effect.runFork(Deferred.fail(code, new OpenAIAuthError({ message: error })))
          response
            .writeHead(400, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.error(error, { provider: "ChatGPT" }))
          return
        }
        if (!value || url.searchParams.get("state") !== state) {
          const message = value ? "Invalid OAuth state" : "Missing authorization code"
          Effect.runFork(Deferred.fail(code, new OpenAIAuthError({ message })))
          response
            .writeHead(400, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.error(message, { provider: "ChatGPT" }))
          return
        }
        Effect.runFork(Deferred.succeed(code, value))
        response.writeHead(200, { "Content-Type": "text/html" }).end(OauthCallbackPage.success({ provider: "ChatGPT" }))
      })
      yield* Effect.callback<void, OpenAIAuthError>((resume) => {
        server.once("error", (error) =>
          resume(Effect.fail(new OpenAIAuthError({ message: error.message, cause: error }))),
        )
        server.listen(callbackPort, "localhost", () => resume(Effect.void))
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
      return {
        mode: "auto" as const,
        url: authorizeURL(redirect, pkce, state),
        instructions: "Complete authorization in your browser. This window will close automatically.",
        callback: Deferred.await(code).pipe(
          Effect.flatMap((value) => exchange(value, redirect, pkce)),
          Effect.flatMap((tokens) => credential(browserMethodID, tokens)),
        ),
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  refresh: (value) => refresh(browserMethodID, value),
} satisfies IntegrationOAuthMethodRegistration

const headless = {
  integrationID: Integration.ID.make("openai"),
  method: {
    id: headlessMethodID,
    type: "oauth",
    label: "ChatGPT Pro/Plus (headless)",
  },
  authorize: () =>
    Effect.gen(function* () {
      const device = yield* request(
        `${issuer}/api/accounts/deviceauth/usercode`,
        {
          method: "POST",
          headers: headers("application/json"),
          body: encodeJson({ client_id: clientID }),
        },
        DeviceCode,
      )
      const interval = Math.max(Number.parseInt(String(device.interval ?? "")) || 5, 1) * 1000
      return {
        mode: "auto" as const,
        url: `${issuer}/codex/device`,
        instructions: `Enter code: ${device.user_code}`,
        callback: Effect.gen(function* () {
          while (true) {
            const response = yield* Effect.tryPromise({
              try: (signal) =>
                fetch(`${issuer}/api/accounts/deviceauth/token`, {
                  method: "POST",
                  headers: headers("application/json"),
                  body: encodeJson({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
                  signal,
                }),
              catch: requestError,
            })
            if (response.ok) {
              const data = yield* decodeBody(response, DeviceToken)
              const tokens = yield* exchange(data.authorization_code, `${issuer}/deviceauth/callback`, {
                verifier: data.code_verifier,
                challenge: "",
              })
              return yield* credential(headlessMethodID, tokens)
            }
            if (response.status !== 403 && response.status !== 404) {
              return yield* new OpenAIAuthError({ message: `Device authorization failed: ${response.status}` })
            }
            yield* Effect.sleep(interval + pollingSafetyMargin)
          }
        }),
      }
    }),
  refresh: (value) => refresh(headlessMethodID, value),
} satisfies IntegrationOAuthMethodRegistration

export const OpenAIPlugin = define({
  id: "openai",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.integration.transform((draft) => {
      draft.method.update(browser)
      draft.method.update(headless)
    })
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai") continue
          if (!item.models.has(ModelV2.ID.make("gpt-5-chat-latest"))) continue
          evt.model.update(item.provider.id, ModelV2.ID.make("gpt-5-chat-latest"), (model) => {
            // OpenAIPlugin sends OpenAI models through Responses; this alias is a
            // chat-completions-only model, so hide it only from OpenAI's catalog.
            model.enabled = false
          })
        }
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/openai") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/openai"))
        evt.sdk = mod.createOpenAI(evt.options)
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.openai) return
        evt.language = evt.sdk.responses(evt.model.api.id)
      }),
    )
  }),
} satisfies PluginInternal.Plugin<PluginInternal.Requirements | Scope.Scope>)

function headers(contentType: string) {
  return { "Content-Type": contentType, "User-Agent": `opencode/${InstallationVersion}` }
}

function exchange(code: string, redirect: string, pkce: Pkce) {
  return request(
    `${issuer}/oauth/token`,
    {
      method: "POST",
      headers: headers("application/x-www-form-urlencoded"),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: clientID,
        code_verifier: pkce.verifier,
      }).toString(),
    },
    TokenResponse,
  )
}

// The plugin API passes the stored credential with SDK metadata typed as unknown values.
// Keep the old metadata when the new tokens carry none and the old metadata is a JSON object.
function refresh(methodID: Integration.MethodID, value: CredentialOAuth) {
  return request(
    `${issuer}/oauth/token`,
    {
      method: "POST",
      headers: headers("application/x-www-form-urlencoded"),
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: value.refresh,
        client_id: clientID,
      }).toString(),
    },
    TokenResponse,
  ).pipe(
    Effect.flatMap((tokens) => credential(methodID, tokens)),
    Effect.map((next) => {
      const metadata = Option.orElse(Option.fromUndefinedOr(next.metadata), () => decodeMetadata(value.metadata))
      return Credential.OAuth.make({
        ...next,
        ...Option.match(metadata, { onNone: () => ({}), onSome: (item) => ({ metadata: item }) }),
      })
    }),
  )
}

function request<S extends Schema.Top>(url: string, init: RequestInit, schema: S) {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(url, { ...init, signal }),
      catch: requestError,
    })
    if (!response.ok) return yield* new OpenAIAuthError({ message: `Request failed: ${response.status}` })
    return yield* decodeBody(response, schema)
  })
}

// Reads a response body as text and decodes it with the schema's JSON codec.
function decodeBody<S extends Schema.Top>(response: Response, schema: S) {
  return Effect.tryPromise({
    try: () => response.text(),
    catch: requestError,
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))))
}

const credential = Effect.fnUntraced(function* (methodID: Integration.MethodID, tokens: TokenResponse) {
  const now = yield* Clock.currentTimeMillis
  const accountID = Option.filter(extractAccountID(tokens), (id) => id !== "")
  return Credential.OAuth.make({
    type: "oauth",
    methodID,
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: now + (tokens.expires_in ?? 3600) * 1000,
    ...Option.match(accountID, { onNone: () => ({}), onSome: (id) => ({ metadata: { accountID: id } }) }),
  })
})

const generatePKCE = Effect.fnUntraced(function* () {
  const cryptoService = yield* Crypto.Crypto
  const bytes = yield* cryptoService.randomBytes(43)
  const verifier = Array.from(bytes, (byte) => verifierChars[byte % verifierChars.length]).join("")
  const challenge = base64UrlEncode(yield* cryptoService.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
})

function base64UrlEncode(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url")
}

function authorizeURL(redirect: string, pkce: Pkce, state: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientID,
    redirect_uri: redirect,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })
  return `${issuer}/oauth/authorize?${params.toString()}`
}

function extractAccountID(tokens: TokenResponse) {
  return Option.orElse(claim(tokens.id_token), () => claim(tokens.access_token))
}

// Reads the ChatGPT account ID from a JWT payload; a malformed token has none.
function claim(token: string) {
  return Option.fromUndefinedOr(token.split(".")[1]).pipe(
    Option.flatMap((part) => decodeClaims(Buffer.from(part, "base64url").toString())),
    Option.flatMap((claims) =>
      Option.fromUndefinedOr(
        claims.chatgpt_account_id ??
          claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
          claims.organizations?.[0]?.id,
      ),
    ),
  )
}
