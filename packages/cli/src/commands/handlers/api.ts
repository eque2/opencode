import { EOL } from "node:os"
import { Effect, HashSet, Option, Result, Schema } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Daemon } from "../../services/daemon"

const methods = HashSet.make("delete", "get", "head", "options", "patch", "post", "put")

export class InvalidHeaderError extends Schema.TaggedError<InvalidHeaderError>()("CliApi.InvalidHeaderError", {
  message: Schema.String,
}) {}

export class OperationNotFoundError extends Schema.TaggedError<OperationNotFoundError>()(
  "CliApi.OperationNotFoundError",
  { message: Schema.String },
) {}

export class MissingPathParameterError extends Schema.TaggedError<MissingPathParameterError>()(
  "CliApi.MissingPathParameterError",
  { message: Schema.String },
) {}

export class RequestShapeError extends Schema.TaggedError<RequestShapeError>()("CliApi.RequestShapeError", {
  message: Schema.String,
}) {}

export class OpenApiLoadError extends Schema.TaggedError<OpenApiLoadError>()("CliApi.OpenApiLoadError", {
  status: Schema.Number,
  message: Schema.String,
}) {}

// The CLI reads only the operation IDs. The structs ignore every other key of a
// path item or an operation, such as parameters, summary and responses.
const Operation = Schema.Struct({
  operationId: Schema.optional(Schema.String),
}).annotate({ identifier: "CliApi.Operation" })

const PathItem = Schema.Struct({
  delete: Schema.optional(Operation),
  get: Schema.optional(Operation),
  head: Schema.optional(Operation),
  options: Schema.optional(Operation),
  patch: Schema.optional(Operation),
  post: Schema.optional(Operation),
  put: Schema.optional(Operation),
}).annotate({ identifier: "CliApi.PathItem" })

const OpenApi = Schema.Struct({
  paths: Schema.optional(Schema.Record(Schema.String, PathItem)),
}).annotate({ identifier: "CliApi.OpenApi" })
type OpenApi = typeof OpenApi.Type

const decodeOpenApi = Schema.decodeEffect(Schema.fromJsonString(OpenApi))

export default Runtime.handler(
  Commands.commands.api,
  Effect.fn("cli.api")(function* (input) {
    const daemon = yield* Daemon.Service
    const transport = yield* daemon.transport()
    const params = Option.getOrElse(input.param, () => ({}))
    const request = yield* resolveRequest(transport, input.request, params)
    const headers = new Headers(transport.headers)
    for (const header of input.header) {
      const [name, value] = yield* Effect.fromResult(parseHeader(header))
      headers.set(name, value)
    }
    const body = Option.getOrUndefined(input.data)
    if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")

    const response = yield* Effect.tryPromise(() =>
      fetch(new URL(request.path, transport.url), {
        method: request.method,
        headers,
        body,
      }),
    )
    const output = yield* Effect.promise(() => response.text())
    if (output) process.stdout.write(output + (output.endsWith(EOL) ? "" : EOL))
  }),
)

export function resolveOperation(
  spec: OpenApi,
  operationID: string,
  params: Record<string, string>,
): Result.Result<{ method: string; path: string }, OperationNotFoundError | MissingPathParameterError> {
  for (const [path, operations] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!HashSet.has(methods, method) || operation?.operationId !== operationID) continue
      return Result.map(interpolate(path, params), (resolved) => ({ method: method.toUpperCase(), path: resolved }))
    }
  }
  return Result.fail(new OperationNotFoundError({ message: `Operation not found: ${operationID}` }))
}

function parseHeader(header: string): Result.Result<readonly [name: string, value: string], InvalidHeaderError> {
  const index = header.indexOf(":")
  if (index < 1)
    return Result.fail(new InvalidHeaderError({ message: `Invalid header, expected name:value: ${header}` }))
  return Result.succeed([header.slice(0, index).trim(), header.slice(index + 1).trim()])
}

export function rawRequest(input: readonly string[]): Option.Option<{ method: string; path: string }> {
  if (input.length !== 2 || !HashSet.has(methods, input[0].toLowerCase()) || !input[1].startsWith("/"))
    return Option.none()
  return Option.some({ method: input[0].toUpperCase(), path: input[1] })
}

const resolveRequest = Effect.fnUntraced(function* (
  transport: { url: string; headers: RequestInit["headers"] },
  input: readonly string[],
  params: Record<string, string>,
) {
  const raw = rawRequest(input)
  if (Option.isSome(raw)) return raw.value
  if (input.length !== 1)
    return yield* Effect.fail(
      new RequestShapeError({ message: "Expected an operation name or an HTTP method and path" }),
    )
  const response = yield* Effect.tryPromise(() =>
    fetch(new URL("/openapi.json", transport.url), { headers: transport.headers }),
  )
  if (!response.ok)
    return yield* Effect.fail(
      new OpenApiLoadError({
        status: response.status,
        message: `Failed to load OpenAPI document: HTTP ${response.status}`,
      }),
    )
  const spec = yield* Effect.tryPromise(() => response.text()).pipe(Effect.flatMap(decodeOpenApi))
  return yield* Effect.fromResult(resolveOperation(spec, input[0], params))
})

function interpolate(path: string, params: Record<string, string>): Result.Result<string, MissingPathParameterError> {
  const names = Array.from(path.matchAll(/\{([^}]+)\}/g), (match) => match[1])
  const missing = names.find((name) => params[name] === undefined)
  if (missing !== undefined)
    return Result.fail(new MissingPathParameterError({ message: `Missing path parameter: ${missing}` }))
  const used = HashSet.fromIterable(names)
  const pathname = path.replaceAll(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(params[name]))
  const query = new URLSearchParams(Object.entries(params).filter(([name]) => !HashSet.has(used, name))).toString()
  return Result.succeed(query ? `${pathname}?${query}` : pathname)
}
