import { HashSet, JsonPointer, Option, Predicate, Result, Schema, Struct } from "effect"
import type { Definition, JsonSchema, SchemaType } from "./tool.js"

const isEffectSchema = (schema: SchemaType): schema is Schema.Decoder<unknown> & Schema.Top => Schema.isSchema(schema)

/** Encodes a string as a JSON string literal (quoted and escaped). */
export const quoteJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String))

/** Encodes a JSON value as JSON text; fails for a value that is not JSON data. */
const encodeJson = Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Json))

const renderLiteral = (value: unknown): string => Result.getOrElse(encodeJson(value), () => "unknown")

/**
 * Bare TypeScript identifier - usable unquoted as an object key (and, in the tool runtime,
 * with dot access as a tool-path segment). Anything else must be quoted/bracketed.
 */
export const identifierSegment = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Renders a property name as a valid TS object key: bare when an identifier, quoted otherwise. */
const renderKey = (name: string): string => (identifierSegment.test(name) ? name : quoteJsonString(name))

const effectNumberSentinel = (schema: JsonSchema) =>
  schema.type === "string" &&
  Array.isArray(schema.enum) &&
  schema.enum.length === 1 &&
  (schema.enum[0] === "NaN" || schema.enum[0] === "Infinity" || schema.enum[0] === "-Infinity")

/** The definition name that a local `#/$defs/<name>` or `#/definitions/<name>` reference targets. */
const refName = (ref: string): Option.Option<string> =>
  Option.map(Option.fromNullishOr(ref.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)?.[1]), JsonPointer.unescapeToken)

const intersection = (members: ReadonlyArray<string>): string => {
  const concrete = members.filter((member) => member !== "unknown")
  if (concrete.length === 0) return "unknown"
  if (concrete.length === 1) return concrete[0] ?? "unknown"
  return concrete.map((member) => (member.includes(" | ") ? `(${member})` : member)).join(" & ")
}

/**
 * Recursion ceiling for schema rendering. Object, array, and union recursion all increment
 * depth, so this bounds every recursion path - pathological or structurally cyclic schemas
 * degrade to `unknown` instead of overflowing the stack (rendering must never throw).
 */
const MAX_RENDER_DEPTH = 8

type RenderContext = {
  readonly definitions: Readonly<Record<string, JsonSchema>>
  /** Indented, JSDoc-annotated multiline rendering (search results); compact single line otherwise. */
  readonly pretty: boolean
}

const hasUnresolvedRef = (
  schema: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
  seen: HashSet.HashSet<string> = HashSet.empty(),
  /**
   * The schema objects on the current path, compared by identity: a structurally equal
   * schema reached again through a `$ref` is a new visit, so the `seen` names catch the cycle.
   */
  visited: ReadonlyArray<JsonSchema> = [],
): boolean => {
  if (visited.includes(schema)) return false
  const nextVisited = [...visited, schema]
  if (schema.$ref !== undefined) {
    const name = refName(schema.$ref)
    if (Option.isNone(name) || definitions[name.value] === undefined || HashSet.has(seen, name.value)) return true
    if (hasUnresolvedRef(definitions[name.value], definitions, HashSet.add(seen, name.value), nextVisited)) return true
  }
  return [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
    ...Object.values(schema.properties ?? {}),
    ...(schema.items === undefined ? [] : [schema.items]),
    ...(typeof schema.additionalProperties === "object" ? [schema.additionalProperties] : []),
  ].some((item) => hasUnresolvedRef(item, definitions, seen, nextVisited))
}

/**
 * Schema constraints a TypeScript type cannot express natively but a model benefits from,
 * surfaced as JSDoc tags (`@deprecated`, `@default`, `@format`, `@minItems`, `@maxItems`).
 */
const docTags = (schema: JsonSchema): Array<string> => {
  const tags: Array<string> = []
  if (schema.deprecated === true) tags.push("@deprecated")
  if (schema.default !== undefined) {
    // An unserializable default is skipped rather than emitted as a broken tag.
    const rendered = encodeJson(schema.default)
    if (Result.isSuccess(rendered)) tags.push(`@default ${rendered.success}`)
  }
  if (typeof schema.format === "string") tags.push(`@format ${schema.format}`)
  if (typeof schema.minItems === "number") tags.push(`@minItems ${schema.minItems}`)
  if (typeof schema.maxItems === "number") tags.push(`@maxItems ${schema.maxItems}`)
  return tags
}

/**
 * Format a schema `description` plus `tags` as a JSDoc comment at the given indent,
 * preserving multi-line text (a single line stays `/** ... *\/`; multiple lines become a
 * `*`-prefixed block). `*\/` is neutralized so nothing can close the comment early, and
 * blank leading/trailing lines are trimmed. Returns "" (else a trailing newline) so
 * callers can prepend it directly to the field line.
 */
const jsdoc = (description: string | undefined, tags: ReadonlyArray<string>, pad: string): string => {
  const lines = [...(description === undefined ? [] : description.split("\n")), ...tags].map((line) =>
    line.replaceAll("*/", "* /").replace(/\s+$/, ""),
  )
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift()
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop()
  if (lines.length === 0) return ""
  if (lines.length === 1) return `${pad}/** ${lines[0]} */\n`
  const body = lines.map((line) => `${pad} *${line === "" ? "" : ` ${line}`}`).join("\n")
  return `${pad}/**\n${body}\n${pad} */\n`
}

const renderSchema = (
  schema: JsonSchema,
  ctx: RenderContext,
  depth = 0,
  seen: HashSet.HashSet<string> = HashSet.empty(),
): string => {
  if (depth > MAX_RENDER_DEPTH) return "unknown"
  const nested =
    schema.definitions === undefined && schema.$defs === undefined
      ? ctx
      : { ...ctx, definitions: { ...ctx.definitions, ...(schema.definitions ?? {}), ...(schema.$defs ?? {}) } }
  if (schema.$ref) {
    const name = refName(schema.$ref)
    if (Option.isNone(name) || !nested.definitions[name.value] || HashSet.has(seen, name.value)) return "unknown"
    return intersection([
      renderSchema(nested.definitions[name.value], nested, depth, HashSet.add(seen, name.value)),
      renderSchema(Struct.omit(schema, ["$ref"]), nested, depth + 1, seen),
    ])
  }
  if (schema.const !== undefined) return renderLiteral(schema.const)
  if (schema.enum) return schema.enum.map(renderLiteral).join(" | ")
  const alternatives = schema.anyOf ?? schema.oneOf
  if (alternatives) {
    // Effect's number schema emits `anyOf: [{ type: "number" }, { const: "NaN" },
    // { const: "Infinity" }, { const: "-Infinity" }]`. Collapse only that artifact;
    // real JSON Schema unions such as `string | number` or `number | null` must keep
    // every branch.
    if (
      alternatives.some((item) => item.type === "number") &&
      alternatives.every((item) => item.type === "number" || effectNumberSentinel(item))
    )
      return "number"
    // An empty Schema.Struct({}) emits `anyOf: [{ type: "object" }, { type: "array" }]`
    // (no properties/items); render the bare shape as {} instead of `{} | Array<unknown>`.
    if (
      alternatives.length === 2 &&
      alternatives[0]?.type === "object" &&
      alternatives[0].properties === undefined &&
      alternatives[1]?.type === "array" &&
      alternatives[1].items === undefined
    ) {
      return "{}"
    }
    const members = alternatives.map((item) => renderSchema(item, nested, depth + 1, seen))
    if (members.some((member) => member === "unknown")) return "unknown"
    return intersection([
      members.join(" | "),
      renderSchema(Struct.omit(schema, ["anyOf", "oneOf"]), nested, depth + 1, seen),
    ])
  }
  if (schema.allOf) {
    const members = schema.allOf.map((item) => renderSchema(item, nested, depth + 1, seen))
    if (schema.allOf.some((item) => hasUnresolvedRef(item, nested.definitions))) return "unknown"
    return intersection([renderSchema(Struct.omit(schema, ["allOf"]), nested, depth + 1, seen), ...members])
  }
  if (Array.isArray(schema.type)) {
    return schema.type.map((item) => renderSchema({ ...schema, type: item }, nested, depth + 1, seen)).join(" | ")
  }
  if (schema.type === "string") return "string"
  if (schema.type === "number" || schema.type === "integer") return "number"
  if (schema.type === "boolean") return "boolean"
  if (schema.type === "null") return "null"
  if (schema.type === "array") return `Array<${renderSchema(schema.items ?? {}, nested, depth + 1, seen)}>`
  if (schema.type === "object" || schema.properties) {
    const required = HashSet.fromIterable(schema.required ?? [])
    const properties = Object.entries(schema.properties ?? {})
    const additional = schema.additionalProperties
    const indexType = Predicate.isObjectOrArray(additional)
      ? Option.some(renderSchema(additional, nested, depth + 1, seen))
      : Option.none()
    const field = ([name, value]: readonly [string, JsonSchema]) =>
      `${renderKey(name)}${HashSet.has(required, name) ? "" : "?"}: ${renderSchema(value, nested, depth + 1, seen)}`

    if (!ctx.pretty) {
      const fields = properties.map(field)
      if (Option.isSome(indexType)) fields.push(`[key: string]: ${indexType.value}`)
      return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`
    }

    // Pretty: an indented block, each described field preceded by its JSDoc comment.
    if (properties.length === 0 && Option.isNone(indexType)) return "{}"
    const pad = "  ".repeat(depth + 1)
    const lines = properties.map(
      (entry) => `${jsdoc(entry[1].description, docTags(entry[1]), pad)}${pad}${field(entry)},`,
    )
    if (Option.isSome(indexType)) lines.push(`${pad}[key: string]: ${indexType.value},`)
    return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`
  }
  return "unknown"
}

export const toTypeScript = (schema: Schema.Top, decoded = false, pretty = false): string => {
  try {
    const visible = decoded ? Schema.toType(schema) : schema
    const document = Schema.toJsonSchemaDocument(visible) as {
      readonly schema: JsonSchema
      readonly definitions?: Readonly<Record<string, JsonSchema>>
    }
    return renderSchema(document.schema, { definitions: document.definitions ?? {}, pretty })
  } catch {
    return "unknown"
  }
}

/** Renders a raw JSON Schema document as a TypeScript type string. */
export const jsonSchemaToTypeScript = (schema: JsonSchema, pretty = false): string => {
  try {
    return renderSchema(schema, { definitions: { ...(schema.definitions ?? {}), ...(schema.$defs ?? {}) }, pretty })
  } catch {
    return "unknown"
  }
}

/** One input property of a tool, extracted best-effort from its input schema. */
export type InputProperty = {
  readonly name: string
  readonly description: string | undefined
  readonly required: boolean
}

/**
 * The property names, descriptions, and required flags of a tool's input schema - the raw
 * material for search text. Best-effort: Effect Schemas go through their
 * JSON Schema document (the same emission signature rendering uses); JSON Schemas are read
 * directly, resolving a trivial top-level `$ref` into `$defs`/`definitions` when present.
 * Anything unresolvable yields `[]` (search falls back to path + description).
 */
export const inputProperties = <R>(definition: Definition<R>): Array<InputProperty> => {
  try {
    const document = isEffectSchema(definition.input)
      ? (Schema.toJsonSchemaDocument(definition.input) as {
          readonly schema: JsonSchema
          readonly definitions?: Readonly<Record<string, JsonSchema>>
        })
      : {
          schema: definition.input,
          definitions: { ...(definition.input.definitions ?? {}), ...(definition.input.$defs ?? {}) },
        }
    const definitions = document.definitions ?? {}
    const resolved =
      document.schema.$ref === undefined
        ? Option.some(document.schema)
        : Option.flatMap(refName(document.schema.$ref), (name) => Option.fromNullishOr(definitions[name]))
    if (Option.isNone(resolved)) return []
    const schema = resolved.value
    const required = HashSet.fromIterable(schema.required ?? [])
    return Object.entries(schema.properties ?? {}).map(([name, value]) => ({
      name,
      description: Option.getOrUndefined(Option.liftPredicate(value.description, Predicate.isString)),
      required: HashSet.has(required, name),
    }))
  } catch {
    return []
  }
}

/**
 * The model-visible TypeScript type of a tool's input. `pretty` renders an indented
 * multiline block with schema descriptions and constraints as JSDoc comments on the
 * fields; the default stays the compact single-line form.
 */
export const inputTypeScript = <R>(definition: Definition<R>, pretty = false): string =>
  isEffectSchema(definition.input)
    ? toTypeScript(definition.input, false, pretty)
    : jsonSchemaToTypeScript(definition.input, pretty)

/**
 * The model-visible TypeScript type of a tool's result; tools without an output schema
 * return `unknown`. `pretty` renders the JSDoc-annotated multiline form, as for inputs.
 */
export const outputTypeScript = <R>(definition: Definition<R>, pretty = false): string =>
  definition.output === undefined
    ? "unknown"
    : isEffectSchema(definition.output)
      ? toTypeScript(definition.output, true, pretty)
      : jsonSchemaToTypeScript(definition.output, pretty)

/**
 * Decodes tool input before `run` is invoked. Effect Schemas validate (throwing on failure);
 * JSON-Schema-described inputs pass through unvalidated (render-only).
 */
export const decodeInput = <R>(definition: Definition<R>, value: unknown): unknown =>
  isEffectSchema(definition.input) ? Schema.decodeUnknownSync(definition.input)(value) : value

/**
 * Decodes a tool result before it is exposed to the program. Effect Schemas validate and
 * transform (throwing on failure); JSON Schema outputs and tools without an output schema pass
 * the host value through unchanged.
 */
export const decodeOutput = <R>(definition: Definition<R>, value: unknown): unknown =>
  definition.output !== undefined && isEffectSchema(definition.output)
    ? Schema.decodeUnknownSync(definition.output)(value)
    : value
