import { Option, Predicate, Schema } from "effect"
import { JsonSchema, ModelID, ProviderID } from "./ids"
import type { AnyRoute } from "../route/client"
import { isRecord } from "../utils/record"

/** A record with at least one key, or none. */
const nonEmptyRecord = <A extends object>(record: A): Option.Option<A> =>
  Option.liftPredicate(record, (value: A) => Object.keys(value).length > 0)

/**
 * Deep-merge records, later values winning and undefined values skipped.
 * Merging JSON objects yields a JSON object: every value comes from an input.
 */
export function mergeJsonRecords(...items: ReadonlyArray<Schema.JsonObject | undefined>): Schema.JsonObject | undefined
export function mergeJsonRecords(
  ...items: ReadonlyArray<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined
export function mergeJsonRecords(
  ...items: ReadonlyArray<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const defined = items.filter((item): item is Record<string, unknown> => item !== undefined)
  if (defined.length === 0) return undefined
  if (defined.length === 1 && Object.values(defined[0]).every((value) => value !== undefined)) return defined[0]
  const result: Record<string, unknown> = {}
  for (const item of defined) {
    for (const [key, value] of Object.entries(item)) {
      if (value === undefined) continue
      result[key] = isRecord(result[key]) && isRecord(value) ? mergeJsonRecords(result[key], value) : value
    }
  }
  return Option.getOrUndefined(nonEmptyRecord(result))
}

const mergeStringRecords = (
  ...items: ReadonlyArray<Record<string, string> | undefined>
): Option.Option<Record<string, string>> => {
  const defined = items.filter(Predicate.isNotUndefined)
  if (defined.length === 1) return Option.some(defined[0])
  return nonEmptyRecord(
    Object.fromEntries(
      defined.flatMap((item) =>
        Object.entries(item).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    ),
  )
}

export const ProviderOptions = Schema.Record(Schema.String, Schema.JsonObject)
export type ProviderOptions = Schema.Schema.Type<typeof ProviderOptions>

export const mergeProviderOptions = (
  ...items: ReadonlyArray<ProviderOptions | undefined>
): ProviderOptions | undefined => {
  const result: Record<string, Schema.JsonObject> = {}
  for (const item of items) {
    if (!item) continue
    for (const [provider, options] of Object.entries(item)) {
      const merged = mergeJsonRecords(result[provider], options)
      if (merged) result[provider] = merged
    }
  }
  return Option.getOrUndefined(nonEmptyRecord(result))
}

export class HttpOptions extends Schema.Class<HttpOptions>("LLM.HttpOptions")({
  body: Schema.optional(JsonSchema),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  query: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export namespace HttpOptions {
  export type Input = HttpOptions | ConstructorParameters<typeof HttpOptions>[0]

  /** Normalize HTTP option input into the canonical `HttpOptions` class. */
  export const make = (input: Input) => (input instanceof HttpOptions ? input : new HttpOptions(input))
}

export const mergeHttpOptions = (...items: ReadonlyArray<HttpOptions | undefined>): HttpOptions | undefined => {
  const body = mergeJsonRecords(...items.map((item) => item?.body))
  const headers = mergeStringRecords(...items.map((item) => item?.headers))
  const query = mergeStringRecords(...items.map((item) => item?.query))
  if (!body && Option.isNone(headers) && Option.isNone(query)) return undefined
  return new HttpOptions({ body, headers: Option.getOrUndefined(headers), query: Option.getOrUndefined(query) })
}

export class GenerationOptions extends Schema.Class<GenerationOptions>("LLM.GenerationOptions")({
  maxTokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  topP: Schema.optional(Schema.Number),
  topK: Schema.optional(Schema.Number),
  frequencyPenalty: Schema.optional(Schema.Number),
  presencePenalty: Schema.optional(Schema.Number),
  seed: Schema.optional(Schema.Number),
  stop: Schema.optional(Schema.Array(Schema.String)),
}) {}

export namespace GenerationOptions {
  export type Input = GenerationOptions | ConstructorParameters<typeof GenerationOptions>[0]

  /** Normalize generation option input into the canonical `GenerationOptions` class. */
  export const make = (input: Input = {}) => (input instanceof GenerationOptions ? input : new GenerationOptions(input))
}

export type GenerationOptionsFields = {
  readonly maxTokens?: number
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly frequencyPenalty?: number
  readonly presencePenalty?: number
  readonly seed?: number
  readonly stop?: ReadonlyArray<string>
}

export type GenerationOptionsInput = GenerationOptions | GenerationOptionsFields

const latestGeneration = <Key extends keyof GenerationOptionsFields>(
  items: ReadonlyArray<GenerationOptionsInput | undefined>,
  key: Key,
) => items.findLast((item) => item?.[key] !== undefined)?.[key]

export const mergeGenerationOptions = (...items: ReadonlyArray<GenerationOptionsInput | undefined>) => {
  const result = new GenerationOptions({
    maxTokens: latestGeneration(items, "maxTokens"),
    temperature: latestGeneration(items, "temperature"),
    topP: latestGeneration(items, "topP"),
    topK: latestGeneration(items, "topK"),
    frequencyPenalty: latestGeneration(items, "frequencyPenalty"),
    presencePenalty: latestGeneration(items, "presencePenalty"),
    seed: latestGeneration(items, "seed"),
    stop: latestGeneration(items, "stop"),
  })
  return Option.getOrUndefined(
    Option.liftPredicate(result, (options: GenerationOptions) => Object.values(options).some(Predicate.isNotUndefined)),
  )
}

export class ModelLimits extends Schema.Class<ModelLimits>("LLM.ModelLimits")({
  context: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Number),
}) {}

export namespace ModelLimits {
  export type Input = ModelLimits | ConstructorParameters<typeof ModelLimits>[0]

  /** Normalize model limit input into the canonical `ModelLimits` class. */
  export const make = (input: Input | undefined) =>
    input instanceof ModelLimits ? input : new ModelLimits(input ?? {})
}

export class ModelDefaults extends Schema.Class<ModelDefaults>("LLM.ModelDefaults")({
  limits: Schema.optional(ModelLimits),
  generation: Schema.optional(GenerationOptions),
  providerOptions: Schema.optional(ProviderOptions),
  http: Schema.optional(HttpOptions),
}) {}

export namespace ModelDefaults {
  /** Constructor input of the class; `providerOptions` accepts its make-side JSON input type. */
  type MakeInput = NonNullable<ConstructorParameters<typeof ModelDefaults>[0]>
  export type Input =
    | ModelDefaults
    | (Omit<MakeInput, "limits" | "generation" | "http"> & {
        readonly limits?: ModelLimits.Input
        readonly generation?: GenerationOptions.Input
        readonly http?: HttpOptions.Input
      })

  /**
   * Normalize selected-model request defaults without applying precedence.
   * Like the schema class `make` it overrides, it accepts no argument for empty defaults.
   */
  export const make = (input: Input | void) => {
    if (input === undefined) return new ModelDefaults({})
    if (input instanceof ModelDefaults) return input
    return new ModelDefaults({
      ...(input.limits === undefined ? {} : { limits: ModelLimits.make(input.limits) }),
      ...(input.generation === undefined ? {} : { generation: GenerationOptions.make(input.generation) }),
      providerOptions: input.providerOptions,
      ...(input.http === undefined ? {} : { http: HttpOptions.make(input.http) }),
    })
  }
}

export const ModelToolSchemaCompatibility = Schema.Literals(["gemini", "moonshot"])
export type ModelToolSchemaCompatibility = Schema.Schema.Type<typeof ModelToolSchemaCompatibility>

export class ModelCompatibility extends Schema.Class<ModelCompatibility>("LLM.ModelCompatibility")({
  toolSchema: Schema.optional(ModelToolSchemaCompatibility),
}) {}

export namespace ModelCompatibility {
  export type Input = ModelCompatibility | ConstructorParameters<typeof ModelCompatibility>[0]

  /** Normalize model/upstream compatibility metadata without projecting requests. */
  export const make = (input: Input) => (input instanceof ModelCompatibility ? input : new ModelCompatibility(input))
}

export class Model {
  readonly id: ModelID
  readonly provider: ProviderID
  readonly route: AnyRoute
  readonly defaults?: ModelDefaults
  readonly compatibility?: ModelCompatibility

  constructor(input: Model.ConstructorInput) {
    this.id = input.id
    this.provider = input.provider
    this.route = input.route
    this.defaults = input.defaults
    this.compatibility = input.compatibility
  }

  static make(input: Model.Input) {
    return new Model({
      id: ModelID.make(input.id),
      provider: ProviderID.make(input.provider),
      route: input.route,
      ...(input.defaults === undefined ? {} : { defaults: ModelDefaults.make(input.defaults) }),
      ...(input.compatibility === undefined ? {} : { compatibility: ModelCompatibility.make(input.compatibility) }),
    })
  }

  static input(model: Model): Model.ConstructorInput {
    return {
      id: model.id,
      provider: model.provider,
      route: model.route,
      defaults: model.defaults,
      compatibility: model.compatibility,
    }
  }

  static update(model: Model, patch: Partial<Model.Input>) {
    if (Object.keys(patch).length === 0) return model
    return Model.make({
      ...Model.input(model),
      ...patch,
    })
  }
}

export namespace Model {
  export type ConstructorInput = {
    readonly id: ModelID
    readonly provider: ProviderID
    readonly route: AnyRoute
    readonly defaults?: ModelDefaults
    readonly compatibility?: ModelCompatibility
  }

  export type Input = Omit<ConstructorInput, "id" | "provider" | "defaults" | "compatibility"> & {
    readonly id: string | ModelID
    readonly provider: string | ProviderID
    readonly defaults?: ModelDefaults.Input
    readonly compatibility?: ModelCompatibility.Input
  }
}

export type ModelInput = Model.Input

export const ModelSchema = Schema.declare((value): value is Model => value instanceof Model, { expected: "LLM.Model" })

export class CacheHint extends Schema.Class<CacheHint>("LLM.CacheHint")({
  type: Schema.Literals(["ephemeral", "persistent"]),
  ttlSeconds: Schema.optional(Schema.Number),
}) {}

// Auto-placement policy for prompt caching. The protocol-neutral lowering step
// reads this and injects `CacheHint`s at the configured boundaries; the
// per-protocol body builders then translate those hints into wire markers as
// usual. `"auto"` is the recommended default for agent loops — it places one
// breakpoint at the last tool definition, one at the last system part, and one
// at the latest user message. The combination of provider invalidation
// hierarchy (tools → system → messages) and Anthropic/Bedrock's 20-block
// lookback means three trailing breakpoints reliably cover the static prefix.
//
// Pass `"none"` to opt out entirely (the legacy behavior). Pass the granular
// object form to override individual choices.
export const CachePolicyObject = Schema.Struct({
  tools: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Boolean),
  messages: Schema.optional(
    Schema.Union([
      Schema.Literal("latest-user-message"),
      Schema.Literal("latest-assistant"),
      Schema.Struct({ tail: Schema.Number }),
    ]),
  ),
  ttlSeconds: Schema.optional(Schema.Number),
}).annotate({ identifier: "LLM.CachePolicyObject" })
export type CachePolicyObject = Schema.Schema.Type<typeof CachePolicyObject>

export const CachePolicy = Schema.Union([Schema.Literal("auto"), Schema.Literal("none"), CachePolicyObject])
export type CachePolicy = Schema.Schema.Type<typeof CachePolicy>
