import type {
  AgentListOutput,
  ModelDefaultOutput,
  ModelListOutput,
  PermissionV2Request,
  ProviderListOutput,
} from "@opencode-ai/client/promise"
import type {
  Agent,
  Model,
  PermissionRequest,
  Project,
  Provider,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2/client"
import type { Project as CurrentProject } from "@opencode-ai/client/promise"
import { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { DateTime, HashMap, Option, Predicate } from "effect"
export { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/utils/path-key"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function normalizeAgentList(input: AgentListOutput["data"] | Agent[]): Agent[] {
  if (input.every((agent) => !("request" in agent))) return input as Agent[]
  return (input as AgentListOutput["data"]).map((agent) => {
    const { temperature, topP } = agent.request.settings
    return {
      name: agent.id,
      description: agent.description,
      mode: agent.mode,
      hidden: agent.hidden,
      ...(Predicate.isNumber(temperature) ? { temperature } : {}),
      ...(Predicate.isNumber(topP) ? { topP } : {}),
      color: agent.color,
      permission: agent.permissions.map((rule) => ({
        permission: rule.action,
        pattern: rule.resource,
        action: rule.effect,
      })),
      model: agent.model && { providerID: agent.model.providerID, modelID: agent.model.id },
      variant: agent.model?.variant,
      prompt: agent.system,
      options: agent.request.settings,
      steps: agent.steps,
    }
  })
}

export function normalizePermissionRequest(input: PermissionV2Request | PermissionRequest): PermissionRequest {
  if ("permission" in input) return input
  return {
    id: input.id,
    sessionID: input.sessionID,
    permission: input.action,
    patterns: input.resources,
    always: input.save ?? [],
    metadata: input.metadata ?? {},
    ...(input.source?.type === "tool"
      ? { tool: { messageID: input.source.messageID, callID: input.source.callID } }
      : {}),
  }
}

function toProviderModel(model: ModelListOutput["data"][number], providerID: string): Model {
  const cost = model.cost.find((item) => item.tier === undefined) ?? model.cost[0]
  return {
    id: model.id,
    providerID: model.providerID,
    api: {
      id: model.modelID,
      url: "",
      npm: model.package ?? providerID,
    },
    name: model.name,
    family: model.family,
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: model.capabilities.input.some((item) => item !== "text"),
      toolcall: model.capabilities.tools,
      input: {
        text: model.capabilities.input.includes("text"),
        audio: model.capabilities.input.includes("audio"),
        image: model.capabilities.input.includes("image"),
        video: model.capabilities.input.includes("video"),
        pdf: model.capabilities.input.includes("pdf"),
      },
      output: {
        text: model.capabilities.output.includes("text"),
        audio: model.capabilities.output.includes("audio"),
        image: model.capabilities.output.includes("image"),
        video: model.capabilities.output.includes("video"),
        pdf: model.capabilities.output.includes("pdf"),
      },
      interleaved: false,
    },
    cost: {
      input: cost?.input ?? 0,
      output: cost?.output ?? 0,
      cache: {
        read: cost?.cache.read ?? 0,
        write: cost?.cache.write ?? 0,
      },
    },
    limit: model.limit,
    status: model.status,
    options: model.settings ?? {},
    headers: model.headers ?? {},
    release_date: DateTime.formatIsoDateUtc(DateTime.makeUnsafe(model.time.released)),
    variants: Object.fromEntries(model.variants.map((variant) => [variant.id, variant.settings ?? {}])),
  }
}

export function normalizeProviderList(
  providers: ProviderListOutput["data"] | ProviderListResponse,
  models?: ModelListOutput["data"],
  defaultModel?: ModelDefaultOutput["data"],
): NormalizedProviderListResponse {
  if (!Array.isArray(providers)) {
    return {
      ...providers,
      all: HashMap.fromIterable<string, Provider>(
        providers.all.map((provider) => [
          provider.id,
          {
            ...provider,
            models: Object.fromEntries(
              Object.entries(provider.models).filter(([, model]) => model.status !== "deprecated"),
            ),
          },
        ]),
      ),
    }
  }
  const catalogModels = (models ?? []).filter((model) => model.status !== "deprecated")
  const all = HashMap.fromIterable<string, Provider>(
    providers.map((provider) => [
      provider.id,
      {
        id: provider.id,
        name: provider.name,
        source: "custom",
        env: [],
        options: provider.settings ?? {},
        models: Object.fromEntries(
          catalogModels
            .filter((model) => model.providerID === provider.id)
            .map((model) => [model.id, toProviderModel(model, provider.id)]),
        ),
      },
    ]),
  )

  return {
    all,
    connected: providers.map((provider) => provider.id),
    defaultModel: Option.getOrNull(
      Option.map(Option.fromNullishOr(defaultModel), (model) => ({ providerID: model.providerID, modelID: model.id })),
    ),
    default: Object.fromEntries(
      providers.flatMap((provider) => {
        const model =
          defaultModel?.providerID === provider.id
            ? defaultModel
            : models?.find((item) => item.providerID === provider.id && item.status !== "deprecated")
        return model ? [[provider.id, model.id]] : []
      }),
    ),
  }
}

export function sanitizeProject(project: Project) {
  if (!project.icon?.url && !project.icon?.override) return project
  const { url: _url, override: _override, ...icon } = project.icon ?? {}
  return { ...project, icon }
}

export function normalizeProjectInfo(project: Project | CurrentProject): Project {
  const { vcs, ...rest } = project
  return { ...rest, ...(vcs === "git" ? { vcs } : {}) }
}
