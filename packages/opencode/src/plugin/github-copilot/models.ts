import type { Model } from "@opencode-ai/sdk/v2"
import { Array as Arr, Effect, HashSet, MutableHashMap, Option, Schema } from "effect"
import { errorMessage } from "@/util/error"

export class CopilotModelsError extends Schema.TaggedError<CopilotModelsError>()("CopilotModels.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const ModelID = Schema.String.pipe(Schema.brand("CopilotModelID"))
type ModelID = typeof ModelID.Type

const item = Schema.Struct({
  model_picker_enabled: Schema.Boolean,
  id: ModelID,
  name: Schema.String,
  // every version looks like: `{model.id}-YYYY-MM-DD`
  version: Schema.String,
  supported_endpoints: Schema.optional(Schema.Array(Schema.String)),
  policy: Schema.optional(
    Schema.Struct({
      state: Schema.optional(Schema.String),
    }),
  ),
  billing: Schema.optional(
    Schema.Struct({
      token_prices: Schema.optional(
        Schema.Struct({
          batch_size: Schema.Number,
          default: Schema.Struct({
            cache_price: Schema.Number,
            input_price: Schema.Number,
            output_price: Schema.Number,
          }),
        }),
      ),
    }),
  ),
  capabilities: Schema.Struct({
    family: Schema.String,
    limits: Schema.optional(
      Schema.Struct({
        max_context_window_tokens: Schema.optional(Schema.Number),
        max_output_tokens: Schema.optional(Schema.Number),
        max_prompt_tokens: Schema.optional(Schema.Number),
        vision: Schema.optional(
          Schema.Struct({
            max_prompt_image_size: Schema.Number,
            max_prompt_images: Schema.Number,
            supported_media_types: Schema.Array(Schema.String),
          }),
        ),
      }),
    ),
    supports: Schema.Struct({
      adaptive_thinking: Schema.optional(Schema.Boolean),
      max_thinking_budget: Schema.optional(Schema.Number),
      min_thinking_budget: Schema.optional(Schema.Number),
      reasoning_effort: Schema.optional(Schema.Array(Schema.String)),
      streaming: Schema.optional(Schema.Boolean),
      structured_outputs: Schema.optional(Schema.Boolean),
      tool_calls: Schema.optional(Schema.Boolean),
      vision: Schema.optional(Schema.Boolean),
    }),
  }),
}).annotate({ identifier: "CopilotModelItem" })

// Each entry decodes on its own below, so one malformed model does not hide the others.
export const schema = Schema.Struct({
  data: Schema.Array(Schema.Json),
}).annotate({ identifier: "CopilotModelsResponse" })

type Item = Schema.Schema.Type<typeof item>
type SelectableItem = Item & {
  capabilities: Item["capabilities"] & {
    limits: NonNullable<Item["capabilities"]["limits"]> & {
      max_output_tokens: number
      max_prompt_tokens: number
    }
    supports: Item["capabilities"]["supports"] & {
      tool_calls: boolean
    }
  }
}
type CopilotEndpoint = "chat" | "responses" | "messages"
// In priority order: the first endpoint the model supports wins.
const ENDPOINTS: ReadonlyArray<readonly [string, CopilotEndpoint]> = [
  ["/v1/messages", "messages"],
  ["/responses", "responses"],
  ["/chat/completions", "chat"],
]
type CopilotModel = Omit<Model, "api"> & {
  api: Model["api"] & { endpoint?: CopilotEndpoint }
}
const decodeModels = Schema.decodeUnknownEffect(schema)
const decodeItem = Schema.decodeUnknownOption(item)

function build(key: string, remote: SelectableItem, url: string, prev?: Model): Model {
  const reasoning =
    !!remote.capabilities.supports.adaptive_thinking ||
    !!remote.capabilities.supports.reasoning_effort?.length ||
    remote.capabilities.supports.max_thinking_budget !== undefined ||
    remote.capabilities.supports.min_thinking_budget !== undefined
  const image =
    (remote.capabilities.supports.vision ?? false) ||
    (remote.capabilities.limits.vision?.supported_media_types ?? []).some((item) => item.startsWith("image/"))
  const pdf =
    (remote.capabilities.supports.vision ?? false) &&
    (remote.capabilities.limits.vision?.supported_media_types?.includes("application/pdf") ?? false)

  const isMsgApi = remote.supported_endpoints?.includes("/v1/messages")
  const endpoint = Arr.findFirst(ENDPOINTS, ([path]) => remote.supported_endpoints?.includes(path) ?? false).pipe(
    Option.map(([, endpoint]) => endpoint),
  )
  const prices = remote.billing?.token_prices
  // Copilot prices are AIC per billing batch; OpenCode stores USD per million tokens.
  const usdPerMillion = prices && prices.batch_size > 0 ? 10_000 / prices.batch_size : 0

  const model: CopilotModel = {
    id: key,
    providerID: "github-copilot",
    api: {
      id: remote.id,
      url: isMsgApi ? `${url}/v1` : url,
      npm: isMsgApi ? "@ai-sdk/anthropic" : "@ai-sdk/github-copilot",
      ...(Option.isSome(endpoint) ? { endpoint: endpoint.value } : {}),
    },
    // API response wins
    status: "active",
    limit: {
      context: remote.capabilities.limits.max_context_window_tokens ?? remote.capabilities.limits.max_prompt_tokens,
      input: remote.capabilities.limits.max_prompt_tokens,
      output: remote.capabilities.limits.max_output_tokens,
    },
    capabilities: {
      temperature: prev?.capabilities.temperature ?? true,
      reasoning: prev?.capabilities.reasoning ?? reasoning,
      attachment: prev?.capabilities.attachment ?? true,
      toolcall: remote.capabilities.supports.tool_calls,
      input: {
        text: true,
        audio: false,
        image,
        video: false,
        pdf,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    // existing wins
    family: prev?.family ?? remote.capabilities.family,
    name: prev?.name ?? remote.name,
    cost: {
      input: (prices?.default.input_price ?? 0) * usdPerMillion,
      output: (prices?.default.output_price ?? 0) * usdPerMillion,
      cache: {
        read: (prices?.default.cache_price ?? 0) * usdPerMillion,
        // `/models` exposes cached-input reads only; per-request billing accounts for cache writes.
        write: 0,
      },
    },
    options: prev?.options ?? {},
    headers: prev?.headers ?? {},
    release_date:
      prev?.release_date ??
      (remote.version.startsWith(`${remote.id}-`) ? remote.version.slice(remote.id.length + 1) : remote.version),
  }

  const efforts = remote.capabilities.supports.reasoning_effort
  const variants: NonNullable<Model["variants"]> = {}
  if (!isMsgApi && efforts?.length) {
    efforts.forEach((effort) => {
      variants[effort] = {
        reasoningEffort: effort,
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      }
    })
  } else {
    if (efforts?.length && remote.capabilities.supports.adaptive_thinking) {
      efforts.forEach((effort) => {
        variants[effort] = {
          thinking: {
            type: "adaptive",
            display: "summarized",
          },
          effort,
        }
      })
    } else if (remote.capabilities.supports.max_thinking_budget) {
      const max = remote.capabilities.supports.max_thinking_budget
      variants["max"] = {
        thinking: {
          type: "enabled",
          budgetTokens: max - 1,
        },
      }
      variants["high"] = {
        thinking: {
          type: "enabled",
          budgetTokens: Math.floor(max / 2),
        },
      }
    }
  }
  if (Object.keys(variants).length > 0) {
    model.variants = variants
  }

  return model
}

function usable(item: Item): item is SelectableItem {
  return (
    item.policy?.state !== "disabled" &&
    item.capabilities.limits?.max_output_tokens !== undefined &&
    item.capabilities.limits.max_prompt_tokens !== undefined &&
    item.capabilities.supports.tool_calls !== undefined
  )
}

export const get = Effect.fn("CopilotModels.get")(function* (
  baseURL: string,
  headers: HeadersInit = {},
  existing: Record<string, Model> = {},
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(`${baseURL}/models`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      }),
    catch: (cause) => new CopilotModelsError({ message: errorMessage(cause), cause }),
  })
  if (!response.ok) {
    return yield* new CopilotModelsError({ message: `Failed to fetch models: ${response.status}` })
  }
  const body = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new CopilotModelsError({ message: errorMessage(cause), cause }),
  })
  const data = yield* decodeModels(body).pipe(
    Effect.mapError((cause) => new CopilotModelsError({ message: cause.message, cause })),
  )

  const remote = MutableHashMap.fromIterable(
    Arr.getSomes(
      Arr.map(data.data, (raw) =>
        decodeItem(raw).pipe(
          Option.filter(usable),
          Option.map((item) => [item.id, item] as const),
        ),
      ),
    ),
  )

  // prune existing models whose api.id isn't in the endpoint response
  const kept = Arr.getSomes(
    Arr.map(Object.entries(existing), ([key, model]) =>
      MutableHashMap.get(remote, ModelID.make(model.api.id)).pipe(
        Option.map((match) => [key, build(key, match, baseURL, model)] as const),
      ),
    ),
  )
  const result: Record<string, Model> = Object.fromEntries(kept)

  // add new endpoint models not already keyed in result
  const added = Arr.getSomes(
    Arr.map(Arr.fromIterable(remote), ([id, match]) =>
      id in result ? Option.none() : Option.some([id, build(id, match, baseURL)] as const),
    ),
  )

  return {
    models: { ...result, ...Object.fromEntries(added) },
    pickerEnabled: HashSet.fromIterable(
      Arr.getSomes(
        Arr.map(Arr.fromIterable(remote), ([id, item]) =>
          item.model_picker_enabled ? Option.some(id) : Option.none(),
        ),
      ),
    ),
  }
})

export * as CopilotModels from "./models"
