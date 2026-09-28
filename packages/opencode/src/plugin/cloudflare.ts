import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Config, Effect, Option } from "effect"

// An empty variable counts as unset, as the former `!process.env.X` checks did.
const envSet = (name: string) =>
  readEnvSnapshot(Config.option(Config.String(name))).pipe(
    Effect.map((value) => Option.isSome(Option.filter(value, (item) => item !== ""))),
  )

const accountIdPrompt = {
  type: "text" as const,
  key: "accountId",
  message: "Enter your Cloudflare Account ID",
  placeholder: "e.g. 1234567890abcdef1234567890abcdef",
}

const gatewayIdPrompt = {
  type: "text" as const,
  key: "gatewayId",
  message: "Enter your Cloudflare AI Gateway ID",
  placeholder: "e.g. my-gateway",
}

export function CloudflareWorkersAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const prompts = (yield* envSet("CLOUDFLARE_ACCOUNT_ID")) ? [] : [accountIdPrompt]
      return {
        auth: {
          provider: "cloudflare-workers-ai",
          methods: [
            {
              type: "api",
              label: "API key",
              prompts,
            },
          ],
        },
      } satisfies Hooks
    }),
  )
}

export function CloudflareAIGatewayAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const prompts = [
        ...((yield* envSet("CLOUDFLARE_ACCOUNT_ID")) ? [] : [accountIdPrompt]),
        ...((yield* envSet("CLOUDFLARE_GATEWAY_ID")) ? [] : [gatewayIdPrompt]),
      ]
      return {
        auth: {
          provider: "cloudflare-ai-gateway",
          methods: [
            {
              type: "api",
              label: "Gateway API token",
              prompts,
            },
          ],
        },
      } satisfies Hooks
    }),
  )
}
