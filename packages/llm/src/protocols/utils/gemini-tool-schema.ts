import { Array as Arr, Option } from "effect"
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

const hasCombiner = (schema: unknown) =>
  isRecord(schema) && (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf) || Array.isArray(schema.allOf))

const hasSchemaIntent = (schema: unknown) =>
  isRecord(schema) && (hasCombiner(schema) || SCHEMA_INTENT_KEYS.some((key) => key in schema))

const sanitizeNode = (schema: unknown): unknown => {
  if (!isRecord(schema)) return Array.isArray(schema) ? schema.map(sanitizeNode) : schema

  const result: Record<string, unknown> = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      key === "enum" && Array.isArray(value) ? value.map(String) : sanitizeNode(value),
    ]),
  )

  if (Array.isArray(result.enum) && (result.type === "integer" || result.type === "number")) result.type = "string"

  const properties = result.properties
  if (result.type === "object" && isRecord(properties) && Array.isArray(result.required)) {
    result.required = result.required.filter((field) => typeof field === "string" && field in properties)
  }

  if (result.type === "array" && !hasCombiner(result)) {
    result.items = result.items ?? {}
    if (isRecord(result.items) && !hasSchemaIntent(result.items)) result.items = { ...result.items, type: "string" }
  }

  if (typeof result.type === "string" && result.type !== "object" && !hasCombiner(result)) {
    delete result.properties
    delete result.required
  }

  return result
}

const emptyObjectSchema = (schema: Record<string, unknown>) =>
  schema.type === "object" &&
  (!isRecord(schema.properties) || Object.keys(schema.properties).length === 0) &&
  !schema.additionalProperties

type Entry = readonly [string, unknown]

// Gemini rejects explicit `undefined` keys, so a projected key is kept only
// when its value is defined.
const entry = (key: string, value: unknown): Option.Option<Entry> =>
  Option.map(Option.fromUndefinedOr(value), (defined) => [key, defined] as const)

const projectedList = (key: string, value: unknown): Option.Option<Entry> =>
  Array.isArray(value) ? Option.some([key, value.map(projectNode)]) : Option.none()

const projectNode = (schema: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(schema)) return undefined
  if (emptyObjectSchema(schema)) return undefined
  return Object.fromEntries(
    Arr.getSomes([
      entry("description", schema.description),
      entry("required", schema.required),
      entry("format", schema.format),
      entry("type", Array.isArray(schema.type) ? schema.type.filter((type) => type !== "null")[0] : schema.type),
      Array.isArray(schema.type) && schema.type.includes("null") ? Option.some(["nullable", true]) : Option.none(),
      entry("enum", schema.const !== undefined ? [schema.const] : schema.enum),
      isRecord(schema.properties)
        ? Option.some([
            "properties",
            Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, projectNode(value)])),
          ])
        : Option.none(),
      Array.isArray(schema.items) ? projectedList("items", schema.items) : entry("items", projectNode(schema.items)),
      projectedList("allOf", schema.allOf),
      projectedList("anyOf", schema.anyOf),
      projectedList("oneOf", schema.oneOf),
      entry("minLength", schema.minLength),
    ]),
  )
}

export const convert = (schema: unknown) => projectNode(sanitizeNode(schema))

export * as GeminiToolSchema from "./gemini-tool-schema"
