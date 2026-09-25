import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { which } from "@opencode-ai/core/util/which"
import type { Hooks } from "@opencode-ai/plugin"
import { Clock, Config, DateTime, Effect, MutableHashMap, Option, Schema } from "effect"
import { OAUTH_DUMMY_KEY } from "../auth"
import { errorMessage } from "../util/error"
import { Process } from "../util/process"

const AZURE_COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"
const AZURE_FOUNDRY_SCOPE = "https://ai.azure.com/.default"
const AZURE_TOKEN_REFRESH_BUFFER = 60_000
const AZURE_OAUTH_LIFETIME = 365 * 24 * 60 * 60 * 1000

const AzureCliToken = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  expires_on: Schema.optional(Schema.Number),
  expiresOn: Schema.optional(Schema.NonEmptyString),
}).annotate({ identifier: "AzureCliToken" })
type AzureCliToken = typeof AzureCliToken.Type
const decodeAzureCliToken = Schema.decodeUnknownEffect(AzureCliToken)
const decodeAzureCliOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))
// Azure CLI versions that give only expiresOn write a local date-time with no zone. DateFromString
// parses it with the Date constructor, which reads such a string as local time.
const decodeExpiresOn = Schema.decodeUnknownOption(Schema.DateFromString)

// Readers drop an empty AZURE_RESOURCE_NAME, which counts as unset.
const ResourceName = Config.option(Config.String("AZURE_RESOURCE_NAME"))

export class AzureAuthError extends Schema.TaggedError<AzureAuthError>()("AzureAuth.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

type AzureCommand = (args: ReadonlyArray<string>) => Effect.Effect<unknown, AzureAuthError | Schema.SchemaError>
type AuthMethod = NonNullable<Hooks["auth"]>["methods"][number]

const nonEmpty = (value: string) => value.length > 0

const runAzure = Effect.fn("AzureAuth.runAzure")(function* (args: ReadonlyArray<string>) {
  const az = Option.getOrElse(yield* which("az"), () => "az")
  const result = yield* Effect.tryPromise({
    try: () => Process.run([az, ...args]),
    catch: (cause) => new AzureAuthError({ message: errorMessage(cause), cause }),
  })
  return yield* decodeAzureCliOutput(result.stdout.toString())
})

export function AzureAuthPlugin(): Promise<Hooks> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const available = Option.isSome(yield* which("az"))
      return yield* createAzureAuthHooks(runAzure, fetch, available)
    }),
  )
}

export const createAzureAuthHooks = Effect.fn("AzureAuth.hooks")(function* (
  run: AzureCommand,
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  available: boolean,
) {
  const tokens = MutableHashMap.empty<string, { token: string; expires: number }>()

  const token = Effect.fn("AzureAuth.token")(function* (scope: string) {
    const now = yield* Clock.currentTimeMillis
    const cached = MutableHashMap.get(tokens, scope).pipe(
      Option.filter((entry) => entry.expires - now > AZURE_TOKEN_REFRESH_BUFFER),
    )
    if (Option.isSome(cached)) return cached.value.token

    const result = yield* decodeAzureCliToken(
      yield* run(["account", "get-access-token", "--scope", scope, "--output", "json"]),
    )
    const expires = expiresAt(result)
    if (Option.isNone(expires)) {
      return yield* new AzureAuthError({ message: "Azure CLI returned an invalid token expiration" })
    }
    MutableHashMap.set(tokens, scope, { token: result.accessToken, expires: expires.value })
    return result.accessToken
  })

  const authorizedFetch = (input: RequestInfo | URL, init?: RequestInit) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const headers = input instanceof Request ? new Headers(input.headers) : new Headers()
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
        headers.delete("api-key")
        headers.delete("x-api-key")
        headers.set("authorization", `Bearer ${yield* token(scopeForRequest(input))}`)
        headers.set("User-Agent", `opencode/${InstallationVersion}`)
        // The AI SDK inspects a fetch rejection (abort, network failure), so a rejected request
        // must reach it unchanged. Effect.promise keeps the rejection as a defect, and runPromise
        // rejects with that same value.
        return yield* Effect.promise(() => request(input, { ...init, headers }))
      }),
    )

  const complete = Effect.fn("AzureAuth.complete")(function* (inputs?: Record<string, string>) {
    const configured = (yield* readEnvSnapshot(ResourceName)).pipe(Option.filter(nonEmpty))
    const resourceName = Option.fromNullishOr(inputs?.resourceName).pipe(
      Option.orElse(() => configured),
      Option.filter(nonEmpty),
    )
    if (Option.isNone(resourceName)) return yield* new AzureAuthError({ message: "Azure Resource Name is required" })

    yield* token(AZURE_COGNITIVE_SERVICES_SCOPE)
    const now = yield* Clock.currentTimeMillis
    return {
      type: "success" as const,
      access: OAUTH_DUMMY_KEY,
      refresh: OAUTH_DUMMY_KEY,
      expires: now + AZURE_OAUTH_LIFETIME,
      accountId: resourceName.value,
    }
  })

  const configured = (yield* readEnvSnapshot(ResourceName)).pipe(Option.filter(nonEmpty))
  const prompts = Option.isSome(configured)
    ? []
    : [
        {
          type: "text" as const,
          key: "resourceName",
          message: "Enter Azure Resource Name",
          placeholder: "e.g. my-models",
        },
      ]
  const api: AuthMethod = {
    type: "api",
    label: "API key",
    prompts,
  }
  const oauth: AuthMethod = {
    type: "oauth",
    label: "Microsoft Entra ID (Azure CLI)",
    prompts,
    authorize: (inputs) =>
      Effect.runPromise(
        Effect.succeed({
          url: "",
          instructions: "Sign in with `az login` before continuing.",
          method: "auto" as const,
          callback: () => Effect.runPromise(complete(inputs)),
        }),
      ),
  }
  const hooks: Hooks = {
    auth: {
      provider: "azure",
      loader: (getAuth) =>
        Effect.runPromise(
          Effect.gen(function* () {
            // A rejection from the host auth reader passes through unchanged, as before.
            const auth = yield* Effect.promise(() => getAuth())
            if (auth.type !== "oauth") return {}
            return {
              apiKey: OAUTH_DUMMY_KEY,
              fetch: authorizedFetch,
            }
          }),
        ),
      methods: available ? [api, oauth] : [api],
    },
  }
  return hooks
})

function expiresAt(result: AzureCliToken) {
  const expires = Option.match(Option.fromNullishOr(result.expires_on), {
    onSome: (seconds) => Option.some(seconds * 1000),
    onNone: () =>
      Option.fromNullishOr(result.expiresOn).pipe(
        Option.flatMap(decodeExpiresOn),
        Option.flatMap(DateTime.make),
        Option.map(DateTime.toEpochMillis),
      ),
  })
  return Option.filter(expires, Number.isFinite)
}

function scopeForRequest(input: RequestInfo | URL) {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.hostname.endsWith(".services.ai.azure.com") && !url.pathname.startsWith("/models")) {
    return AZURE_FOUNDRY_SCOPE
  }
  return AZURE_COGNITIVE_SERVICES_SCOPE
}
