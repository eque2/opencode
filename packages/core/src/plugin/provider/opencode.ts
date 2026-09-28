import {
  Clock,
  Config,
  ConfigProvider,
  DateTime,
  Duration,
  Effect,
  Option,
  Predicate,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import type { Scope } from "effect"
import type { IntegrationOAuthMethodRegistration } from "@opencode-ai/plugin/v2/effect/integration"
import { define } from "@opencode-ai/plugin/v2/effect/plugin"
import type { CredentialValue } from "@opencode-ai/sdk/v2/types"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { EventV2 } from "../../event"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { ConfigProviderV1 } from "../../v1/config/provider"
import { ConfigProviderOptionsV1 } from "../../v1/config/provider-options"
import { ConfigV1 } from "../../v1/config/config"

const defaultServer = "https://opencode.ai/console"
const clientID = "opencode-cli"
const methodID = Integration.MethodID.make("device")
const RemoteResponse = Schema.Struct({ config: ConfigV1.Info }).annotate({
  identifier: "OpencodePlugin.RemoteResponse",
})
const Device = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
}).annotate({ identifier: "OpencodePlugin.Device" })
const Token = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
}).annotate({ identifier: "OpencodePlugin.Token" })
const TokenPending = Schema.Struct({ error: Schema.String }).annotate({ identifier: "OpencodePlugin.TokenPending" })
const DeviceToken = Schema.Union([Token, TokenPending])
const UserID = Schema.String.pipe(Schema.brand("OpencodePlugin.UserID"))
const OrgID = Schema.String.pipe(Schema.brand("OpencodePlugin.OrgID"))
const User = Schema.Struct({ id: UserID, email: Schema.String }).annotate({ identifier: "OpencodePlugin.User" })
const Org = Schema.Struct({ id: OrgID, name: Schema.String }).annotate({ identifier: "OpencodePlugin.Org" })
// The ambient ConfigProvider copies process.env once per process; read a fresh env
// provider on each reload so a key set at run time still counts.
const apiKeyFromEnv = Config.option(Config.Redacted("OPENCODE_API_KEY"))

class DeviceAuthorizationError extends Schema.TaggedError<DeviceAuthorizationError>()(
  "OpencodePlugin.DeviceAuthorizationError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const isWebURL = (url: URL) => url.protocol === "http:" || url.protocol === "https:"

// Credential metadata values are unknown in the SDK types; read one as a string or None.
const metadataString = (value: unknown) => Option.liftPredicate(value, Predicate.isString)

function oauth(http: HttpClient.HttpClient) {
  return {
    integrationID: Integration.ID.make("opencode"),
    method: {
      id: methodID,
      type: "oauth",
      label: "OpenCode Console account",
    },
    authorize: () =>
      Effect.gen(function* () {
        const device = yield* post(http, `${defaultServer}/auth/device/code`, { client_id: clientID }, Device)
        const verification = yield* Effect.try({
          try: () => new URL(device.verification_uri_complete, `${defaultServer}/`),
          catch: (cause) =>
            new DeviceAuthorizationError({
              message: `Invalid device verification URL: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        }).pipe(
          Effect.filterOrFail(
            isWebURL,
            () => new DeviceAuthorizationError({ message: "Invalid device verification URL: expected HTTP(S)" }),
          ),
        )
        return {
          mode: "auto" as const,
          url: verification.href,
          instructions: `Enter code: ${device.user_code}`,
          callback: poll(http, defaultServer, device.device_code, Duration.seconds(device.interval)),
        }
      }),
    refresh: (credential) =>
      Effect.gen(function* () {
        const server = typeof credential.metadata?.server === "string" ? credential.metadata.server : defaultServer
        const token = yield* post(
          http,
          `${server}/auth/device/token`,
          { grant_type: "refresh_token", refresh_token: credential.refresh, client_id: clientID },
          Token,
        )
        const now = yield* Clock.currentTimeMillis
        return {
          ...credential,
          access: token.access_token,
          refresh: token.refresh_token,
          expires: now + token.expires_in * 1000,
        }
      }),
    label: (credential) => Option.getOrUndefined(metadataString(credential.metadata?.orgName)),
  } satisfies IntegrationOAuthMethodRegistration
}

export const OpencodePlugin = define<HttpClient.HttpClient | EventV2.Service | Scope.Scope>({
  id: "opencode",
  effect: Effect.fn(function* (ctx) {
    const events = yield* EventV2.Service
    const http = yield* HttpClient.HttpClient
    const loading = Semaphore.makeUnsafe(1)
    let connected = false
    let providers = Option.none<RemoteProviders>()

    const load = Effect.fn("OpencodePlugin.load")(function* () {
      const connection = Option.fromUndefinedOr(yield* ctx.integration.connection.active("opencode"))
      const credential = Option.isNone(connection)
        ? Option.none()
        : yield* ctx.integration.connection.resolve(connection.value).pipe(
            Effect.map(Option.fromUndefinedOr),
            Effect.catch(() => Effect.succeedNone),
          )
      connected = Option.isSome(connection)
      providers = Option.isNone(credential)
        ? Option.none()
        : yield* fetchProviders(http, credential.value).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to load OpenCode provider config", { cause }).pipe(Effect.as(Option.none())),
            ),
          )
    })

    yield* ctx.integration.transform((draft) => {
      draft.update("opencode", (integration) => {
        integration.name = "OpenCode"
      })
      draft.method.update(oauth(http))
      draft.method.update({ integrationID: "opencode", method: { type: "key", label: "API key (service account)" } })
    })

    connected = (yield* ctx.integration.connection.active("opencode")) !== undefined
    yield* ctx.catalog.transform(
      Effect.fnUntraced(function* (catalog) {
        for (const [providerID, item] of Object.entries(Option.getOrElse(providers, () => ({})))) {
          catalog.provider.update(providerID, (provider) => {
            provider.integrationID = Integration.ID.make("opencode")
            if (item.name !== undefined) provider.name = item.name
            provider.api = item.npm
              ? { type: "aisdk", package: item.npm, url: item.api }
              : { type: "native", url: item.api, settings: {} }
            Object.assign(provider.request.headers, item.options?.headers)
            Object.assign(provider.request.body, withoutCredentials(item.options))
          })

          for (const [modelID, config] of Object.entries(item.models ?? {})) {
            catalog.model.update(providerID, modelID, (model) => {
              if (config.family !== undefined) model.family = config.family
              if (config.name !== undefined) model.name = config.name
              if (config.id !== undefined) model.api.id = config.id
              if (config.provider !== undefined) {
                model.api = config.provider.npm
                  ? {
                      id: model.api.id,
                      type: "aisdk",
                      package: config.provider.npm,
                      url: config.provider.api,
                    }
                  : { id: model.api.id, type: "native", url: config.provider.api, settings: {} }
              }
              if (config.tool_call !== undefined) model.capabilities.tools = config.tool_call
              if (config.modalities?.input !== undefined) model.capabilities.input = [...config.modalities.input]
              if (config.modalities?.output !== undefined) model.capabilities.output = [...config.modalities.output]
              const packageName = config.provider?.npm ?? item.npm
              const lowerer = ConfigProviderOptionsV1.get(packageName)
              Object.assign(model.request.headers, config.headers)
              Object.assign(model.request.body, lowerer.request(withoutCredentials(config.options)))
              if (config.variants !== undefined) {
                model.variants = Object.entries(config.variants).map(([id, options]) => ({
                  id: ModelV2.VariantID.make(id),
                  headers: { ...options.headers },
                  body: lowerer.request(withoutCredentials(options)),
                }))
              }
              if (config.release_date !== undefined) {
                model.time.released = Option.match(DateTime.make(config.release_date), {
                  onNone: () => 0,
                  onSome: DateTime.toEpochMillis,
                })
              }
              if (config.cost !== undefined) {
                model.cost = remoteCost(config.cost)
              }
              model.status = config.status ?? "active"
              model.enabled = config.status !== "deprecated"
              if (config.limit !== undefined) model.limit = { ...config.limit }
            })
          }
        }

        const item = catalog.provider.get(ProviderV2.ID.opencode)
        if (!item) return
        const envKey = yield* apiKeyFromEnv.parse(ConfigProvider.fromEnv()).pipe(Effect.orDie)
        const hasKey = Option.isSome(envKey) || connected || Boolean(item.provider.request.body.apiKey)
        catalog.provider.update(item.provider.id, (provider) => {
          if (!hasKey) provider.request.body.apiKey = "public"
        })
        if (hasKey) return
        for (const model of item.models.values()) {
          if (!model.cost.some((cost) => cost.input > 0)) continue
          catalog.model.update(item.provider.id, model.id, (draft) => {
            draft.enabled = false
          })
        }
      }),
    )

    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(ctx.catalog.reload())))
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.filter((event) => event.data.integrationID === Integration.ID.make("opencode")),
      Stream.runForEach(refresh),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* refresh().pipe(Effect.forkScoped)
  }),
})

type RemoteProviders = NonNullable<typeof ConfigV1.Info.Type.provider>

function fetchProviders(http: HttpClient.HttpClient, value: CredentialValue) {
  const metadata = value.metadata
  const server = typeof metadata?.server === "string" ? metadata.server : defaultServer
  const orgID = metadataString(metadata?.orgID).pipe(Option.filter((id) => id !== ""))
  const token = value.type === "oauth" ? value.access : value.key
  return http
    .execute(
      HttpClientRequest.get(`${server}/api/config`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders(Option.match(orgID, { onNone: () => ({}), onSome: (id) => ({ "x-org-id": id }) })),
      ),
    )
    .pipe(
      Effect.flatMap((response) => {
        if (response.status === 404) return Effect.succeed(Option.none<RemoteProviders>())
        return HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(RemoteResponse)),
          Effect.map((remote) => Option.fromUndefinedOr(remote.config.provider)),
        )
      }),
    )
}

function withoutCredentials(body: Readonly<Record<string, unknown>> | undefined) {
  return Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => key !== "apiKey" && key !== "headers"))
}

function remoteCost(input: NonNullable<(typeof ConfigProviderV1.Model.Type)["cost"]>) {
  const base = {
    input: input.input,
    output: input.output,
    cache: { read: input.cache_read ?? 0, write: input.cache_write ?? 0 },
  }
  if (!input.context_over_200k) return [base]
  return [
    base,
    {
      tier: { type: "context" as const, size: 200_000 },
      input: input.context_over_200k.input,
      output: input.context_over_200k.output,
      cache: {
        read: input.context_over_200k.cache_read ?? 0,
        write: input.context_over_200k.cache_write ?? 0,
      },
    },
  ]
}

function poll(http: HttpClient.HttpClient, server: string, deviceCode: string, interval: Duration.Duration) {
  const loop = (wait: Duration.Duration): Effect.Effect<Credential.OAuth, unknown> =>
    Effect.gen(function* () {
      yield* Effect.sleep(wait)
      const result = yield* post(
        http,
        `${server}/auth/device/token`,
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: clientID,
        },
        DeviceToken,
        false,
      )
      if ("access_token" in result) return yield* credential(http, server, result)
      if (result.error === "authorization_pending") return yield* loop(wait)
      if (result.error === "slow_down") {
        return yield* loop(Duration.sum(wait, Duration.seconds(5)))
      }
      return yield* new DeviceAuthorizationError({ message: `Device authorization failed: ${result.error}` })
    })
  return loop(interval)
}

function credential(http: HttpClient.HttpClient, server: string, token: typeof Token.Type) {
  return Effect.gen(function* () {
    const [user, orgs] = yield* Effect.all(
      [
        get(http, `${server}/api/user`, token.access_token, User),
        get(http, `${server}/api/orgs`, token.access_token, Schema.Array(Org)),
      ],
      { concurrency: 2 },
    )
    const org = Option.fromUndefinedOr(
      orgs.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).at(0),
    )
    const now = yield* Clock.currentTimeMillis
    return Credential.OAuth.make({
      type: "oauth" as const,
      methodID,
      access: token.access_token,
      refresh: token.refresh_token,
      expires: now + token.expires_in * 1000,
      metadata: {
        server,
        accountID: user.id,
        email: user.email,
        // Metadata is a JSON object, so an account without an organization omits the keys.
        ...Option.match(org, {
          onNone: () => ({}),
          onSome: (item) => ({ orgID: item.id, orgName: item.name }),
        }),
      },
    })
  })
}

function get<S extends Schema.Top>(http: HttpClient.HttpClient, url: string, token: string, schema: S) {
  return HttpClient.filterStatusOk(http)
    .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(token)))
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)))
}

function post<S extends Schema.Top>(
  http: HttpClient.HttpClient,
  url: string,
  body: Record<string, string>,
  schema: S,
  statusOk = true,
) {
  return HttpClientRequest.post(url).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.schemaBodyJson(Schema.Record(Schema.String, Schema.String))(body),
    Effect.flatMap((request) => http.execute(request)),
    Effect.flatMap((response) => (statusOk ? HttpClientResponse.filterStatusOk(response) : Effect.succeed(response))),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
  )
}
