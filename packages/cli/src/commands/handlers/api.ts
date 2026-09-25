import { EOL } from "node:os"
import { Effect, HashSet, Option, Schema } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Daemon } from "../../services/daemon"

const methods = HashSet.make("delete", "get", "head", "options", "patch", "post", "put")

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
      const index = header.indexOf(":")
      if (index < 1) return yield* Effect.fail(new Error(`Invalid header, expected name:value: ${header}`))
      headers.set(header.slice(0, index).trim(), header.slice(index + 1).trim())
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

export function resolveOperation(spec: OpenApi, operationID: string, params: Record<string, string>) {
  for (const [path, operations] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!HashSet.has(methods, method) || operation?.operationId !== operationID) continue
      return { method: method.toUpperCase(), path: interpolate(path, params) }
    }
  }
  throw new Error(`Operation not found: ${operationID}`)
}

export function rawRequest(input: readonly string[]) {
  if (input.length !== 2 || !HashSet.has(methods, input[0].toLowerCase()) || !input[1].startsWith("/")) return
  return { method: input[0].toUpperCase(), path: input[1] }
}

const resolveRequest = Effect.fnUntraced(function* (
  transport: { url: string; headers: RequestInit["headers"] },
  input: readonly string[],
  params: Record<string, string>,
) {
  const raw = rawRequest(input)
  if (raw) return raw
  if (input.length !== 1) return yield* Effect.fail(new Error("Expected an operation name or an HTTP method and path"))
  const response = yield* Effect.tryPromise(() =>
    fetch(new URL("/openapi.json", transport.url), { headers: transport.headers }),
  )
  if (!response.ok) return yield* Effect.fail(new Error(`Failed to load OpenAPI document: HTTP ${response.status}`))
  const spec = yield* Effect.tryPromise(() => response.text()).pipe(Effect.flatMap(decodeOpenApi))
  return yield* Effect.try(() => resolveOperation(spec, input[0], params))
})

function interpolate(path: string, params: Record<string, string>) {
  const used = HashSet.fromIterable(Array.from(path.matchAll(/\{([^}]+)\}/g), (match) => match[1]))
  const pathname = path.replaceAll(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name]
    if (value === undefined) throw new Error(`Missing path parameter: ${name}`)
    return encodeURIComponent(value)
  })
  const query = new URLSearchParams(Object.entries(params).filter(([name]) => !HashSet.has(used, name))).toString()
  return query ? `${pathname}?${query}` : pathname
}
