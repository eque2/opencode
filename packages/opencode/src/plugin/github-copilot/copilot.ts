import type { AuthOAuthResult, Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Duration, Effect, HashSet, Option, Predicate, Record, Result, Schema } from "effect"
import { errorMessage } from "@/util/error"
import { CopilotModels } from "./models"
import { MessageV2 } from "@/session/message-v2"

export class CopilotAuthError extends Schema.TaggedError<CopilotAuthError>()("CopilotAuth.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const ClientId = Schema.String.pipe(Schema.brand("CopilotClientId"))
const CLIENT_ID = ClientId.make("Ov23li8tweQw6odWQebz")
const API_VERSION = "2026-06-01"
const UTILITY_MODELS = ["gpt-5.4-nano", "gpt-4.1", "gpt-4o", "gpt-4o-mini"]
// Add a small safety buffer when polling to avoid hitting the server
// slightly too early due to clock skew / timer drift.
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000 // 3 seconds

const DeviceCodeRequest = Schema.Struct({
  client_id: ClientId,
  scope: Schema.String,
}).annotate({ identifier: "CopilotDeviceCodeRequest" })

const DeviceCodeResponse = Schema.Struct({
  verification_uri: Schema.String,
  user_code: Schema.String,
  device_code: Schema.String,
  interval: Schema.Number,
}).annotate({ identifier: "CopilotDeviceCodeResponse" })
type DeviceCodeResponse = typeof DeviceCodeResponse.Type

const AccessTokenRequest = Schema.Struct({
  client_id: ClientId,
  device_code: Schema.String,
  grant_type: Schema.String,
}).annotate({ identifier: "CopilotAccessTokenRequest" })

const AccessTokenResponse = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.Number),
}).annotate({ identifier: "CopilotAccessTokenResponse" })

const encodeDeviceCodeRequest = Schema.encodeEffect(Schema.fromJsonString(DeviceCodeRequest))
const encodeAccessTokenRequest = Schema.encodeEffect(Schema.fromJsonString(AccessTokenRequest))
const decodeDeviceCodeResponse = Schema.decodeUnknownEffect(DeviceCodeResponse)
const decodeAccessTokenResponse = Schema.decodeUnknownEffect(AccessTokenResponse)
// Request bodies are opaque provider payloads; classifyBody reads them defensively.
const decodeRequestBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const asAuthError = (cause: Schema.SchemaError) => new CopilotAuthError({ message: cause.message, cause })

type GetAuth = Parameters<NonNullable<NonNullable<Hooks["auth"]>["loader"]>>[0]
type AutoCallbackResult = Awaited<ReturnType<Extract<AuthOAuthResult, { method: "auto" }>["callback"]>>

function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function getUrls(domain: string) {
  return {
    DEVICE_CODE_URL: `https://${domain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
  }
}

function base(enterpriseUrl?: string) {
  return enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : "https://api.githubcopilot.com"
}

function validateEnterpriseUrl(value: string): string | undefined {
  const problem = !value
    ? Option.some("URL or domain is required")
    : Result.try(() => new URL(value.includes("://") ? value : `https://${value}`)).pipe(
        Result.match({
          onFailure: () => Option.some("Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)"),
          onSuccess: (url) =>
            url.hostname ? Option.none<string>() : Option.some("Please enter a valid URL or domain"),
        }),
      )
  // The plugin SDK validate contract answers a valid value with undefined.
  return Option.getOrUndefined(problem)
}

// Provider headers come from user config, so each value is coerced as fetch would coerce it.
function providerHeaders(value: unknown): Record<string, string> {
  return Predicate.isObject(value) ? Record.map(value, (item) => String(item)) : {}
}

// Only a plain header record spreads into the outgoing headers, as before.
function headerRecord(value: HeadersInit | undefined): Record<string, string> {
  return !value || value instanceof Headers || Array.isArray(value) ? {} : value
}

// Check if a message is a synthetic user msg used to attach an image from a tool call
function imgMsg(msg: any): boolean {
  if (msg?.role !== "user") return false

  // Handle the 3 api formats

  const content = msg.content
  if (typeof content === "string") return content === MessageV2.SYNTHETIC_ATTACHMENT_PROMPT
  if (!Array.isArray(content)) return false
  return content.some(
    (part: any) =>
      (part?.type === "text" || part?.type === "input_text") && part.text === MessageV2.SYNTHETIC_ATTACHMENT_PROMPT,
  )
}

const UNKNOWN_INITIATOR = { isVision: false, isAgent: false }

// The body is untyped provider JSON. A body of an unexpected shape makes the reads below throw,
// and requestInitiator maps that throw to the unknown initiator.
function classifyBody(url: string, body: any): { isVision: boolean; isAgent: boolean } {
  // Completions API
  if (body?.messages && url.includes("completions")) {
    const last = body.messages[body.messages.length - 1]
    return {
      isVision: body.messages.some(
        (msg: any) => Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image_url"),
      ),
      isAgent: last?.role !== "user" || imgMsg(last),
    }
  }

  // Responses API
  if (body?.input) {
    const last = body.input[body.input.length - 1]
    return {
      isVision: body.input.some(
        (item: any) => Array.isArray(item?.content) && item.content.some((part: any) => part.type === "input_image"),
      ),
      isAgent: last?.role !== "user" || imgMsg(last),
    }
  }

  // Messages API
  if (body?.messages) {
    const last = body.messages[body.messages.length - 1]
    const hasNonToolCalls =
      Array.isArray(last?.content) && last.content.some((part: any) => part?.type !== "tool_result")
    return {
      isVision: body.messages.some(
        (item: any) =>
          Array.isArray(item?.content) &&
          item.content.some(
            (part: any) =>
              part?.type === "image" ||
              // images can be nested inside tool_result content
              (part?.type === "tool_result" &&
                Array.isArray(part?.content) &&
                part.content.some((nested: any) => nested?.type === "image")),
          ),
      ),
      isAgent: !(last?.role === "user" && hasNonToolCalls) || imgMsg(last),
    }
  }

  return UNKNOWN_INITIATOR
}

function requestInitiator(url: string, init?: RequestInit) {
  const body = typeof init?.body === "string" ? decodeRequestBody(init.body) : Option.some(init?.body)
  return body.pipe(
    Option.flatMap(Option.liftThrowable((value: unknown) => classifyBody(url, value))),
    Option.getOrElse(() => UNKNOWN_INITIATOR),
  )
}

function fix(model: Model, url: string): Model {
  return {
    ...model,
    api: {
      ...model.api,
      url,
      npm: "@ai-sdk/github-copilot",
    },
  }
}

const post = (url: string, body: string) =>
  Effect.tryPromise({
    try: () =>
      fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": `opencode/${InstallationVersion}`,
        },
        body,
      }),
    catch: (cause) => new CopilotAuthError({ message: errorMessage(cause), cause }),
  })

const readJson = (response: Response) =>
  Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new CopilotAuthError({ message: errorMessage(cause), cause }),
  })

// The AI SDK inspects a fetch rejection (abort, network failure), so a rejected request must
// reach it unchanged. Effect.promise keeps the rejection as a defect, and runPromise rejects
// with that same value.
const copilotFetch = Effect.fn("CopilotAuth.fetch")(function* (
  getAuth: GetAuth,
  request: RequestInfo | URL,
  init?: RequestInit,
) {
  const info = yield* Effect.promise(getAuth)
  if (info.type !== "oauth") return yield* Effect.promise(() => fetch(request, init))

  const url = request instanceof URL ? request.href : typeof request === "string" ? request : request.url
  const { isVision, isAgent } = requestInitiator(url, init)

  const headers: Record<string, string> = {
    "x-initiator": isAgent ? "agent" : "user",
    ...headerRecord(init?.headers),
    "User-Agent": `opencode/${InstallationVersion}`,
    Authorization: `Bearer ${info.refresh}`,
    "Openai-Intent": "conversation-edits",
    ...(isVision ? { "Copilot-Vision-Request": "true" } : {}),
  }

  delete headers["x-api-key"]
  delete headers["authorization"]

  return yield* Effect.promise(() =>
    fetch(request, {
      ...init,
      headers,
    }),
  )
})

const pollAccessToken = Effect.fn("CopilotAuth.pollAccessToken")(function* (
  accessTokenUrl: string,
  deviceData: DeviceCodeResponse,
  enterpriseDomain: Option.Option<string>,
) {
  while (true) {
    const response = yield* post(
      accessTokenUrl,
      yield* encodeAccessTokenRequest({
        client_id: CLIENT_ID,
        device_code: deviceData.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).pipe(Effect.mapError(asAuthError)),
    )

    if (!response.ok) return { type: "failed" as const } satisfies AutoCallbackResult

    const data = yield* decodeAccessTokenResponse(yield* readJson(response)).pipe(Effect.mapError(asAuthError))

    if (data.access_token) {
      return {
        type: "success" as const,
        refresh: data.access_token,
        access: data.access_token,
        expires: 0,
        ...Option.match(enterpriseDomain, { onNone: () => ({}), onSome: (enterpriseUrl) => ({ enterpriseUrl }) }),
      } satisfies AutoCallbackResult
    }

    if (data.error === "slow_down") {
      // Based on the RFC spec, we must add 5 seconds to our current polling interval.
      // (See https://www.rfc-editor.org/rfc/rfc8628#section-3.5)
      // GitHub OAuth API may return the new interval in seconds in the response.
      // We should try to use that if provided with safety margin.
      const serverInterval = data.interval
      const interval = serverInterval && serverInterval > 0 ? serverInterval * 1000 : (deviceData.interval + 5) * 1000
      yield* Effect.sleep(Duration.millis(interval + OAUTH_POLLING_SAFETY_MARGIN_MS))
      continue
    }

    if (data.error && data.error !== "authorization_pending")
      return { type: "failed" as const } satisfies AutoCallbackResult

    // authorization_pending, or no error and no token yet: wait one interval and poll again.
    yield* Effect.sleep(Duration.millis(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS))
  }
})

const authorize = Effect.fn("CopilotAuth.authorize")(function* (inputs: Record<string, string>) {
  const deploymentType = inputs.deploymentType || "github.com"
  const enterprise = deploymentType === "enterprise"
  const domain = enterprise ? normalizeDomain(inputs.enterpriseUrl) : "github.com"
  const urls = getUrls(domain)

  const deviceResponse = yield* post(
    urls.DEVICE_CODE_URL,
    yield* encodeDeviceCodeRequest({ client_id: CLIENT_ID, scope: "read:user" }).pipe(Effect.mapError(asAuthError)),
  )

  if (!deviceResponse.ok) {
    return yield* new CopilotAuthError({ message: "Failed to initiate device authorization" })
  }

  const deviceData = yield* decodeDeviceCodeResponse(yield* readJson(deviceResponse)).pipe(Effect.mapError(asAuthError))

  return {
    url: deviceData.verification_uri,
    instructions: `Enter code: ${deviceData.user_code}`,
    method: "auto" as const,
    callback: () =>
      Effect.runPromise(
        pollAccessToken(urls.ACCESS_TOKEN_URL, deviceData, enterprise ? Option.some(domain) : Option.none()),
      ),
  } satisfies AuthOAuthResult
})

export function CopilotAuthPlugin(input: Pick<PluginInput, "client" | "directory">): Promise<Hooks> {
  const sdk = input.client
  let models: Record<string, Model> = {}

  const loadModels = Effect.fn("CopilotAuth.models")(function* (
    provider: Parameters<NonNullable<NonNullable<Hooks["provider"]>["models"]>>[0],
    ctx: Parameters<NonNullable<NonNullable<Hooks["provider"]>["models"]>>[1],
  ) {
    if (ctx.auth?.type !== "oauth") {
      models = {}
      return Object.fromEntries(Object.entries(provider.models).map(([id, model]) => [id, fix(model, base())]))
    }

    const auth = ctx.auth
    const loaded = yield* CopilotModels.get(
      base(auth.enterpriseUrl),
      {
        ...providerHeaders(provider.options?.headers),
        Authorization: `Bearer ${auth.refresh}`,
        "User-Agent": `opencode/${InstallationVersion}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
      provider.models,
    ).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Copilot model list failed", { error }).pipe(
          Effect.annotateLogs({ category: "provider.discovery" }),
        ),
      ),
      Effect.option,
    )

    if (Option.isNone(loaded)) {
      models = {}
      return Object.fromEntries(
        Object.entries(provider.models).map(([id, model]) => [id, fix(model, base(auth.enterpriseUrl))]),
      )
    }

    const result = loaded.value
    models = result.models
    return Object.fromEntries(
      Object.entries(result.models).filter(([, model]) =>
        HashSet.some(result.pickerEnabled, (id) => id === model.api.id),
      ),
    )
  })

  const loader = Effect.fn("CopilotAuth.loader")(function* (getAuth: GetAuth) {
    const info = yield* Effect.promise(getAuth)
    if (!info || info.type !== "oauth") return {}

    return {
      apiKey: "",
      fetch: (request: RequestInfo | URL, init?: RequestInit) =>
        Effect.runPromise(copilotFetch(getAuth, request, init)),
    }
  })

  const chatHeaders = Effect.fn("CopilotAuth.chatHeaders")(function* (
    incoming: Parameters<NonNullable<Hooks["chat.headers"]>>[0],
    output: Parameters<NonNullable<Hooks["chat.headers"]>>[1],
  ) {
    if (!incoming.model.providerID.includes("github-copilot")) return

    output.headers["X-GitHub-Api-Version"] = API_VERSION
    output.headers["X-Interaction-Id"] = incoming.sessionID
    if (incoming.agent === "title") {
      output.headers["X-Interaction-Type"] = "agent-session-name-generation"
    }

    if (incoming.model.api.npm === "@ai-sdk/anthropic") {
      output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
    }

    const parts = yield* Effect.tryPromise(() =>
      sdk.session.message({
        path: {
          id: incoming.message.sessionID,
          messageID: incoming.message.id,
        },
        query: {
          directory: input.directory,
        },
        throwOnError: true,
      }),
    ).pipe(Effect.option)

    const compacted = Option.exists(parts, (result) =>
      result.data.parts.some(
        (part) =>
          part.type === "compaction" ||
          // Auto-compaction resumes via a synthetic user text part. Treat only
          // that marked followup as agent-initiated so manual prompts stay user-initiated.
          (part.type === "text" && part.synthetic === true && part.metadata?.compaction_continue === true),
      ),
    )
    if (compacted) {
      output.headers["x-initiator"] = "agent"
      return
    }

    const session = yield* Effect.tryPromise(() =>
      sdk.session.get({
        path: {
          id: incoming.sessionID,
        },
        query: {
          directory: input.directory,
        },
        throwOnError: true,
      }),
    ).pipe(Effect.option)
    if (!Option.exists(session, (result) => Boolean(result.data.parentID))) return
    // mark subagent sessions as agent initiated matching standard that other copilot tools have
    output.headers["x-initiator"] = "agent"
  })

  const hooks: Hooks = {
    provider: {
      id: "github-copilot",
      models: (provider, ctx) => Effect.runPromise(loadModels(provider, ctx)),
    },
    auth: {
      provider: "github-copilot",
      loader: (getAuth) => Effect.runPromise(loader(getAuth)),
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              when: { key: "deploymentType", op: "eq", value: "enterprise" },
              validate: validateEnterpriseUrl,
            },
          ],
          authorize: (inputs = {}) => Effect.runPromise(authorize(inputs)),
        },
      ],
    },
    "chat.params": (incoming, output) =>
      Effect.runPromise(
        Effect.sync(() => {
          if (!incoming.model.providerID.includes("github-copilot")) return

          // Match github copilot cli, omit maxOutputTokens for gpt models
          if (incoming.model.api.id.includes("gpt")) {
            // eslint-disable-next-line effect/no-undefined-use-option -- (c) the plugin SDK chat.params output declares maxOutputTokens as number | undefined, and the JavaScript undefined value clears the limit
            output.maxOutputTokens = undefined
          }

          // GitHub Copilot's /v1/messages shim rejects the GA `eager_input_streaming`
          // field on tool definitions ("Extra inputs are not permitted"). Opt out of
          // the @ai-sdk/anthropic default so it stops injecting the field.
          if (incoming.model.api.npm === "@ai-sdk/anthropic") {
            output.options.toolStreaming = false
          }
        }),
      ),
    "experimental.provider.small_model": (incoming, output) =>
      Effect.runPromise(
        Effect.sync(() => {
          if (incoming.provider.id !== "github-copilot") return
          // GitHub exposes utility models for title generation without including them in the picker.
          output.model = UTILITY_MODELS.map((id) => models[id]).find((model) => model !== undefined)
        }),
      ),
    "chat.headers": (incoming, output) => Effect.runPromise(chatHeaders(incoming, output)),
  }
  return Effect.runPromise(Effect.succeed(hooks))
}
