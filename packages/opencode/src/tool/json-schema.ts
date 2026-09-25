import type { JSONSchema7 } from "@ai-sdk/provider"
import { JsonSchema, Option, Schema } from "effect"
import type * as Tool from "./tool"

type JsonObject = Record<string, unknown>
const cache = new WeakMap<Schema.Top, JSONSchema7>()

export function fromSchema(schema: Schema.Top): JSONSchema7 {
  const cached = cache.get(schema)
  if (cached) return cached

  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "ignore" })
  // The document is an object, and each step below maps an object to an object, so the
  // result is always a JSON Schema object.
  const result = normalizeObject({
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  })
  const inlined = dropDefinitionsIfResolved(inlineObjectReferences(result))
  cache.set(schema, inlined)
  return inlined
}

export function fromTool(tool: Tool.Def): JSONSchema7 {
  return tool.jsonSchema ?? fromSchema(tool.parameters as Schema.Top)
}

function normalize(value: unknown, options: { stripNull?: boolean } = {}): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item))
  if (!isRecord(value)) return value
  return normalizeObject(value, options)
}

function normalizeObject(value: JsonObject, options: { stripNull?: boolean } = {}): JsonObject {
  const required = Array.isArray(value.required)
    ? new Set(value.required.filter((item) => typeof item === "string"))
    : undefined
  const schema = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "properties" && isRecord(item)
        ? Object.fromEntries(
            Object.entries(item).map(([name, property]) => [
              name,
              normalize(property, { stripNull: !required?.has(name) }),
            ]),
          )
        : normalize(item),
    ]),
  )

  if (schema.additionalProperties === true) delete schema.additionalProperties

  if (options.stripNull && Array.isArray(schema.anyOf)) {
    const withoutNull = schema.anyOf.filter((item) => !isRecord(item) || item.type !== "null")
    if (withoutNull.length !== schema.anyOf.length) return normalizeObject({ ...schema, anyOf: withoutNull })
  }

  if (Array.isArray(schema.anyOf)) {
    const withoutNull = schema.anyOf
    const number = withoutNull.find((item) => isRecord(item) && item.type === "number")
    const nonFinite = withoutNull.filter(
      (item) => isRecord(item) && Array.isArray(item.enum) && item.enum.every((entry) => isNonFiniteNumber(entry)),
    )
    if (number && nonFinite.length === withoutNull.length - 1) {
      const { anyOf: _, ...rest } = schema
      return normalizeObject({ ...number, ...rest })
    }

    if (isEmptyStructUnion(withoutNull)) {
      const { anyOf: _, ...rest } = schema
      return normalizeObject({ type: "object", properties: {}, ...rest })
    }

    if (withoutNull.length === 1 && isRecord(withoutNull[0])) {
      const { anyOf: _, ...rest } = schema
      return normalizeObject({ ...withoutNull[0], ...rest })
    }
  }

  if (Array.isArray(schema.allOf) && schema.allOf.every(isRecord) && canFlattenAllOf(schema.allOf, schema)) {
    const { allOf, ...rest } = schema
    return normalizeObject({ ...Object.assign({}, ...allOf), ...rest })
  }

  if (schema.type === "integer" && schema.maximum === undefined) {
    return { minimum: Number.MIN_SAFE_INTEGER, ...schema, maximum: Number.MAX_SAFE_INTEGER }
  }

  return schema
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonFiniteNumber(value: unknown) {
  return value === "NaN" || value === "Infinity" || value === "-Infinity"
}

function isEmptyStructUnion(items: unknown[]) {
  return (
    items.length === 2 &&
    items.some((item) => isRecord(item) && item.type === "object" && item.properties === undefined) &&
    items.some((item) => isRecord(item) && item.type === "array" && item.items === undefined)
  )
}

function canFlattenAllOf(allOf: JsonObject[], parent: JsonObject) {
  const keys = new Set(Object.keys(parent).filter((key) => key !== "allOf"))
  return allOf.every((item) =>
    Object.keys(item).every((key) => {
      if (keys.has(key)) return false
      keys.add(key)
      return true
    }),
  )
}

function inlineLocalReferences(value: unknown, definitions: Option.Option<JsonObject>, seen: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => inlineLocalReferences(item, definitions, seen))
  if (!isRecord(value)) return value
  return inlineObjectReferences(value, definitions, seen)
}

function inlineObjectReferences(
  value: JsonObject,
  definitions: Option.Option<JsonObject> = Option.none(),
  seen = new Set<string>(),
): JsonObject {
  // The root object's $defs apply to every nested reference.
  const localDefinitions = Option.orElse(definitions, () => Option.liftPredicate(isRecord)(value.$defs))
  if (typeof value.$ref === "string" && Option.isSome(localDefinitions)) {
    const name = value.$ref.match(/^#\/\$defs\/(.+)$/)?.[1] ?? value.$ref.match(/^#\/definitions\/(.+)$/)?.[1]
    if (name && !seen.has(name)) {
      const target = localDefinitions.value[name]
      if (target) {
        const { $ref: _, ...rest } = value
        return inlineObjectReferences(
          { ...(isRecord(target) ? target : {}), ...rest },
          localDefinitions,
          new Set(seen).add(name),
        )
      }
    }
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, inlineLocalReferences(item, localDefinitions, seen)]),
  )
}

function dropDefinitionsIfResolved(value: JsonObject): JsonObject {
  if (hasLocalReference(value)) return value
  const { $defs: _, definitions: __, ...rest } = value
  return rest
}

function hasLocalReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasLocalReference)
  if (!isRecord(value)) return false
  if (
    typeof value.$ref === "string" &&
    (value.$ref.startsWith("#/$defs/") || value.$ref.startsWith("#/definitions/"))
  ) {
    return true
  }
  return Object.values(value).some(hasLocalReference)
}

export * as ToolJsonSchema from "./json-schema"
