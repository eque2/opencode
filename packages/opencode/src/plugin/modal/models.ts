import type { Model } from "@opencode-ai/sdk/v2"
import { Effect, Schema } from "effect"
import { errorMessage } from "../../util/error"

export class ModalModelsError extends Schema.TaggedError<ModalModelsError>()("ModalModelsError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const reasoningOption = Schema.Struct({
  type: Schema.Literal("effort"),
  values: Schema.Array(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "ModalReasoningOption" })

const response = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String.pipe(Schema.brand("ModalModelID")),
      base_model_id: Schema.optional(Schema.String),
      hugging_face_id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      input_modalities: Schema.optional(Schema.Array(Schema.String)),
      output_modalities: Schema.optional(Schema.Array(Schema.String)),
      context_length: Schema.optional(Schema.Number),
      max_output_length: Schema.optional(Schema.Number),
      pricing: Schema.optional(
        Schema.Struct({
          prompt: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
          completion: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
          input_cache_read: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
        }),
      ),
      supported_sampling_parameters: Schema.optional(Schema.Array(Schema.String)),
      supported_features: Schema.optional(Schema.Array(Schema.String)),
      reasoning_options: Schema.optional(Schema.Array(reasoningOption)),
      interleaved: Schema.optional(
        Schema.Union([
          Schema.Boolean,
          Schema.Struct({
            field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
          }),
        ]),
      ),
    }),
  ),
}).annotate({ identifier: "ModalModelsResponse" })

const decode = Schema.decodeUnknownEffect(response)

function price(value: string | number | undefined, fallback: number) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed * 1_000_000 : fallback
}

export const get = Effect.fn("ModalModels.get")(function* (
  baseURL: string,
  apiKey: string,
  existing: Record<string, Model>,
) {
  const data = yield* Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          signal,
        }),
      catch: (cause) => new ModalModelsError({ message: errorMessage(cause), cause }),
    })
    if (!res.ok) return yield* new ModalModelsError({ message: `Failed to fetch Modal models: ${res.status}` })
    const body = yield* Effect.tryPromise({
      try: (): Promise<unknown> => res.json(),
      catch: (cause) => new ModalModelsError({ message: errorMessage(cause), cause }),
    })
    return yield* decode(body)
  }).pipe(Effect.timeout("3 seconds"))

  return Object.fromEntries(
    data.data.map((item) => {
      const template = existing[item.base_model_id ?? item.hugging_face_id ?? item.id]
      const model: Model = {
        id: item.id,
        providerID: "modal",
        name: item.name ?? template?.name ?? item.id,
        family: template?.family,
        api: {
          id: item.id,
          url: baseURL,
          npm: template?.api.npm ?? "@ai-sdk/openai-compatible",
        },
        status: template?.status ?? "active",
        headers: { ...template?.headers },
        options: { ...template?.options },
        cost: {
          input: price(item.pricing?.prompt, template?.cost.input ?? 0),
          output: price(item.pricing?.completion, template?.cost.output ?? 0),
          cache: {
            read: price(item.pricing?.input_cache_read, template?.cost.cache.read ?? 0),
            write: template?.cost.cache.write ?? 0,
          },
        },
        limit: {
          context: item.context_length ?? template?.limit.context ?? 0,
          input: template?.limit.input,
          output: item.max_output_length ?? template?.limit.output ?? 0,
        },
        capabilities: {
          temperature:
            item.supported_sampling_parameters?.includes("temperature") ?? template?.capabilities.temperature ?? false,
          reasoning: item.supported_features?.includes("reasoning") ?? template?.capabilities.reasoning ?? false,
          attachment:
            item.input_modalities?.some((modality) => modality !== "text") ??
            template?.capabilities.attachment ??
            false,
          toolcall: item.supported_features?.includes("tools") ?? template?.capabilities.toolcall ?? true,
          input: {
            text: item.input_modalities?.includes("text") ?? template?.capabilities.input.text ?? true,
            audio: item.input_modalities?.includes("audio") ?? template?.capabilities.input.audio ?? false,
            image: item.input_modalities?.includes("image") ?? template?.capabilities.input.image ?? false,
            video: item.input_modalities?.includes("video") ?? template?.capabilities.input.video ?? false,
            pdf: item.input_modalities?.includes("pdf") ?? template?.capabilities.input.pdf ?? false,
          },
          output: {
            text: item.output_modalities?.includes("text") ?? template?.capabilities.output.text ?? true,
            audio: item.output_modalities?.includes("audio") ?? template?.capabilities.output.audio ?? false,
            image: item.output_modalities?.includes("image") ?? template?.capabilities.output.image ?? false,
            video: item.output_modalities?.includes("video") ?? template?.capabilities.output.video ?? false,
            pdf: item.output_modalities?.includes("pdf") ?? template?.capabilities.output.pdf ?? false,
          },
          interleaved: item.interleaved ?? template?.capabilities.interleaved ?? false,
        },
        release_date: template?.release_date ?? "",
      }
      model.variants =
        item.reasoning_options === undefined
          ? template?.variants
          : Object.fromEntries(
              item.reasoning_options.flatMap((option) =>
                option.values.map((value) => {
                  const effort = value ?? "none"
                  return [effort, { reasoningEffort: effort }]
                }),
              ),
            )
      return [item.id, model]
    }),
  )
})

export * as ModalModels from "./models"
