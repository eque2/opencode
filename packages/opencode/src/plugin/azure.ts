import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { which } from "@opencode-ai/core/util/which"
import type { Hooks } from "@opencode-ai/plugin"
import { DateTime, Effect, MutableHashMap, Option, Schema } from "effect"
import { OAUTH_DUMMY_KEY } from "../auth"
import { Process } from "../util/process"

const AZURE_COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"
const AZURE_FOUNDRY_SCOPE = "https://ai.azure.com/.default"
const AZURE_TOKEN_REFRESH_BUFFER = 60_000

const AzureCliToken = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  expires_on: Schema.optional(Schema.Number),
  expiresOn: Schema.optional(Schema.NonEmptyString),
}).annotate({ identifier: "AzureCliToken" })
type AzureCliToken = typeof AzureCliToken.Type
const decodeAzureCliToken = Schema.decodeUnknownPromise(AzureCliToken)
// Azure CLI versions that give only expiresOn write a local date-time with no zone. DateFromString
// parses it with the Date constructor, which reads such a string as local time.
const decodeExpiresOn = Schema.decodeUnknownOption(Schema.DateFromString)
type AzureCommand = (args: string[]) => Promise<unknown>

export async function AzureAuthPlugin(): Promise<Hooks> {
  const available = Option.isSome(await Effect.runPromise(which("az")))
  return createAzureAuthHooks(runAzure, fetch, available)
}

export function createAzureAuthHooks(
  run: AzureCommand,
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  available: boolean,
): Hooks {
  const tokens = MutableHashMap.empty<string, { token: string; expires: number }>()
  async function token(scope: string) {
    const cached = MutableHashMap.get(tokens, scope)
    if (Option.isSome(cached) && cached.value.expires - Date.now() > AZURE_TOKEN_REFRESH_BUFFER) return cached.value.token

    const result = await decodeAzureCliToken(
      await run(["account", "get-access-token", "--scope", scope, "--output", "json"]),
    )
    const expires = expiresAt(result)
    if (Option.isNone(expires)) throw new Error("Azure CLI returned an invalid token expiration")
    const refreshed = { token: result.accessToken, expires: expires.value }
    MutableHashMap.set(tokens, scope, refreshed)
    return refreshed.token
  }

  const prompts = process.env.AZURE_RESOURCE_NAME
    ? []
    : [
        {
          type: "text" as const,
          key: "resourceName",
          message: "Enter Azure Resource Name",
          placeholder: "e.g. my-models",
        },
      ]
  const hooks: Hooks = {
    auth: {
      provider: "azure",
      async loader(getAuth) {
        if ((await getAuth()).type !== "oauth") return {}

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const headers = input instanceof Request ? new Headers(input.headers) : new Headers()
            new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
            headers.delete("api-key")
            headers.delete("x-api-key")
            headers.set("authorization", `Bearer ${await token(scopeForRequest(input))}`)
            headers.set("User-Agent", `opencode/${InstallationVersion}`)
            return request(input, { ...init, headers })
          },
        }
      },
      methods: [
        {
          type: "api",
          label: "API key",
          prompts,
        },
        {
          type: "oauth",
          label: "Microsoft Entra ID (Azure CLI)",
          prompts,
          async authorize(inputs) {
            return {
              url: "",
              instructions: "Sign in with `az login` before continuing.",
              method: "auto",
              callback: async () => {
                const resourceName = inputs?.resourceName ?? process.env.AZURE_RESOURCE_NAME
                if (!resourceName) throw new Error("Azure Resource Name is required")

                await token(AZURE_COGNITIVE_SERVICES_SCOPE)
                return {
                  type: "success",
                  access: OAUTH_DUMMY_KEY,
                  refresh: OAUTH_DUMMY_KEY,
                  expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
                  accountId: resourceName,
                }
              },
            }
          },
        },
      ],
    },
  }
  if (!available && hooks.auth) hooks.auth.methods = hooks.auth.methods.filter((method) => method.type !== "oauth")
  return hooks
}

async function runAzure(args: string[]): Promise<unknown> {
  const az = Option.getOrElse(await Effect.runPromise(which("az")), () => "az")
  const result = await Process.run([az, ...args])
  return JSON.parse(result.stdout.toString())
}

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
