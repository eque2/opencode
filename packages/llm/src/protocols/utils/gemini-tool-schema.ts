import { Array as Arr, Option, Record, type Schema } from "effect"
import { isRecord } from "../../utils/record"

// Gemini accepts a JSON Schema-like dialect for tool parameters, but rejects a
// handful of common JSON Schema shapes. Keep this projection isolated so the
// Gemini protocol file still reads like the other protocol modules.
const SCHEMA_INTENT_KEYS = [
  "type",
  "properties",
  "items",
  "prefixItems",
  "enum",
  "const",
  "$ref",
  "additionalProperties",
  "patternProperties",
  "required",
  "not",
  "if",
  "then",
  "else",
]

type Json = Schema.Json

const isJsonArray = (value: Json | undefined): value is Schema.JsonArray => Array.isArray(value)

const isJsonObject = (value: Json | undefined): value is Schema.JsonObject => isRecord(value)

const hasCombiner = (schema: Json) =>
  isJsonObject(schema) && (isJsonArray(schema.anyOf) || isJsonArray(schema.oneOf) || isJsonArray(schema.allOf))

const hasSchemaIntent = (schema: Json) =>
  isJsonObject(schema) && (hasCombiner(schema) || SCHEMA_INTENT_KEYS.some((key) => key in schema))

const sanitizeNode = (schema: Json): Json => {
  if (!isJsonObject(schema)) return isJsonArray(schema) ? schema.map(sanitizeNode) : schema

  const result: Record<string, Json> = Object.fromEntries(
    Object.entries(schema).map(
      ([key, value]) => [key, key === "enum" && isJsonArray(value) ? value.map(String) : sanitizeNode(value)] as const,
    ),
  )

  if (isJsonArray(result.enum) && (result.type === "integer" || result.type === "number")) result.type = "string"

  const properties = result.properties
  if (result.type === "object" && isJsonObject(properties) && isJsonArray(result.required)) {
    result.required = result.required.filter((field) => typeof field === "string" && field in properties)
  }

  if (result.type === "array" && !hasCombiner(result)) {
    result.items = result.items ?? {}
    if (isJsonObject(result.items) && !hasSchemaIntent(result.items))
      result.items = Record.union(result.items, { type: "string" }, (_, type) => type)
  }

  if (typeof result.type === "string" && result.type !== "object" && !hasCombiner(result)) {
    delete result.properties
    delete result.required
  }

  return result
}

const emptyObjectSchema = (schema: Schema.JsonObject) =>
  schema.type === "object" &&
  (!isJsonObject(schema.properties) || Object.keys(schema.properties).length === 0) &&
  !schema.additionalProperties

type Entry = readonly [string, Json]

// Gemini rejects explicit `undefined` keys, so a projected key is kept only
// when its value is defined.
const entry = (key: string, value: Json | undefined): Option.Option<Entry> =>
  Option.map(Option.fromUndefinedOr(value), (defined) => [key, defined] as const)

// A node projects to nothing when it is not an object or is an empty object
// schema. Callers decide what nothing means: the top level omits the
// parameters, a property map drops the key, and a list keeps the position as
// JSON null (what JSON encoding wrote for the old undefined item).
const projectedList = (key: string, value: Json | undefined): Option.Option<Entry> =>
  isJsonArray(value)
    ? Option.some([key, value.map((item) => Option.getOrNull(projectNode(item)))] as const)
    : Option.none()

const projectedProperties = (value: Json | undefined): Option.Option<Entry> =>
  isJsonObject(value)
    ? Option.some([
        "properties",
        Object.fromEntries(
          Arr.getSomes(
            Object.entries(value).map(([key, property]) =>
              Option.map(projectNode(property), (node) => [key, node] as const),
            ),
          ),
        ),
      ] as const)
    : Option.none()

const projectNode = (schema: Json | undefined): Option.Option<Schema.JsonObject> => {
  if (!isJsonObject(schema) || emptyObjectSchema(schema)) return Option.none()
  return Option.some(
    Object.fromEntries(
      Arr.getSomes([
        entry("description", schema.description),
        entry("required", schema.required),
        entry("format", schema.format),
        entry("type", isJsonArray(schema.type) ? schema.type.filter((type) => type !== "null")[0] : schema.type),
        isJsonArray(schema.type) && schema.type.includes("null")
          ? Option.some<Entry>(["nullable", true])
          : Option.none<Entry>(),
        entry("enum", schema.const !== undefined ? [schema.const] : schema.enum),
        projectedProperties(schema.properties),
        isJsonArray(schema.items)
          ? projectedList("items", schema.items)
          : Option.map(projectNode(schema.items), (node) => ["items", node] as const),
        projectedList("allOf", schema.allOf),
        projectedList("anyOf", schema.anyOf),
        projectedList("oneOf", schema.oneOf),
        entry("minLength", schema.minLength),
      ]),
    ),
  )
}

export const convert = (schema: Schema.Json): Schema.JsonObject | undefined =>
  Option.getOrUndefined(projectNode(sanitizeNode(schema)))

export * as GeminiToolSchema from "./gemini-tool-schema"
