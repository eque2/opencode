import { Array as Arr, Effect, Option, Predicate, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, type HttpMethod } from "effect/unstable/http"
import { ToolError, toolError } from "../tool-error.js"
import { isRecord, own } from "./spec.js"
import type { AppliedAuth, Credential, Plan, SecurityScheme } from "./types.js"

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Json))
const maxErrorBodyChars = 1_024
const maxResponseBodyBytes = 50 * 1024 * 1024

export const invoke = (plan: Plan, input: unknown): Effect.Effect<unknown, unknown, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const value = isRecord(input) ? input : {}

    let request = yield* buildRequest(plan, value)

    const auth = yield* resolveAuth(plan)
    for (const [name, item] of Object.entries(auth.query)) {
      request = HttpClientRequest.setUrlParam(request, name, item)
    }
    request = HttpClientRequest.setHeaders(request, auth.headers)

    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(request)
      .pipe(
        Effect.catch((cause) =>
          Effect.fail(toolError(`${plan.operation.method} ${plan.operation.path} failed: transport error`, cause)),
        ),
      )
    const text = yield* readResponseBody(response, plan)
    const mediaType = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase()
    const json = mediaType === "application/json" || mediaType?.endsWith("+json") === true
    // An empty body is absent; the program receives it as JSON null.
    const body: Option.Option<unknown> = text === "" ? Option.none() : json ? decodeJson(text) : Option.some(text)
    if (response.status < 200 || response.status >= 300) {
      const rendered = Option.match(body, {
        onNone: () => text,
        onSome: (value) => (typeof value === "string" ? value : Option.getOrElse(encodeJson(value), () => text)),
      })
      const summary =
        rendered === "" || rendered === "null"
          ? "no response body"
          : rendered.length > maxErrorBodyChars
            ? `${rendered.slice(0, maxErrorBodyChars)}...`
            : rendered
      return yield* Effect.fail(
        toolError(`${plan.operation.method} ${plan.operation.path} failed with HTTP ${response.status}: ${summary}`),
      )
    }
    if (json && text !== "" && Option.isNone(body)) {
      return yield* Effect.fail(toolError(`${plan.operation.method} ${plan.operation.path} returned malformed JSON.`))
    }
    return Option.getOrNull(body)
  })

const buildRequest = (
  plan: Plan,
  input: Readonly<Record<string, unknown>>,
): Effect.Effect<HttpClientRequest.HttpClientRequest, ToolError> =>
  Effect.gen(function* () {
    // Validate every model-controlled value before auth resolution, which may refresh tokens.
    const url = buildUrl(plan, input)
    if (url instanceof ToolError) return yield* Effect.fail(url)
    const missing = plan.fields.find(
      (field) => field.required && field.location !== "path" && own(input, field.inputName) === undefined,
    )
    if (missing !== undefined) {
      const label = missing.location === "body" ? "body field" : `${missing.location} parameter`
      return yield* Effect.fail(toolError(`Missing required ${label} '${missing.inputName}'.`))
    }

    let request = HttpClientRequest.make(plan.operation.method as HttpMethod.HttpMethod)(url)
    for (const field of plan.fields) {
      if (field.location !== "query") continue
      const item = own(input, field.inputName)
      if (item === undefined) continue
      const serialized = serializeQuery(request, field, item)
      if (serialized instanceof ToolError) return yield* Effect.fail(serialized)
      request = serialized
    }

    // Host headers first, then declared header parameters.
    request = HttpClientRequest.setHeaders(request, plan.headers)
    for (const field of plan.fields) {
      if (field.location !== "header") continue
      const item = own(input, field.inputName)
      if (item === undefined) continue
      const serialized = serializeSimple(field, item, String)
      if (serialized instanceof ToolError) return yield* Effect.fail(serialized)
      request = HttpClientRequest.setHeader(request, field.name, serialized)
    }

    const setBody = (value: unknown, mediaType: string) =>
      HttpClientRequest.bodyJson(request, value).pipe(
        Effect.map((next) => HttpClientRequest.setHeader(next, "content-type", mediaType)),
        Effect.mapError((cause) =>
          toolError(`Invalid JSON body for ${plan.operation.method} ${plan.operation.path}.`, cause),
        ),
      )
    if (plan.body?.mode === "value") {
      const field = plan.fields.find((field) => field.location === "body")
      const body = field === undefined ? undefined : own(input, field.inputName)
      if (body !== undefined) request = yield* setBody(body, plan.body.mediaType)
    }
    if (plan.body?.mode === "object") {
      const entries = plan.fields.flatMap((field) => {
        if (field.location !== "body") return []
        const item = own(input, field.inputName)
        return item === undefined ? [] : [[field.name, item] as const]
      })
      if (plan.body.required || entries.length > 0) {
        request = yield* setBody(Object.fromEntries(entries), plan.body.mediaType)
      }
    }
    return request
  })

const resolveAuth = (plan: Plan): Effect.Effect<AppliedAuth, unknown> =>
  Effect.gen(function* () {
    const none: AppliedAuth = { headers: {}, query: {} }
    if (plan.security.length === 0) return none

    const unavailable: Array<string> = []
    alternatives: for (const requirement of plan.security) {
      const names = Object.keys(requirement)
      if (names.length === 0) return none
      const credentials: Array<readonly [string, SecurityScheme, Credential]> = []
      for (const name of names) {
        const scheme = own(plan.schemes, name)
        if (scheme === undefined || plan.auth === undefined) {
          unavailable.push(name)
          continue alternatives
        }
        const credential = yield* plan.auth.resolve({
          name,
          definition: scheme,
          scopes: requirement[name] ?? [],
          operation: plan.operation,
        })
        if (credential === undefined) {
          unavailable.push(name)
          continue alternatives
        }
        credentials.push([name, scheme, credential])
      }
      const applied = applyCredentials(credentials)
      return applied instanceof ToolError ? yield* Effect.fail(applied) : applied
    }

    return yield* Effect.fail(
      toolError(
        `${plan.operation.method} ${plan.operation.path} requires authentication; no credential available for: ${Arr.dedupe(unavailable).join(", ")}.`,
      ),
    )
  })

/** Credential carriers in resolution order; request header and query order follow it. */
type Carriers = {
  readonly header: ReadonlyArray<readonly [string, string]>
  readonly query: ReadonlyArray<readonly [string, string]>
}

const addCarrier = (
  carriers: Carriers,
  carrier: "header" | "query",
  name: string,
  value: string,
): Carriers | ToolError => {
  if (carriers[carrier].some(([existing]) => existing === name)) {
    return toolError(`Authentication resolves multiple credentials for ${carrier} '${name}'.`)
  }
  const entry = [name, value] as const
  return carrier === "header"
    ? { ...carriers, header: Arr.append(carriers.header, entry) }
    : { ...carriers, query: Arr.append(carriers.query, entry) }
}

const applyCredential = (
  carriers: Carriers,
  [name, definition, credential]: readonly [string, SecurityScheme, Credential],
): Carriers | ToolError => {
  if (credential.type === "bearer") return addCarrier(carriers, "header", "authorization", `Bearer ${credential.token}`)
  if (credential.type === "basic") {
    // Buffer instead of btoa: btoa throws on non-Latin-1 credentials.
    return addCarrier(
      carriers,
      "header",
      "authorization",
      `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`,
    )
  }
  if (credential.type === "header") {
    return addCarrier(carriers, "header", credential.name.toLowerCase(), credential.value)
  }
  // apiKey: the carrier comes from the scheme declaration.
  if (definition.type !== "apiKey") {
    return toolError(
      `Security scheme '${name}' is not an apiKey scheme; resolve a bearer, basic, or header credential for it.`,
    )
  }
  if (definition.in === "cookie") return toolError(`Cookie authentication '${name}' is not supported.`)
  const parameter = definition.in === "header" ? definition.name.toLowerCase() : definition.name
  return addCarrier(carriers, definition.in, parameter, credential.value)
}

const applyCredentials = (
  credentials: ReadonlyArray<readonly [string, SecurityScheme, Credential]>,
): AppliedAuth | ToolError => {
  let carriers: Carriers = { header: [], query: [] }
  for (const credential of credentials) {
    const next = applyCredential(carriers, credential)
    if (next instanceof ToolError) return next
    carriers = next
  }
  return { headers: Object.fromEntries(carriers.header), query: Object.fromEntries(carriers.query) }
}

const buildUrl = (plan: Plan, input: Readonly<Record<string, unknown>>): string | ToolError => {
  let url = plan.url
  for (const field of plan.fields) {
    if (field.location !== "path") continue
    const item = own(input, field.inputName)
    if (item === undefined) {
      return toolError(`Missing required path parameter '${field.inputName}'.`)
    }
    const fieldValue = serializeSimple(field, item, (value) =>
      encodeURIComponent(value).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    if (fieldValue instanceof ToolError) return fieldValue
    // '.'/'..' survive encoding and URL normalization collapses them, letting a
    // model-supplied value retarget the request to a different endpoint.
    if (fieldValue === "" || fieldValue === "." || fieldValue === "..") {
      return toolError(`Invalid path parameter '${field.inputName}'.`)
    }
    url = url.replaceAll(`{${field.name}}`, fieldValue)
  }
  const unresolved = url.match(/\{[^{}]+\}/)
  if (Predicate.isNotNull(unresolved)) return toolError(`Unresolved path parameter ${unresolved[0]}.`)
  return url
}

/** A value with one unambiguous string form in a path, query, or header. */
const isScalar = (item: unknown): item is string | number | boolean | null =>
  Predicate.isNull(item) || Predicate.isString(item) || Predicate.isNumber(item) || Predicate.isBoolean(item)

const serializeSimple = (
  field: Plan["fields"][number],
  value: unknown,
  encode: (value: string) => string,
): string | ToolError => {
  const scalar = (item: unknown): string | ToolError =>
    isScalar(item)
      ? encode(String(item))
      : toolError(`Parameter '${field.inputName}' contains an unsupported nested value.`)
  if (Array.isArray(value)) {
    const items = value.map(scalar)
    const invalid = items.find((item): item is ToolError => item instanceof ToolError)
    return invalid ?? items.join(",")
  }
  if (!isRecord(value)) return scalar(value)
  const entries = Object.entries(value).flatMap<string | ToolError>(([name, item]) => {
    const rendered = scalar(item)
    if (rendered instanceof ToolError) return [rendered]
    return field.explode ? [`${encode(name)}=${rendered}`] : [encode(name), rendered]
  })
  const invalid = entries.find((item): item is ToolError => item instanceof ToolError)
  return invalid ?? entries.join(",")
}

const serializeQuery = (
  request: HttpClientRequest.HttpClientRequest,
  field: Plan["fields"][number],
  value: unknown,
): HttpClientRequest.HttpClientRequest | ToolError => {
  if (field.style === "deepObject") {
    if (!isRecord(value)) return toolError(`Deep-object parameter '${field.inputName}' must be an object.`)
    return Object.entries(value).reduce<HttpClientRequest.HttpClientRequest | ToolError>((current, [name, item]) => {
      if (current instanceof ToolError) return current
      if (!isScalar(item)) {
        return toolError(`Deep-object parameter '${field.inputName}' contains an unsupported nested value.`)
      }
      return HttpClientRequest.appendUrlParam(current, `${field.name}[${name}]`, String(item))
    }, request)
  }
  if (Array.isArray(value)) {
    const rendered = serializeSimple(field, value, String)
    if (rendered instanceof ToolError) return rendered
    if (!field.explode) return HttpClientRequest.appendUrlParam(request, field.name, rendered)
    if (!value.every(isScalar)) {
      return toolError(`Query parameter '${field.inputName}' contains an unsupported nested value.`)
    }
    return value.reduce((current, item) => HttpClientRequest.appendUrlParam(current, field.name, String(item)), request)
  }
  if (isRecord(value) && field.explode) {
    return Object.entries(value).reduce<HttpClientRequest.HttpClientRequest | ToolError>((current, [name, item]) => {
      if (current instanceof ToolError) return current
      if (!isScalar(item)) {
        return toolError(`Query parameter '${field.inputName}' contains an unsupported nested value.`)
      }
      return HttpClientRequest.appendUrlParam(current, name, String(item))
    }, request)
  }
  const rendered = serializeSimple(field, value, String)
  return rendered instanceof ToolError ? rendered : HttpClientRequest.appendUrlParam(request, field.name, rendered)
}

const readResponseBody = (
  response: HttpClientResponse.HttpClientResponse,
  plan: Plan,
): Effect.Effect<string, ToolError> =>
  Effect.gen(function* () {
    const contentLength = response.headers["content-length"]
    const parsedSize = contentLength === undefined ? undefined : Number.parseInt(contentLength, 10)
    const declaredSize =
      parsedSize !== undefined && Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : undefined
    if (declaredSize !== undefined && declaredSize > maxResponseBodyBytes) {
      return yield* Effect.fail(toolError(`${plan.operation.method} ${plan.operation.path} response exceeds 50 MiB.`))
    }
    let body = Buffer.allocUnsafe(Math.min(maxResponseBodyBytes, declaredSize ?? 64 * 1024))
    let size = 0
    yield* Stream.runForEach(response.stream, (chunk) => {
      if (size + chunk.byteLength > maxResponseBodyBytes) {
        return Effect.fail(toolError(`${plan.operation.method} ${plan.operation.path} response exceeds 50 MiB.`))
      }
      if (size + chunk.byteLength > body.byteLength) {
        const grown = Buffer.allocUnsafe(
          Math.min(maxResponseBodyBytes, Math.max(size + chunk.byteLength, body.byteLength * 2)),
        )
        body.copy(grown, 0, 0, size)
        body = grown
      }
      body.set(chunk, size)
      size += chunk.byteLength
      return Effect.void
    }).pipe(
      Effect.catch((cause) => {
        if (cause instanceof ToolError) return Effect.fail(cause)
        if (cause.reason._tag === "EmptyBodyError") return Effect.void
        return Effect.fail(
          toolError(`${plan.operation.method} ${plan.operation.path} failed while reading the response body.`, cause),
        )
      }),
    )
    return new TextDecoder().decode(body.subarray(0, size))
  })
