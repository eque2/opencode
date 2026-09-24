import { Array as Arr, HashSet, Option, Predicate } from "effect"
import { fromSchemaOpenApi3_0, fromSchemaOpenApi3_1 } from "effect/JsonSchema"
import type { JsonSchema } from "../tool.js"
import { isBlockedMember } from "../tool-runtime.js"
import type {
  Body,
  Document,
  InputField,
  OperationInput,
  Parsed,
  SecurityRequirement,
  SecurityScheme,
} from "./types.js"

export const methods = HashSet.make("get", "put", "post", "delete", "options", "head", "patch", "trace")
const parameterLocations = ["path", "query", "header"] as const
const ignoredHeaderParameters = HashSet.make("accept", "content-type", "authorization")

export const isRecord = (value: unknown): value is Record<string, unknown> => Predicate.isObject(value)

const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

export const nonEmptyString = (value: unknown): Option.Option<string> =>
  typeof value === "string" && value !== "" ? Option.some(value) : Option.none()

// Guards record lookups keyed by spec- or model-controlled names against
// prototype-inherited values (e.g. a parameter named `toString`). An own
// property holding `undefined` counts as absent.
export const own = <T>(record: Readonly<Record<string, T>>, key: string): Option.Option<Exclude<T, undefined>> =>
  Object.hasOwn(record, key) ? Option.fromUndefinedOr(record[key]) : Option.none()

export const resolve = (document: Document, value: unknown): unknown => {
  const next = (current: unknown, seen: HashSet.HashSet<string>): unknown => {
    if (!isRecord(current)) return current
    const ref = Option.filter(nonEmptyString(current.$ref), (ref) => ref.startsWith("#/") && !HashSet.has(seen, ref))
    if (Option.isNone(ref)) return current
    const target = ref.value
      .slice(2)
      .split("/")
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce<Option.Option<unknown>>(
        (item, segment) => Option.flatMap(item, (node) => (isRecord(node) ? own(node, segment) : Option.none())),
        Option.some(document),
      )
    return Option.match(target, {
      onNone: () => current,
      onSome: (resolved) => next(resolved, HashSet.add(seen, ref.value)),
    })
  }
  return next(value, HashSet.empty())
}

const projectSchema = (document: Document, value: unknown): JsonSchema => {
  if (!isRecord(value)) return {}
  const normalized = Option.exists(nonEmptyString(document.openapi), (version) => version.startsWith("3.0"))
    ? fromSchemaOpenApi3_0(value)
    : fromSchemaOpenApi3_1(value)
  return Object.keys(normalized.definitions).length === 0
    ? normalized.schema
    : { ...normalized.schema, $defs: normalized.definitions }
}

export const componentDefinitions = (document: Document): Readonly<Record<string, JsonSchema>> => {
  const components = isRecord(document.components) ? document.components : {}
  const schemas = isRecord(components.schemas) ? components.schemas : {}
  return Object.fromEntries(Object.entries(schemas).map(([name, value]) => [name, projectSchema(document, value)]))
}

const withDefinitions = (schema: JsonSchema, definitions: Readonly<Record<string, JsonSchema>>): JsonSchema => {
  if (Object.keys(definitions).length === 0) return schema
  const local = isRecord(schema.$defs) ? schema.$defs : {}
  return { ...schema, $defs: { ...definitions, ...local } }
}

const isJsonMediaType = (mediaType: string): boolean => {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase() ?? ""
  return normalized === "application/json" || normalized.endsWith("+json")
}

const isBinaryMediaType = (document: Document, mediaType: string, value: unknown): boolean => {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase() ?? ""
  if (!isJsonMediaType(normalized) && !normalized.startsWith("text/")) return true
  if (!isRecord(value)) return false
  const schema = resolve(document, value.schema)
  return isRecord(schema) && schema.format === "binary"
}

const jsonContent = (
  content: Record<string, unknown>,
): Option.Option<{ readonly mediaType: string; readonly schema: unknown }> =>
  Arr.findFirst(Object.entries(content), ([mediaType]) => isJsonMediaType(mediaType)).pipe(
    Option.flatMap(([mediaType, value]) =>
      isRecord(value) ? Option.some({ mediaType, schema: value.schema }) : Option.none(),
    ),
  )

const isFlattenableObjectBody = (
  schema: unknown,
  requestRequired: boolean,
): schema is Record<string, unknown> & { readonly properties: Record<string, unknown> } =>
  isRecord(schema) &&
  requestRequired &&
  schema.type === "object" &&
  isRecord(schema.properties) &&
  schema.additionalProperties === false &&
  schema.nullable !== true &&
  schema.allOf === undefined &&
  schema.anyOf === undefined &&
  schema.oneOf === undefined

type PlannedField = Omit<InputField, "inputName">

type DeclaredParameter = {
  readonly name: string
  readonly location: string
  readonly parameter: Record<string, unknown>
}

const operationParameters = (
  document: Document,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): Parsed<ReadonlyArray<PlannedField>> => {
  // Operation-level parameters override path-level ones sharing (location, name)
  // and take the position of the declaration they replace.
  let declared: ReadonlyArray<DeclaredParameter> = []
  for (const raw of [...asArray(pathItem.parameters), ...asArray(operation.parameters)]) {
    const resolved = resolve(document, raw)
    if (!isRecord(resolved)) return { ok: false, reason: "parameter declaration is invalid or unresolved" }
    const name = nonEmptyString(resolved.name)
    const location = nonEmptyString(resolved.in)
    if (Option.isNone(name) || Option.isNone(location))
      return { ok: false, reason: "parameter declaration is missing name or location" }
    const entry: DeclaredParameter = { name: name.value, location: location.value, parameter: resolved }
    const index = declared.findIndex((item) => item.name === entry.name && item.location === entry.location)
    declared =
      index === -1 ? Arr.append(declared, entry) : declared.map((item, position) => (position === index ? entry : item))
  }
  const unordered: Array<PlannedField> = []
  for (const item of declared) {
    const name = item.name
    const location = item.location
    const resolved = item.parameter
    if (location === "cookie") return { ok: false, reason: `cookie parameter '${name}' is not supported` }
    if (location !== "path" && location !== "query" && location !== "header") {
      return { ok: false, reason: `parameter '${name}' uses unsupported location '${location}'` }
    }
    if (location === "header" && HashSet.has(ignoredHeaderParameters, name.toLowerCase())) continue
    if (resolved.schema === undefined && resolved.content === undefined) {
      return { ok: false, reason: `parameter '${name}' declares neither schema nor content` }
    }
    if (resolved.content !== undefined)
      return { ok: false, reason: `parameter '${name}' uses unsupported content encoding` }
    if (resolved.style !== undefined && Option.isNone(nonEmptyString(resolved.style))) {
      return { ok: false, reason: `parameter '${name}' has an invalid style` }
    }
    if (resolved.explode !== undefined && typeof resolved.explode !== "boolean") {
      return { ok: false, reason: `parameter '${name}' has an invalid explode value` }
    }
    if (resolved.allowReserved !== undefined && typeof resolved.allowReserved !== "boolean") {
      return { ok: false, reason: `parameter '${name}' has an invalid allowReserved value` }
    }
    if (resolved.allowReserved === true)
      return { ok: false, reason: `parameter '${name}' uses unsupported allowReserved encoding` }
    const declaredStyle = Option.getOrElse(nonEmptyString(resolved.style), () =>
      location === "query" ? "form" : "simple",
    )
    if (location === "query" && declaredStyle !== "form" && declaredStyle !== "deepObject") {
      return { ok: false, reason: `query parameter '${name}' uses unsupported style '${declaredStyle}'` }
    }
    if (location !== "query" && declaredStyle !== "simple") {
      return { ok: false, reason: `${location} parameter '${name}' uses unsupported style '${declaredStyle}'` }
    }
    const style = declaredStyle === "deepObject" ? "deepObject" : declaredStyle === "form" ? "form" : "simple"
    const explode = typeof resolved.explode === "boolean" ? resolved.explode : style === "form"
    if (style === "deepObject" && !explode) {
      return { ok: false, reason: `query parameter '${name}' uses deepObject with explode=false` }
    }
    const base = projectSchema(document, resolved.schema)
    // The parameter description fills in only when the schema has none.
    const description = base.description === undefined ? nonEmptyString(resolved.description) : Option.none()
    unordered.push({
      name,
      location,
      required: resolved.required === true || location === "path",
      style,
      explode,
      schema: Option.match(description, {
        onNone: () => base,
        onSome: (text) => ({ ...base, description: text }),
      }),
    })
  }
  return {
    ok: true,
    value: parameterLocations.flatMap((location) => unordered.filter((field) => field.location === location)),
  }
}

const operationBody = (
  document: Document,
  operation: Record<string, unknown>,
): Parsed<{ readonly fields: ReadonlyArray<PlannedField>; readonly body: Option.Option<Body> }> => {
  const resolved = resolve(document, operation.requestBody)
  if (!isRecord(resolved)) return { ok: true, value: { fields: [], body: Option.none() } }
  const content = isRecord(resolved.content) ? resolved.content : {}
  const json = jsonContent(content)
  if (Option.isNone(json)) {
    return {
      ok: false,
      reason: `request body has no JSON content (declared: ${Object.keys(content).join(", ") || "none"})`,
    }
  }
  const selected = json.value
  const schema = resolve(document, selected.schema)
  const required = resolved.required === true
  if (!isFlattenableObjectBody(schema, required)) {
    return {
      ok: true,
      value: {
        fields: [
          {
            name: "body",
            location: "body",
            required,
            schema: projectSchema(document, selected.schema),
          },
        ],
        body: Option.some({ required, mode: "value", mediaType: selected.mediaType }),
      },
    }
  }
  const requiredProperties = HashSet.fromIterable(
    Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [],
  )
  return {
    ok: true,
    value: {
      fields: Object.entries(schema.properties).map(([name, value]) => ({
        name,
        location: "body" as const,
        required: required && HashSet.has(requiredProperties, name),
        schema: projectSchema(document, value),
      })),
      body: Option.some({ required, mode: "object", mediaType: selected.mediaType }),
    },
  }
}

export const operationInput = (
  document: Document,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): Parsed<OperationInput> => {
  const parameters = operationParameters(document, pathItem, operation)
  if (!parameters.ok) return parameters
  const requestBody = operationBody(document, operation)
  if (!requestBody.ok) return requestBody
  const fields = [...parameters.value, ...requestBody.value.fields]

  // A name declared in more than one location is prefixed with its location.
  const conflicts = HashSet.fromIterable(
    fields
      .filter((field) => fields.some((other) => other.name === field.name && other.location !== field.location))
      .map((field) => field.name),
  )
  const named = fields.reduce<{ readonly used: HashSet.HashSet<string>; readonly fields: ReadonlyArray<InputField> }>(
    (state, field) => {
      const visibleName = isBlockedMember(field.name) ? `${field.name}_2` : field.name
      const base = HashSet.has(conflicts, field.name) ? `${field.location}_${visibleName}` : visibleName
      const next = (index: number): string => {
        const candidate = index === 1 ? base : `${base}_${index}`
        return HashSet.has(state.used, candidate) ? next(index + 1) : candidate
      }
      const inputName = next(1)
      return { used: HashSet.add(state.used, inputName), fields: Arr.append(state.fields, { ...field, inputName }) }
    },
    { used: HashSet.empty(), fields: [] },
  )
  return {
    ok: true,
    value: {
      fields: named.fields,
      body: requestBody.value.body,
    },
  }
}

export const inputSchema = (
  fields: ReadonlyArray<InputField>,
  definitions: Readonly<Record<string, JsonSchema>>,
): JsonSchema => {
  const required = fields.filter((field) => field.required).map((field) => field.inputName)
  return withDefinitions(
    {
      type: "object",
      properties: Object.fromEntries(fields.map((field) => [field.inputName, field.schema])),
      ...(required.length === 0 ? {} : { required }),
    },
    definitions,
  )
}

const successfulResponses = (
  document: Document,
  operation: Record<string, unknown>,
): Parsed<ReadonlyArray<Record<string, unknown>>> => {
  if (!isRecord(operation.responses)) return { ok: true, value: [] }
  const entries = Object.entries(operation.responses)
  const selected = [
    ...entries.filter(([status]) => /^2\d\d$/.test(status)).sort(([a], [b]) => a.localeCompare(b)),
    ...entries.filter(([status]) => status.toUpperCase() === "2XX"),
  ]
  const resolved = selected.map(([, value]) => resolve(document, value))
  const responses = resolved.filter(
    (response): response is Record<string, unknown> =>
      isRecord(response) && Option.isNone(nonEmptyString(response.$ref)),
  )
  if (responses.length !== resolved.length) {
    return { ok: false, reason: "successful response declaration is invalid or unresolved" }
  }
  return { ok: true, value: responses }
}

export const operationOutput = (
  document: Document,
  operation: Record<string, unknown>,
  definitions: Readonly<Record<string, JsonSchema>>,
): Parsed<Option.Option<JsonSchema>> => {
  if (operation["x-websocket"] === true) return { ok: false, reason: "WebSocket operations are not supported" }
  const responses = successfulResponses(document, operation)
  if (!responses.ok) return responses
  const streams = responses.value.some(
    (response) =>
      isRecord(response.content) &&
      Object.keys(response.content).some(
        (mediaType) => mediaType.split(";")[0]?.trim().toLowerCase() === "text/event-stream",
      ),
  )
  if (streams) return { ok: false, reason: "SSE operations are not supported" }
  const binary = responses.value.some(
    (response) =>
      isRecord(response.content) &&
      Object.entries(response.content).some(([mediaType, value]) => isBinaryMediaType(document, mediaType, value)),
  )
  if (binary) return { ok: false, reason: "binary responses are not supported" }

  // One success response without a usable schema makes the whole output unknown.
  const outcomes = Option.all(
    responses.value.map((response): Option.Option<ReadonlyArray<JsonSchema>> => {
      if (response.content !== undefined && !isRecord(response.content)) return Option.none()
      const content = isRecord(response.content) ? response.content : {}
      if (Object.keys(content).length === 0) return Option.some([{ type: "null" }])
      return Option.all(
        Object.entries(content).map(([mediaType, value]): Option.Option<JsonSchema> => {
          if (!isJsonMediaType(mediaType)) return Option.some({ type: "string" })
          return isRecord(value) && value.schema !== undefined
            ? Option.some(projectSchema(document, value.schema))
            : Option.none()
        }),
      )
    }),
  ).pipe(
    Option.map((groups) => groups.flat()),
    Option.filter((schemas) => schemas.length > 0),
  )
  return {
    ok: true,
    value: Option.map(outcomes, (schemas) =>
      withDefinitions(schemas.length === 1 ? (schemas[0] ?? {}) : { anyOf: schemas }, definitions),
    ),
  }
}

const sanitizeOperationSegment = (raw: string): string => {
  const base =
    raw
      .replaceAll(/[^A-Za-z0-9_$]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^([0-9])/, "_$1") || "operation"
  return isBlockedMember(base) ? `${base}_2` : base
}

const fallbackOperationId = (method: string, path: string): string =>
  [
    method,
    ...path
      .split("/")
      .filter((part) => part !== "")
      .flatMap((part) => (part.startsWith("{") && part.endsWith("}") ? ["by", part.slice(1, -1)] : [part]))
      .flatMap((part) => part.split(/[^A-Za-z0-9]+/).filter((word) => word !== "")),
  ]
    .map((word, index) => {
      const lower = word.toLowerCase()
      return index === 0 ? lower : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`
    })
    .join("")

export const operationPath = (
  method: string,
  path: string,
  operation: Record<string, unknown>,
  used: HashSet.HashSet<string>,
  namespaces: HashSet.HashSet<string>,
): ReadonlyArray<string> => {
  const segments = Option.match(nonEmptyString(operation.operationId), {
    onNone: () => [fallbackOperationId(method, path)],
    onSome: (raw) => raw.split("."),
  }).map(sanitizeOperationSegment)
  if (isOperationPathAvailable(segments, used, namespaces)) return segments
  const conflict = segments
    .slice(0, -1)
    .findIndex((_, index) => HashSet.has(used, segments.slice(0, index + 1).join(".")))
  if (conflict >= 0 && conflict + 1 < segments.length) {
    const collapsed = segments.flatMap((segment, index) => {
      if (index === conflict) {
        const next = segments[index + 1] ?? ""
        return [`${segment}${next.charAt(0).toUpperCase()}${next.slice(1)}`]
      }
      return index === conflict + 1 ? [] : [segment]
    })
    if (isOperationPathAvailable(collapsed, used, namespaces)) return collapsed
  }
  const fallback = segments.join("_")
  const next = (index: number): string => {
    const candidate = `${fallback}_${index}`
    return isOperationPathAvailable([candidate], used, namespaces) ? candidate : next(index + 1)
  }
  return [next(2)]
}

const isOperationPathAvailable = (
  segments: ReadonlyArray<string>,
  used: HashSet.HashSet<string>,
  namespaces: HashSet.HashSet<string>,
): boolean => {
  const key = segments.join(".")
  if (HashSet.has(used, key) || HashSet.has(namespaces, key)) return false
  return segments.slice(0, -1).every((_, index) => !HashSet.has(used, segments.slice(0, index + 1).join(".")))
}

export const specServerUrl = (source: Record<string, unknown>): Parsed<string> => {
  const url = Arr.findFirst(asArray(source.servers), isRecord).pipe(
    Option.flatMap((server) => nonEmptyString(server.url)),
  )
  if (Option.isNone(url)) return { ok: false, reason: "spec declares no servers; pass baseUrl" }
  if (/\{[^{}]+\}/.test(url.value)) {
    return { ok: false, reason: `server URL '${url.value}' is not an absolute URL; pass baseUrl` }
  }
  return validateBaseUrl(url.value)
}

export const validateBaseUrl = (value: string): Parsed<string> => {
  if (!/^https?:\/\//i.test(value)) return { ok: false, reason: `server URL '${value}' is not an absolute HTTP(S) URL` }
  const url = URL.parse(value)
  if (Predicate.isNull(url) || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return { ok: false, reason: `server URL '${value}' is not an absolute HTTP(S) URL` }
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, reason: `server URL '${value}' contains an unsupported query string or fragment` }
  }
  return { ok: true, value }
}

const scopeList = (scopes: unknown): Option.Option<ReadonlyArray<string>> => {
  if (!Array.isArray(scopes)) return Option.none()
  const parsed = scopes.filter(Predicate.isString)
  return parsed.length === scopes.length ? Option.some(parsed) : Option.none()
}

export const securityRequirements = (value: unknown): Parsed<ReadonlyArray<SecurityRequirement>> => {
  if (value === undefined) return { ok: true, value: [] }
  if (!Array.isArray(value)) return { ok: false, reason: "security declaration is not an array" }
  let requirements: ReadonlyArray<SecurityRequirement> = []
  for (const item of value) {
    if (!isRecord(item)) return { ok: false, reason: "security requirement is not an object" }
    const scopes = Option.all(
      Object.entries(item).map(([name, declared]) => Option.map(scopeList(declared), (parsed) => [name, parsed] as const)),
    )
    if (Option.isNone(scopes)) return { ok: false, reason: "security requirement scopes are not string arrays" }
    // Object.fromEntries defines own data properties, so a scheme named `__proto__` stays a plain key.
    requirements = Arr.append(requirements, Object.fromEntries(scopes.value))
  }
  return { ok: true, value: requirements }
}

export const operationSecurityRequirements = (
  value: unknown,
  defaults: Parsed<ReadonlyArray<SecurityRequirement>>,
  schemes: Readonly<Record<string, SecurityScheme>>,
): Parsed<ReadonlyArray<SecurityRequirement>> => {
  const parsed = value === undefined ? defaults : securityRequirements(value)
  if (!parsed.ok) return parsed
  const isCookieScheme = (scheme: SecurityScheme): boolean => scheme.type === "apiKey" && scheme.in === "cookie"
  const supported = parsed.value.filter((requirement) =>
    Object.keys(requirement).every((name) => Option.exists(own(schemes, name), (scheme) => !isCookieScheme(scheme))),
  )
  if (parsed.value.length === 0 || supported.length > 0) return { ok: true, value: supported }

  const names = Arr.dedupe(parsed.value.flatMap((requirement) => Object.keys(requirement)))
  const cookieScheme = Arr.findFirst(names, (name) => Option.exists(own(schemes, name), isCookieScheme))
  return {
    ok: false,
    reason: Option.match(cookieScheme, {
      onNone: () => `security requirement references missing or malformed scheme: ${names.join(", ")}`,
      onSome: (name) => `cookie authentication '${name}' is not supported`,
    }),
  }
}

export const securitySchemes = (document: Document): Readonly<Record<string, SecurityScheme>> => {
  const components = isRecord(document.components) ? document.components : {}
  const declared = isRecord(components.securitySchemes) ? components.securitySchemes : {}
  return Object.fromEntries(
    Object.entries(declared).flatMap<readonly [string, SecurityScheme]>(([name, value]) => {
      const resolved = resolve(document, value)
      if (!isRecord(resolved)) return []
      const type = resolved.type
      if (type === "apiKey") {
        const carrier = resolved.in
        const parameter = nonEmptyString(resolved.name)
        if (Option.isNone(parameter) || (carrier !== "header" && carrier !== "query" && carrier !== "cookie")) return []
        return [[name, { type, name: parameter.value, in: carrier }] as const]
      }
      if (type === "http") {
        return Option.match(nonEmptyString(resolved.scheme), {
          onNone: () => [],
          onSome: (scheme) => [[name, { type, scheme: scheme.toLowerCase() }] as const],
        })
      }
      if (type === "oauth2" || type === "openIdConnect") return [[name, { type }] as const]
      return []
    }),
  )
}
