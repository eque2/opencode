import os from "os"
import { InstallationVersion } from "../../installation/version"
import { Config, Effect, Option, Predicate, Redacted } from "effect"
import { define } from "../internal"
import { readEnvSnapshot } from "./env-snapshot"
import { ProviderV2 } from "../../provider"

const GitLabEnv = Config.all({
  instanceUrl: Config.String("GITLAB_INSTANCE_URL").pipe(Config.withDefault("https://gitlab.com")),
  token: Config.option(Config.Redacted("GITLAB_TOKEN")),
})

export const GitLabPlugin = define({
  id: "gitlab",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "gitlab-ai-provider") return
        const env = yield* readEnvSnapshot(GitLabEnv)
        const mod = yield* Effect.promise(() => import("gitlab-ai-provider"))
        evt.sdk = mod.createGitLab({
          ...evt.options,
          instanceUrl: typeof evt.options.instanceUrl === "string" ? evt.options.instanceUrl : env.instanceUrl,
          // GitLabProviderSettings.apiKey is string | undefined.
          apiKey: typeof evt.options.apiKey === "string" ? evt.options.apiKey : Option.getOrUndefined(Option.map(env.token, Redacted.value)),
          aiGatewayHeaders: {
            "User-Agent": `opencode/${InstallationVersion} gitlab-ai-provider/${mod.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
            "anthropic-beta": "context-1m-2025-08-07",
            ...evt.options.aiGatewayHeaders,
          },
          featureFlags: {
            duo_agent_platform_agentic_chat: true,
            duo_agent_platform: true,
            ...evt.options.featureFlags,
          },
        })
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.gitlab) return
        const featureFlags =
          typeof evt.options.featureFlags === "object" && evt.options.featureFlags ? evt.options.featureFlags : {}
        if (evt.model.api.id.startsWith("duo-workflow-")) {
          const gitlab = yield* Effect.promise(() => import("gitlab-ai-provider")).pipe(Effect.orDie)
          const workflowRef = Option.liftPredicate(evt.model.request.body.workflowRef, Predicate.isString).pipe(
            Option.filter((ref) => ref !== ""),
          )
          const workflowDefinition = Option.liftPredicate(evt.model.request.body.workflowDefinition, Predicate.isString)
          const language = evt.sdk.workflowChat(
            gitlab.isWorkflowModel(evt.model.api.id) ? evt.model.api.id : "duo-workflow",
            {
              featureFlags,
              // GitLabWorkflowOptions.workflowDefinition is string | undefined.
              workflowDefinition: Option.getOrUndefined(workflowDefinition),
            },
          )
          if (Option.isSome(workflowRef)) language.selectedModelRef = workflowRef.value
          evt.language = language
          return
        }
        evt.language = evt.sdk.agenticChat(evt.model.api.id, {
          aiGatewayHeaders: evt.options.aiGatewayHeaders,
          featureFlags,
        })
      }),
    )
  }),
})
