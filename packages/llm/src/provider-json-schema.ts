import { type JsonSchema, Schema } from "effect"
import { isRecord } from "./utils/record"

type JsonObject = Record<string, unknown>

// Effect merges a check into the parent schema, instead of `allOf`, when the check holds only these
// keywords and the parent holds none of them yet. This copies the allowlist in Effect's
// internal/schema/toJsonSchemaDocument.ts (inlineableCheckKeywords + promotableAnnotationKeywords).
const MERGEABLE_CHECK_KEYWORDS: ReadonlyArray<string> = [
  "type",
  "format",
  "pattern",
  "multipleOf",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "propertyNames",
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
]

// These keywords hold JSON data, not subschemas, so the walk leaves them as they are.
const DATA_KEYWORDS: ReadonlyArray<string> = ["const", "default", "enum", "examples"]

/**
 * Converts an Effect schema to the JSON Schema that a provider receives for a tool.
 *
 * Named definitions, when the schema has any, go into `$defs`.
 */
export const fromSchema = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema)
  return withoutSafeIntegerRange(
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions },
  )
}

/**
 * Removes the safe-integer range that Effect 4.0 adds for `Schema.isInt`, at every level of the schema.
 *
 * Effect 4.0.0-rc.117 exported `Schema.Int` as `{ type: "integer" }`. Effect 4.0.x exports it as
 * `{ type: "integer", minimum: -(2^53 - 1), maximum: 2^53 - 1 }`, so a later `minimum` or `maximum`
 * check collides with that range and goes into `allOf`. Providers would then receive the range and an
 * `allOf` in place of a plain bound. This function removes the range and merges each such check back
 * into the parent, the way Effect merges a check that does not collide. The result is the rc.117 shape.
 */
export const withoutSafeIntegerRange = (schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema => restoreObject(schema)

const restore = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(restore)
  if (!isRecord(value)) return value
  return restoreObject(value)
}

const restoreObject = (value: JsonObject): JsonObject => {
  const schema = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, DATA_KEYWORDS.includes(key) ? item : restore(item)]),
  )
  if (schema.type !== "integer") return schema

  if (schema.minimum === Number.MIN_SAFE_INTEGER && schema.maximum === Number.MAX_SAFE_INTEGER) {
    // Keep the key order: each check that Effect moved into `allOf` returns to the place of `allOf`.
    return Object.entries(schema).reduce<JsonObject>((out, [key, item]) => {
      if (key === "minimum" || key === "maximum") return out
      if (key === "allOf" && Array.isArray(item)) return item.reduce(mergeCheck, out)
      // A later key that a merged check already set collides, as it did on rc.117.
      return Object.hasOwn(out, key) ? mergeCheck(out, { [key]: item }) : { ...out, [key]: item }
    }, {})
  }

  // A `maximum` check before `Schema.isInt` puts the range itself into `allOf`.
  if (Array.isArray(schema.allOf) && schema.allOf.some(isSafeIntegerRange)) {
    const allOf = schema.allOf.filter((member) => !isSafeIntegerRange(member))
    if (allOf.length > 0) return { ...schema, allOf }
    const { allOf: _, ...rest } = schema
    return rest
  }

  return schema
}

const mergeCheck = (out: JsonObject, check: unknown): JsonObject =>
  isRecord(check) &&
  Object.keys(check).every((key) => MERGEABLE_CHECK_KEYWORDS.includes(key) && !Object.hasOwn(out, key))
    ? { ...out, ...check }
    : { ...out, allOf: [...(Array.isArray(out.allOf) ? out.allOf : []), check] }

const isSafeIntegerRange = (value: unknown): boolean =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  value.minimum === Number.MIN_SAFE_INTEGER &&
  value.maximum === Number.MAX_SAFE_INTEGER

export * as ProviderJsonSchema from "./provider-json-schema"
