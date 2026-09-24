import { Record, type Schema } from "effect"
import type { JsonSchema, ModelToolSchemaCompatibility } from "../../schema"
import { isRecord } from "../../utils/record"
import { GeminiToolSchema } from "./gemini-tool-schema"

type Json = Schema.Json
type JsonEntry = readonly [string, Json]

const isJsonArray = (value: Json | undefined): value is Schema.JsonArray => Array.isArray(value)

const isJsonObject = (value: Json | undefined): value is Schema.JsonObject => isRecord(value)

const removeNullSchemas = (value: Json): Json => {
  if (isJsonArray(value)) return value.map(removeNullSchemas)
  if (!isJsonObject(value)) return value
  const fields = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "anyOf")
      .map(([key, field]) => [key, removeNullSchemas(field)] as const),
  )
  if (!isJsonArray(value.anyOf)) return fields
  const variants = value.anyOf
    .filter((variant) => !isJsonObject(variant) || variant.type !== "null")
    .map(removeNullSchemas)
  if (variants.length === 1 && isJsonObject(variants[0]))
    return Record.union(fields, variants[0], (_, variant) => variant)
  return { ...fields, anyOf: variants }
}

const tupleItemsSchema = (items: ReadonlyArray<Json>): Json => {
  const projected = items.map(moonshotNode)
  if (projected.length === 0) return {}
  if (projected.length === 1) return projected[0]
  return { anyOf: projected }
}

const moonshotNode = (schema: Json): Json => {
  if (isJsonArray(schema)) return schema.map(moonshotNode)
  if (!isJsonObject(schema)) return schema
  if (typeof schema.$ref === "string") return { $ref: schema.$ref }
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]): ReadonlyArray<JsonEntry> => {
      if (key === "items" && isJsonArray(value)) return [[key, tupleItemsSchema(value)]]
      if (key === "prefixItems") {
        if ("items" in schema) return []
        return [["items", tupleItemsSchema(isJsonArray(value) ? value : [])]]
      }
      if (key === "unevaluatedItems") return []
      return [[key, moonshotNode(value)]]
    }),
  )
}

const moonshot = (schema: JsonSchema): JsonSchema => {
  const projected = moonshotNode(schema)
  return isJsonObject(projected) ? projected : {}
}

const openAI = (schema: JsonSchema): JsonSchema => {
  const variants = isJsonArray(schema.anyOf) ? schema.anyOf.filter(isJsonObject) : []
  const flattened =
    variants.length === 0
      ? { ...schema, type: "object" }
      : {
          ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "anyOf")),
          type: "object",
          // Earlier variants win when two variants declare the same property.
          properties: variants.reduce<Schema.JsonObject>(
            (properties, variant) =>
              Record.union(
                isJsonObject(variant.properties) ? variant.properties : {},
                properties,
                (_, earlier) => earlier,
              ),
            {},
          ),
          additionalProperties: false,
        }
  const normalized = removeNullSchemas(flattened)
  return isJsonObject(normalized) ? normalized : { type: "object" }
}

const gemini = (schema: JsonSchema): JsonSchema => GeminiToolSchema.convert(schema) ?? {}

// One projection per compatibility mode. The mapped type keeps the table
// exhaustive when a new mode is added.
const projections: { readonly [Mode in ModelToolSchemaCompatibility]: (schema: JsonSchema) => JsonSchema } = {
  gemini,
  moonshot,
}

const modelCompatibility = (schema: JsonSchema, compatibility: ModelToolSchemaCompatibility | undefined): JsonSchema =>
  compatibility === undefined ? schema : projections[compatibility](schema)

export const ToolSchemaProjection = {
  gemini,
  modelCompatibility,
  moonshot,
  openAI,
} as const
