export * as ConfigProvider from "./provider"

import { Schema } from "effect"
import { ProviderV2 } from "../provider"
import { ModelV2 } from "../model"

// Request body fields merge into the catalog request body that @opencode-ai/plugin v2 aisdk
// hooks expose as Record<string, any>. ConfigMigrateV1 fills it from the V1 option bags
// (ConfigProviderV1.Options, Schema.Any) and agent files add gray-matter YAML values, so
// Schema.Json rejects valid inputs ("Expected JSON value" in the V1 migration test).
// eslint-disable-next-line effect/no-schema-any-unknown -- (a) @opencode-ai/plugin v2 aisdk hooks type this AI SDK request body as Record<string, any>; it carries V1 option bags and YAML values
const Body = Schema.Record(Schema.String, Schema.Unknown)

export class Request extends Schema.Class<Request>("ConfigV2.Provider.Request")({
  headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  body: Body.pipe(Schema.optional),
}) {}

class Cache extends Schema.Class<Cache>("ConfigV2.Model.Cost.Cache")({
  read: Schema.Finite.pipe(Schema.optional),
  write: Schema.Finite.pipe(Schema.optional),
}) {}

class Cost extends Schema.Class<Cost>("ConfigV2.Model.Cost")({
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Int,
  }).pipe(Schema.optional),
  input: Schema.Finite,
  output: Schema.Finite,
  cache: Cache.pipe(Schema.optional),
}) {}

// A plain struct, not a class: the provider config plugin spreads it over the
// catalog model limit, and a spread would drop a class prototype.
const Limit = Schema.Struct({
  context: Schema.Int.pipe(Schema.optional),
  input: Schema.Int.pipe(Schema.optional),
  output: Schema.Int.pipe(Schema.optional),
}).annotate({ identifier: "ConfigV2.Model.Limit" })

const ModelApi = Schema.Union([
  Schema.Struct({
    id: ModelV2.ID.pipe(Schema.optional),
    ...ProviderV2.AISDK.fields,
  }),
  Schema.Struct({
    id: ModelV2.ID.pipe(Schema.optional),
    ...ProviderV2.Native.fields,
  }),
  Schema.Struct({
    id: ModelV2.ID,
  }),
])

class Model extends Schema.Class<Model>("ConfigV2.Model")({
  family: ModelV2.Family.pipe(Schema.optional),
  name: Schema.String.pipe(Schema.optional),
  api: ModelApi.pipe(Schema.optional),
  capabilities: ModelV2.Capabilities.pipe(Schema.optional),
  request: Schema.Struct({
    ...Request.fields,
    variant: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
  variants: Schema.Struct({
    id: ModelV2.VariantID,
    ...Request.fields,
  }).pipe(Schema.Array, Schema.optional),
  cost: Schema.Union([Cost, Cost.pipe(Schema.Array)]).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  limit: Limit.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Provider")({
  name: Schema.String.pipe(Schema.optional),
  env: Schema.String.pipe(Schema.Array, Schema.optional),
  api: ProviderV2.Api.pipe(Schema.optional),
  request: Request.pipe(Schema.optional),
  models: Schema.Record(Schema.String, Model).pipe(Schema.optional),
}) {}
