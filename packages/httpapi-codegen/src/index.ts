import { isAbsolute, join } from "node:path"
import {
  Array as Arr,
  Chunk,
  Effect,
  FileSystem,
  HashSet,
  MutableHashMap,
  MutableHashSet,
  Option,
  PlatformError,
  Predicate,
  Result,
  Schema,
  SchemaAST,
  SchemaRepresentation,
} from "effect"
import { HttpMethod, type HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, type HttpApiMiddleware, HttpApiSchema } from "effect/unstable/httpapi"
import { format } from "prettier"

export type InputField = {
  readonly name: string
  readonly source: "params" | "query" | "headers" | "payload"
}

export type Operation = {
  readonly group: string
  readonly name: string
  readonly input: ReadonlyArray<InputField>
  readonly inputMode: "none" | "optional" | "required"
  readonly success: "value" | "void" | "stream"
  readonly errors: ReadonlyArray<string>
}

export type Output = {
  readonly operations: ReadonlyArray<Operation>
  readonly files: ReadonlyArray<{
    readonly path: string
    readonly content: string
  }>
}

export type Contract = {
  readonly groups: ReadonlyArray<Group>
}

export class GenerationError extends Schema.TaggedError<GenerationError>()("GenerationError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export type Endpoint = {
  readonly group: string
  readonly sourceGroup: string
  readonly topLevel: boolean
  readonly endpoint: HttpApiEndpoint.Top
  readonly params: Schema.Top | undefined
  readonly query: Schema.Top | undefined
  readonly headers: Schema.Top | undefined
  readonly payloads: ReadonlyArray<Schema.Top>
  readonly operation: Operation
  readonly input: ReadonlyArray<InputField & { readonly optional: boolean }>
  readonly unwrapData: boolean
  readonly errors: ReadonlyArray<{ readonly status: number; readonly schema: Schema.Top }>
  readonly successes: ReadonlyArray<Schema.Top>
  readonly effectPortable: boolean
}

export type Group = {
  readonly identifier: string
  readonly sourceIdentifier: string
  readonly module: string
  readonly endpoints: ReadonlyArray<Endpoint>
}

type Slot = {
  readonly name: string
  readonly schema: Schema.Top
}

type SseStreamSchema = Exclude<HttpApiSchema.StreamSchema, HttpApiSchema.StreamUint8Array>

type Transport = {
  readonly schema: Schema.Top
  readonly effectPortable: boolean
}

type CompileOptions = {
  readonly groupNames?: Readonly<Record<string, string>>
  readonly endpointNames?: Readonly<Record<string, string>>
  readonly omitEndpoints?: ReadonlySet<string>
}

type PromiseOptions = {
  readonly outputTypes?: Readonly<Record<string, { readonly name: string; readonly import: string }>>
}

type ReflectedEndpoint = {
  readonly group: HttpApiGroup.Top
  readonly endpoint: HttpApiEndpoint.Top
  readonly middleware: ReadonlySet<HttpApiMiddleware.AnyService>
  readonly errors: ReadonlyMap<number, readonly [Schema.Top, ...Array<Schema.Top>]>
}

const resolveHttpApiStatus = SchemaAST.resolveAt<number>("httpApiStatus")
const resolveHttpApiEncoding = SchemaAST.resolveAt<HttpApiSchema.Encoding>("~httpApiEncoding")
const Manifest = Schema.fromJsonString(Schema.Array(Schema.String), { space: 2 })
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String))
const encodeJsonValue = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const manifestName = ".httpapi-codegen.json"

const failGeneration = (reason: string): Result.Result<never, GenerationError> =>
  Result.fail(new GenerationError({ reason }))

// Runs `f` over `items` in order and stops at the first failure, so the first error wins.
function forEachResult<A, B, E>(
  items: Iterable<A>,
  f: (item: A, index: number) => Result.Result<B, E>,
): Result.Result<Array<B>, E> {
  return Result.gen(function* () {
    let results = Chunk.empty<B>()
    for (const [index, item] of Array.from(items).entries()) results = Chunk.append(results, yield* f(item, index))
    return Chunk.toArray(results)
  })
}

export function compile<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  options?: CompileOptions,
): Contract {
  return Result.getOrThrow(compileResult(api, options))
}

function compileResult<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  options?: CompileOptions,
): Result.Result<Contract, GenerationError> {
  // HttpApi.reflect calls onEndpoint synchronously and cannot carry a failure, so collect the endpoints first.
  let reflected = Chunk.empty<ReflectedEndpoint>()
  HttpApi.reflect(api, {
    onGroup() {},
    onEndpoint({ endpoint, errors, group, middleware }) {
      if (options?.omitEndpoints?.has(endpoint.identifier)) return
      reflected = Chunk.append(reflected, { endpoint, errors, group, middleware })
    },
  })
  const portable = MutableHashMap.empty<SchemaAST.AST, boolean>()

  return Result.gen(function* () {
    const endpoints = yield* forEachResult(reflected, (item) => compileEndpoint(item, options, portable))
    const modules = MutableHashSet.make("client", "client-error", "index")
    const groups = yield* forEachResult(
      Map.groupBy(endpoints, (endpoint) => endpoint.group),
      ([identifier, endpoints], index): Result.Result<Group, GenerationError> => {
        if (Arr.dedupe(endpoints.map((endpoint) => endpoint.sourceGroup)).length > 1) {
          return failGeneration(`Client group name collision: ${identifier}`)
        }
        const base = /^[A-Za-z0-9_-]+$/.test(identifier) ? identifier : `group-${index}`
        const module = uniqueModule(base, index, modules)
        MutableHashSet.add(modules, module.toLowerCase())
        return Result.succeed({ identifier, sourceIdentifier: endpoints[0].sourceGroup, module, endpoints })
      },
    )
    const publicNames = MutableHashSet.empty<string>()
    for (const group of groups) {
      const endpointNames = MutableHashSet.empty<string>()
      for (const endpoint of group.endpoints) {
        if (MutableHashSet.has(endpointNames, endpoint.operation.name)) {
          return yield* failGeneration(`Client endpoint name collision: ${group.identifier}.${endpoint.operation.name}`)
        }
        MutableHashSet.add(endpointNames, endpoint.operation.name)
      }
      const names = group.endpoints[0]?.topLevel
        ? group.endpoints.map((item) => item.operation.name)
        : [group.identifier]
      for (const name of names) {
        if (MutableHashSet.has(publicNames, name)) return yield* failGeneration(`Client name collision: ${name}`)
        MutableHashSet.add(publicNames, name)
      }
    }
    return { groups }
  })
}

function compileEndpoint(
  { endpoint, errors, group, middleware }: ReflectedEndpoint,
  options: CompileOptions | undefined,
  portable: MutableHashMap.MutableHashMap<SchemaAST.AST, boolean>,
): Result.Result<Endpoint, GenerationError> {
  return Result.gen(function* () {
    const groupName = options?.groupNames?.[group.identifier] ?? group.identifier
    const name = `${groupName}.${endpoint.identifier}`
    const required = Array.from(middleware).find((item) => item.requiredForClient)
    if (required !== undefined) return yield* failGeneration(`Client middleware requires adapter: ${required.key}`)

    const successSchemas = endpoint.success.size === 0 ? [HttpApiSchema.NoContent] : Array.from(endpoint.success)
    if (successSchemas.length > 1) return yield* failGeneration(`Multiple success schemas: ${name}`)

    const params = yield* optionalTransport(endpoint.params, "params", endpoint, name)
    const query = yield* optionalTransport(endpoint.query, "query", endpoint, name)
    const headers = yield* optionalTransport(endpoint.headers, "headers", endpoint, name)
    const sourcePayloads = Array.from(endpoint.payload.values()).flatMap(({ schemas }) => schemas)
    if (sourcePayloads.length > 1) return yield* failGeneration(`Multiple payload schemas: ${name}`)
    const payloads = yield* forEachResult(sourcePayloads, (schema) =>
      normalizeTransport(schema, "payload", endpoint, name),
    )
    const success = yield* normalizeTransport(successSchemas[0], "success", endpoint, name)
    const errorSchemas = yield* forEachResult(
      Array.from(errors).flatMap(([status, schemas]) => schemas.map((schema) => ({ status, schema }))),
      (item) =>
        Result.map(normalizeTransport(item.schema, "error", endpoint, name), (normalized) => ({
          status: item.status,
          ...normalized,
        })),
    )
    const inputs = [
      ...(yield* inputFields(params, "params", name)),
      ...(yield* inputFields(query, "query", name)),
      ...(yield* inputFields(headers, "headers", name)),
      ...(yield* forEachResult(payloads, (item) => inputFields(Option.some(item), "payload", name))).flat(),
    ]
    const names = MutableHashSet.empty<string>()
    for (const field of inputs) {
      if (MutableHashSet.has(names, field.name)) return yield* failGeneration(`Input field collision: ${field.name}`)
      MutableHashSet.add(names, field.name)
    }

    const schemaPaths: Array<readonly [string, Schema.Top]> = [
      ...Option.toArray(Option.map(params, (item) => [`${name}.params`, item.schema] as const)),
      ...Option.toArray(Option.map(query, (item) => [`${name}.query`, item.schema] as const)),
      ...Option.toArray(Option.map(headers, (item) => [`${name}.headers`, item.schema] as const)),
      ...payloads.map((item) => [`${name}.payload`, item.schema] as const),
      ...(yield* responseSchemas(success.schema, `${name}.success`)),
      ...errorSchemas.map((item) => [`${name}.error.${item.status}`, item.schema] as const),
    ]
    const effectPortable =
      [...Arr.getSomes([params, query, headers]), ...payloads, success, ...errorSchemas].every(
        (item) => item.effectPortable,
      ) && (yield* streamEffectPortable(success.schema))
    if (effectPortable) {
      for (const [path, schema] of schemaPaths) {
        if (!schemaPortable(schema, portable)) return yield* failGeneration(`Unportable schema: ${path}`)
      }
    }

    return {
      group: groupName,
      sourceGroup: group.identifier,
      topLevel: group.topLevel,
      endpoint,
      params: transportSchema(params),
      query: transportSchema(query),
      headers: transportSchema(headers),
      payloads: payloads.map((item) => item.schema),
      input: inputs,
      unwrapData: isDataEnvelope(success.schema),
      successes: [success.schema],
      errors: errorSchemas.map((item) => ({ status: item.status, schema: item.schema })),
      effectPortable,
      operation: {
        group: groupName,
        name: options?.endpointNames?.[endpoint.identifier] ?? clientEndpointName(endpoint.identifier),
        input: inputs.map(({ name, source }) => ({ name, source })),
        inputMode: inputs.length === 0 ? "none" : inputs.every((field) => field.optional) ? "optional" : "required",
        success: isStreamSchema(success.schema)
          ? "stream"
          : HttpApiSchema.isNoContent(success.schema.ast)
            ? "void"
            : "value",
        errors: Arr.dedupe([
          ...errorSchemas.flatMap((item) => {
            const identifier = SchemaAST.resolveIdentifier(item.schema.ast)
            return identifier === undefined ? [] : [identifier]
          }),
          "ClientError",
        ]),
      },
    }
  })
}

export function emitEffect(contract: Contract): Output {
  return Result.getOrThrow(emitEffectResult(contract))
}

function emitEffectResult(contract: Contract): Result.Result<Output, GenerationError> {
  const endpoint = contract.groups.flatMap((group) => group.endpoints).find((endpoint) => !endpoint.effectPortable)
  if (endpoint !== undefined) {
    return failGeneration(
      `Effect schema requires authoritative import: ${endpoint.group}.${endpoint.endpoint.identifier}`,
    )
  }
  return Result.map(renderEffectFiles(contract.groups), (files) => ({ operations: operations(contract.groups), files }))
}

export function emitEffectImported(
  contract: Contract,
  options:
    | { readonly module: string; readonly api: string }
    | { readonly module: string; readonly group: string }
    | { readonly module: string; readonly endpoints: Readonly<Record<string, string>> },
): Output {
  return Result.getOrThrow(
    Result.map(renderImportedEffectFiles(contract.groups, options), (files) => ({
      operations: operations(contract.groups),
      files,
    })),
  )
}

export function emitPromise(contract: Contract, options?: PromiseOptions): Output {
  return Result.getOrThrow(emitPromiseResult(contract, options))
}

function emitPromiseResult(
  contract: Contract,
  options: PromiseOptions | undefined,
): Result.Result<Output, GenerationError> {
  return Result.gen(function* () {
    const groups = contract.groups
    for (const group of groups) {
      for (const endpoint of group.endpoints) yield* checkPromiseEndpoint(endpoint)
    }
    return {
      operations: operations(groups),
      files: [
        { path: "types.ts", content: yield* renderPromiseTypes(groups, options?.outputTypes) },
        {
          path: "client-error.ts",
          content: `export type ClientErrorReason = "Transport" | "UnexpectedStatus" | "UnsupportedContentType" | "MalformedResponse"\n\nexport class ClientError extends Error {\n  override readonly name = "ClientError"\n  constructor(readonly reason: ClientErrorReason, options?: ErrorOptions) {\n    super(reason, options)\n  }\n}\n`,
        },
        {
          path: "client.ts",
          content: (yield* renderPromiseClient(groups)).replace(
            "let next: ReadableStreamReadResult<Uint8Array>",
            "let next",
          ),
        },
        {
          path: "index.ts",
          content:
            'export { ClientError, type ClientErrorReason } from "./client-error"\nexport * as OpenCode from "./client"\nexport * from "./types"\n',
        },
      ],
    }
  })
}

function checkPromiseEndpoint(endpoint: Endpoint): Result.Result<Endpoint, GenerationError> {
  const name = `${endpoint.group}.${endpoint.endpoint.identifier}`
  const payload = endpoint.payloads[0]
  const payloadEncoding = payload === undefined ? undefined : resolveHttpApiEncoding(payload.ast)
  if (
    payload !== undefined &&
    (payloadEncoding?._tag ?? (HttpMethod.hasBody(endpoint.endpoint.method) ? "Json" : "FormUrlEncoded")) !== "Json"
  ) {
    return failGeneration(`Unsupported Promise payload encoding: ${name}`)
  }
  const success = endpoint.successes[0]
  if (isStreamSchema(success)) {
    if (
      success._tag !== "StreamSse" ||
      success.sseMode !== "data" ||
      !SchemaAST.isNever(Schema.toType(success.error).ast)
    ) {
      return failGeneration(`Unsupported Promise stream: ${name}`)
    }
  } else if (
    !HttpApiSchema.isNoContent(success.ast) &&
    (resolveHttpApiEncoding(success.ast)?._tag ?? "Json") !== "Json"
  ) {
    return failGeneration(`Unsupported Promise success encoding: ${name}`)
  }
  for (const error of endpoint.errors) {
    if (declaredErrorFields(error.schema) === undefined) {
      return failGeneration(`Promise error must have a literal discriminator: ${name}`)
    }
    if ((resolveHttpApiEncoding(error.schema.ast)?._tag ?? "Json") !== "Json") {
      return failGeneration(`Unsupported Promise error encoding: ${name}`)
    }
  }
  return Result.succeed(endpoint)
}

function operations(groups: ReadonlyArray<Group>) {
  return groups.flatMap((group) => group.endpoints.map((endpoint) => endpoint.operation))
}

function renderEffectFiles(groups: ReadonlyArray<Group>): Result.Result<Output["files"], GenerationError> {
  return Result.map(
    forEachResult(groups, (group, index) =>
      Result.map(renderGroup(group, index), (content) => ({ path: `${group.module}.ts`, content })),
    ),
    (files) => [
      ...files,
      {
        path: "client-error.ts",
        content:
          'import { Schema } from "effect"\n\nexport class ClientError extends Schema.TaggedError<ClientError>()("ClientError", {\n  cause: Schema.Defect(),\n}) {}\n',
      },
      { path: "client.ts", content: renderClient(groups) },
      {
        path: "index.ts",
        content: 'export { ClientError } from "./client-error"\nexport * as OpenCode from "./client"\n',
      },
    ],
  )
}

function renderImportedEffectFiles(
  groups: ReadonlyArray<Group>,
  options:
    | { readonly module: string; readonly api: string }
    | { readonly module: string; readonly group: string }
    | { readonly module: string; readonly endpoints: Readonly<Record<string, string>> },
): Result.Result<Output["files"], GenerationError> {
  return Result.gen(function* () {
    const adapters = groups.map((group, groupIndex) => {
      const rawGroup = group.endpoints[0]?.topLevel
        ? "RawClient"
        : `RawClient[${encodeJsonString(group.sourceIdentifier)}]`
      const methods = group.endpoints.map((item, endpointIndex) => {
        const prefix = `Endpoint${groupIndex}_${endpointIndex}`
        const request = (["params", "query", "headers", "payload"] as const)
          .flatMap((source) => {
            const fields = item.input.filter((field) => field.source === source)
            if (fields.length === 0) return []
            return [
              `${source}: { ${fields.map((field) => `${encodeJsonString(field.name)}: input${item.operation.inputMode === "optional" ? "?." : ""}[${encodeJsonString(field.name)}]`).join(", ")} }`,
            ]
          })
          .join(", ")
        const input = item.input
          .map(
            (field) =>
              `readonly ${encodeJsonString(field.name)}${field.optional ? "?" : ""}: ${prefix}Request[${encodeJsonString(field.source)}][${encodeJsonString(field.name)}]`,
          )
          .join("; ")
        const argument =
          item.operation.inputMode === "none"
            ? ""
            : `input${item.operation.inputMode === "optional" ? "?" : ""}: ${prefix}Input`
        const rawCall = `raw[${encodeJsonString(item.endpoint.identifier)}]({ ${request} })`
        const mapped = `${rawCall}.pipe(Effect.mapError(mapClientError)${item.unwrapData ? ", Effect.map((value) => value.data)" : ""})`
        return `${item.operation.inputMode === "none" ? "" : `type ${prefix}Request = Parameters<${rawGroup}[${encodeJsonString(item.endpoint.identifier)}]>[0]\ntype ${prefix}Input = { ${input} }\n`}const ${prefix} = (raw: ${rawGroup}) => (${argument}) => ${item.operation.success === "stream" ? `Stream.unwrap(${rawCall}.pipe(Effect.mapError(mapClientError), Effect.map((stream) => stream.pipe(Stream.mapError(mapClientError)))))` : mapped}`
      })
      return `${methods.join("\n\n")}\n\nconst adaptGroup${groupIndex} = (raw: ${rawGroup}) => ({ ${group.endpoints.map((item, endpointIndex) => `${encodeJsonString(item.operation.name)}: Endpoint${groupIndex}_${endpointIndex}(raw)`).join(", ")} })`
    })
    const fields = groups.flatMap((group, index) =>
      group.endpoints[0]?.topLevel
        ? [`...adaptGroup${index}(raw)`]
        : [
            `${encodeJsonString(group.identifier)}: adaptGroup${index}(raw[${encodeJsonString(group.sourceIdentifier)}])`,
          ],
    )
    const usesStream = groups.some((group) => group.endpoints.some((item) => item.operation.success === "stream"))
    const imported = "api" in options
    const projection = imported
      ? undefined
      : "group" in options
        ? renderImportedGroup(options.group)
        : yield* renderImportedProjection(groups, options.endpoints)
    const api = imported ? options.api : "Api"
    const imports =
      projection === undefined
        ? `import { ${api} } from ${encodeJsonString(options.module)}`
        : `import { HttpApi, HttpApiClient${"endpoints" in options ? ", HttpApiGroup" : ""} } from "effect/unstable/httpapi"\nimport { ${projection.imports.join(", ")} } from ${encodeJsonString(options.module)}`
    const httpApiImport = projection === undefined ? 'import { HttpApiClient } from "effect/unstable/httpapi"\n' : ""
    const client = `// Generated by @opencode-ai/httpapi-codegen. Do not edit.\nimport { Effect${usesStream ? ", Stream" : ""}, Schema } from "effect"\nimport { Sse } from "effect/unstable/encoding"\nimport { HttpClientError } from "effect/unstable/http"\n${httpApiImport}${imports}\nimport { ClientError } from "./client-error"\n\n${projection?.source ?? ""}type RawClient = HttpApiClient.ForApi<typeof ${api}>\n\nconst mapClientError = <E>(error: E) => HttpClientError.isHttpClientError(error) || Schema.isSchemaError(error) || Sse.Retry.is(error) ? new ClientError({ cause: error }) : error\n\n${adapters.join("\n\n")}\n\nconst adaptClient = (raw: RawClient) => ({ ${fields.join(", ")} })\n\nexport const make = (options?: { readonly baseUrl?: URL | string }) => HttpApiClient.make(${api}, options).pipe(Effect.map(adaptClient))\n`
    return [
      {
        path: "client-error.ts",
        content:
          'import { Schema } from "effect"\n\nexport class ClientError extends Schema.TaggedError<ClientError>()("ClientError", {\n  cause: Schema.Defect(),\n}) {}\n',
      },
      { path: "client.ts", content: client },
      {
        path: "index.ts",
        content: 'export { ClientError } from "./client-error"\nexport * as OpenCode from "./client"\n',
      },
    ]
  })
}

function renderImportedGroup(group: string) {
  return {
    imports: [group],
    source: `const Api = HttpApi.make("generated").add(${group})\n\n`,
  }
}

function renderImportedProjection(
  groups: ReadonlyArray<Group>,
  endpoints: Readonly<Record<string, string>>,
): Result.Result<{ readonly imports: ReadonlyArray<string>; readonly source: string }, GenerationError> {
  const keys = groups.flatMap((group) =>
    group.endpoints.map((endpoint) => `${group.identifier}.${endpoint.endpoint.identifier}`),
  )
  return Result.map(
    forEachResult(keys, (key) => {
      const name = endpoints[key]
      return name === undefined ? failGeneration(`Missing imported endpoint: ${key}`) : Result.succeed(name)
    }),
    (imports) => {
      const source = `const Api = HttpApi.make("generated").${groups
        .map((group) => {
          const options = group.endpoints[0]?.topLevel ? ", { topLevel: true }" : ""
          return `add(HttpApiGroup.make(${encodeJsonString(group.identifier)}${options})${group.endpoints.map((endpoint) => `.add(${endpoints[`${group.identifier}.${endpoint.endpoint.identifier}`]})`).join("")})`
        })
        .join(".")}\n\n`
      return { imports: Arr.dedupe(imports), source }
    },
  )
}

function renderPromiseTypes(
  groups: ReadonlyArray<Group>,
  outputTypes?: Readonly<Record<string, { readonly name: string; readonly import: string }>>,
): Result.Result<string, GenerationError> {
  const types = MutableHashMap.empty<SchemaAST.AST, string>()
  const typeOf = (schema: Schema.Top, decoded = false): Result.Result<string, GenerationError> => {
    const projected = decoded ? Schema.toType(schema) : Schema.toEncoded(schema)
    const cached = MutableHashMap.get(types, projected.ast)
    if (Option.isSome(cached)) return Result.succeed(cached.value)
    return structuralType(projected).pipe(Result.tap((type) => MutableHashMap.set(types, projected.ast, type)))
  }
  const errors = MutableHashMap.fromIterable(
    groups.flatMap((group) =>
      group.endpoints.flatMap((endpoint) =>
        endpoint.errors.flatMap((error) => {
          const tagged = declaredErrorFields(error.schema)
          return tagged === undefined ? [] : [[tagged.tag, tagged] as const]
        }),
      ),
    ),
  )
  return Result.gen(function* () {
    const errorTypes = yield* forEachResult(MutableHashMap.values(errors), (error) =>
      Result.gen(function* () {
        const fields = (yield* forEachResult(error.fields, ([name, schema, optional]) =>
          Result.map(typeOf(schema), (type) => `readonly ${encodeJsonString(name)}${optional ? "?" : ""}: ${type}`),
        )).join("; ")
        return `export type ${error.identifier} = { readonly ${encodeJsonString(error.key)}: ${encodeJsonString(error.tag)}; ${fields} }\nexport const is${error.identifier} = (value: unknown): value is ${error.identifier} => typeof value === "object" && value !== null && ${encodeJsonString(error.key)} in value && value[${encodeJsonString(error.key)}] === ${encodeJsonString(error.tag)}`
      }),
    )
    const operationTypes = yield* forEachResult(groups, (group) =>
      forEachResult(group.endpoints, (endpoint) =>
        Result.gen(function* () {
          const prefix = promiseTypePrefix(group.identifier, endpoint.operation.name)
          const schemas = {
            params: endpoint.params,
            query: endpoint.query,
            headers: endpoint.headers,
            payload: endpoint.payloads[0],
          }
          const input = (yield* forEachResult(endpoint.input, (field): Result.Result<string, GenerationError> => {
            const schema = schemas[field.source]
            if (schema === undefined) return failGeneration(`Missing input schema: ${prefix}.${field.name}`)
            return Result.map(
              typeOf(schema, field.source === "query"),
              (type) =>
                `readonly ${encodeJsonString(field.name)}${field.optional ? "?" : ""}: (${type})[${encodeJsonString(field.name)}]`,
            )
          })).join("; ")
          const successSchema = endpoint.successes[0]
          const success =
            outputTypes?.[`${group.identifier}.${endpoint.operation.name}`]?.name ??
            (yield* typeOf(
              isStreamSchema(successSchema) && successSchema._tag === "StreamSse"
                ? successSchema.sseMode === "data"
                  ? yield* streamEncodedDataSchema(successSchema)
                  : streamEventsSchema(successSchema)
                : successSchema,
            ))
          return [
            ...(endpoint.operation.inputMode === "none" ? [] : [`export type ${prefix}Input = { ${input} }`]),
            `export type ${prefix}Output = ${endpoint.unwrapData ? `(${success})["data"]` : success}`,
          ]
        }),
      ),
    )
    const operations = operationTypes.flat(2).join("\n\n")
    const json = operations.includes("JsonValue")
      ? "export type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue }"
      : ""
    const imports = Arr.dedupe(Object.values(outputTypes ?? {}).map((override) => override.import))
    return [...imports, json, ...errorTypes, operations].filter(Boolean).join("\n\n")
  })
}

function renderPromiseClient(groups: ReadonlyArray<Group>): Result.Result<string, GenerationError> {
  return Result.gen(function* () {
    const imports = groups.flatMap((group) =>
      group.endpoints.flatMap((endpoint) => {
        const prefix = promiseTypePrefix(group.identifier, endpoint.operation.name)
        return [...(endpoint.operation.inputMode === "none" ? [] : [`${prefix}Input`]), `${prefix}Output`]
      }),
    )
    const fields = yield* forEachResult(groups, (group) =>
      Result.gen(function* () {
        const methods = yield* forEachResult(group.endpoints, (endpoint) =>
          Result.gen(function* () {
            const prefix = promiseTypePrefix(group.identifier, endpoint.operation.name)
            const argument =
              endpoint.operation.inputMode === "none"
                ? "requestOptions?: RequestOptions"
                : `input${endpoint.operation.inputMode === "optional" ? "?" : ""}: ${prefix}Input, requestOptions?: RequestOptions`
            const path = yield* promisePath(endpoint.endpoint.path, endpoint.input)
            const access = (name: string) =>
              `input${endpoint.operation.inputMode === "optional" ? "?." : ""}[${encodeJsonString(name)}]`
            const part = (source: InputField["source"]) => {
              const inputs = endpoint.input.filter((field) => field.source === source)
              return inputs.length === 0
                ? undefined
                : `{ ${inputs.map((field) => `${encodeJsonString(field.name)}: ${access(field.name)}`).join(", ")} }`
            }
            const parts = [
              endpoint.query === undefined ? undefined : `query: ${part("query")}`,
              endpoint.headers === undefined ? undefined : `headers: ${part("headers")}`,
              endpoint.payloads.length === 0 ? undefined : `body: ${part("payload")}`,
            ].filter((value): value is string => value !== undefined)
            const declaredStatuses = Arr.dedupe(endpoint.errors.map((error) => error.status))
            const descriptor = `{ method: ${encodeJsonString(endpoint.endpoint.method)}, path: ${path}${parts.length === 0 ? "" : `, ${parts.join(", ")}`}, successStatus: ${resolveHttpApiStatus(endpoint.successes[0].ast) ?? 200}, declaredStatuses: [${declaredStatuses.join(", ")}], empty: ${endpoint.operation.success === "void"} }`
            if (endpoint.operation.success === "stream") {
              const success = endpoint.successes[0]
              if (!isStreamSchema(success) || success._tag !== "StreamSse" || success.sseMode !== "data") {
                return yield* failGeneration(
                  `Promise stream emission is not implemented: ${group.identifier}.${endpoint.endpoint.identifier}`,
                )
              }
              return `${encodeJsonString(endpoint.operation.name)}: (${argument}): AsyncIterable<${prefix}Output> => sse<${prefix}Output>(${descriptor}, requestOptions)`
            }
            const unwrap = endpoint.unwrapData ? ".then((value) => value.data)" : ""
            return `${encodeJsonString(endpoint.operation.name)}: (${argument}) => request<${endpoint.unwrapData ? `{ readonly data: ${prefix}Output }` : `${prefix}Output`}>(${descriptor}, requestOptions)${unwrap}`
          }),
        )
        if (group.endpoints[0]?.topLevel) return methods.join(", ")
        return `${encodeJsonString(group.identifier)}: { ${methods.join(", ")} }`
      }),
    )
    return `import type { ${imports.join(", ")} } from "./types"\nimport { ClientError } from "./client-error"\n\nexport interface ClientOptions {\n  readonly baseUrl: string\n  readonly fetch?: typeof globalThis.fetch\n  readonly headers?: HeadersInit\n}\n\nexport interface RequestOptions {\n  readonly signal?: AbortSignal\n  readonly headers?: HeadersInit\n}\n\ninterface RequestDescriptor {\n  readonly method: string\n  readonly path: string\n  readonly query?: Record<string, unknown>\n  readonly headers?: Record<string, unknown>\n  readonly body?: unknown\n  readonly successStatus: number\n  readonly declaredStatuses: ReadonlyArray<number>\n  readonly empty: boolean\n}\n\nexport function make(options: ClientOptions) {\n  const fetch = options.fetch ?? globalThis.fetch\n\n  const prepare = (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {\n    const url = new URL(descriptor.path, options.baseUrl)\n    for (const [key, value] of Object.entries(descriptor.query ?? {})) appendQuery(url.searchParams, key, value)\n    const headers = new Headers(options.headers)\n    for (const [key, value] of Object.entries(descriptor.headers ?? {})) {\n      if (value !== undefined && value !== null) headers.set(key, String(value))\n    }\n    for (const [key, value] of new Headers(requestOptions?.headers)) headers.set(key, value)\n    if (descriptor.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")\n    return {\n      url,\n      init: {\n        method: descriptor.method,\n        signal: requestOptions?.signal,\n        headers,\n        body: descriptor.body === undefined ? undefined : JSON.stringify(descriptor.body),\n      } satisfies RequestInit,\n    }\n  }\n\n  const execute = async (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {\n    try {\n      const prepared = prepare(descriptor, requestOptions)\n      return await fetch(prepared.url, prepared.init)\n    } catch (cause) {\n      throw new ClientError("Transport", { cause })\n    }\n  }\n\n  const responseError = async (response: Response, descriptor: RequestDescriptor): Promise<never> => {\n    if (descriptor.declaredStatuses.includes(response.status)) throw await json(response)\n    try {\n      await response.body?.cancel()\n    } catch {}\n    throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })\n  }\n\n  const request = async <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): Promise<A> => {\n    const response = await execute(descriptor, requestOptions)\n    if (response.status !== descriptor.successStatus) return responseError(response, descriptor)\n    if (descriptor.empty) {\n      try {\n        await response.body?.cancel()\n      } catch {}\n      return undefined as A\n    }\n    return await json(response) as A\n  }\n\n  const sse = <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): AsyncIterable<A> => ({\n    async *[Symbol.asyncIterator]() {\n      const response = await execute(descriptor, requestOptions)\n      if (response.status !== descriptor.successStatus) await responseError(response, descriptor)\n      if (!isContentType(response, "text/event-stream")) {\n        try {\n          await response.body?.cancel()\n        } catch {}\n        throw new ClientError("UnsupportedContentType")\n      }\n      if (response.body === null) throw new ClientError("MalformedResponse")\n      const reader = response.body.getReader()\n      const decoder = new TextDecoder()\n      let buffer = ""\n      try {\n        while (true) {\n          let next: ReadableStreamReadResult<Uint8Array>\n          try {\n            next = await reader.read()\n          } catch (cause) {\n            throw new ClientError("Transport", { cause })\n          }\n          buffer += decoder.decode(next.value, { stream: !next.done })\n          if (buffer.length > 1_048_576) throw new ClientError("MalformedResponse")\n          const trailingCarriageReturn = !next.done && buffer.endsWith("\\r")\n          if (trailingCarriageReturn) buffer = buffer.slice(0, -1)\n          buffer = buffer.replaceAll("\\r\\n", "\\n").replaceAll("\\r", "\\n")\n          if (trailingCarriageReturn) buffer += "\\r"\n          if (next.done && buffer !== "") buffer += "\\n\\n"\n          let boundary = buffer.indexOf("\\n\\n")\n          while (boundary >= 0) {\n            const block = buffer.slice(0, boundary)\n            buffer = buffer.slice(boundary + 2)\n            const data = block.split("\\n").flatMap((line) => line.startsWith("data:") ? [line.slice(5).trimStart()] : []).join("\\n")\n            if (data !== "") {\n              try {\n                yield JSON.parse(data) as A\n              } catch (cause) {\n                throw new ClientError("MalformedResponse", { cause })\n              }\n            }\n            boundary = buffer.indexOf("\\n\\n")\n          }\n          if (next.done) return\n        }\n      } finally {\n        try {\n          await reader.cancel()\n        } catch {}\n        reader.releaseLock()\n      }\n    },\n  })\n\n  return { ${fields.join(", ")} }\n}\n\nfunction appendQuery(params: URLSearchParams, key: string, value: unknown): void {\n  if (value === undefined || value === null) return\n  if (Array.isArray(value)) {\n    for (const item of value) appendQuery(params, key, item)\n    return\n  }\n  if (typeof value === "object") {\n    for (const [child, item] of Object.entries(value)) appendQuery(params, \`\${key}[\${child}]\`, item)\n    return\n  }\n  params.append(key, String(value))\n}\n\nasync function json(response: Response): Promise<unknown> {\n  if (!isContentType(response, "application/json") && !response.headers.get("content-type")?.includes("+json")) {\n    try {\n      await response.body?.cancel()\n    } catch {}\n    throw new ClientError("UnsupportedContentType")\n  }\n  let text: string\n  try {\n    text = await response.text()\n  } catch (cause) {\n    throw new ClientError("Transport", { cause })\n  }\n  if (text === "") throw new ClientError("MalformedResponse")\n  try {\n    return JSON.parse(text)\n  } catch (cause) {\n    throw new ClientError("MalformedResponse", { cause })\n  }\n}\n\nfunction isContentType(response: Response, expected: string) {\n  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected\n}\n`
  })
}

function promiseTypePrefix(group: string, endpoint: string) {
  return `${identifierPart(group)}${identifierPart(endpoint)}`
}

function clientEndpointName(name: string) {
  return name.slice(name.lastIndexOf(".") + 1)
}

function identifierPart(value: string) {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("")
}

function structuralType(schema: Schema.Top): Result.Result<string, GenerationError> {
  const document = SchemaRepresentation.toCodeDocument(SchemaRepresentation.toRepresentations([schema.ast]))
  if (
    document.artifacts.some(
      (artifact) =>
        artifact._tag !== "Import" || artifact.importDeclaration !== 'import type * as Brand from "effect/Brand"',
    ) ||
    Object.keys(document.references.recursives).length > 0
  ) {
    return failGeneration("Referenced Promise types are not implemented")
  }
  const references = MutableHashMap.fromIterable(
    document.references.nonRecursives.map((reference) => [reference.$ref, reference.code.Type] as const),
  )
  const expand = (type: string, seen = HashSet.empty<string>()): Result.Result<string, GenerationError> =>
    Result.gen(function* () {
      let expanded = type
      for (const [reference, value] of references) {
        const pattern = `(?<![A-Za-z0-9_$.'"])${reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$.'"])`
        if (!new RegExp(pattern).test(expanded)) continue
        if (HashSet.has(seen, reference)) {
          return yield* failGeneration(`Recursive Promise types are not implemented: ${reference}`)
        }
        expanded = expanded.replace(new RegExp(pattern, "g"), `(${yield* expand(value, HashSet.add(seen, reference))})`)
      }
      return expanded
    })
  return Result.map(expand(document.codes[0].Type), (type) =>
    type.replaceAll(/ & Brand\.Brand<"[^"]+">/g, "").replaceAll("Schema.Json", "JsonValue"),
  )
}

function promisePath(path: string, input: ReadonlyArray<InputField>): Result.Result<string, GenerationError> {
  if (path.includes("*")) return failGeneration(`Unsupported Promise path wildcard: ${path}`)
  const fields = HashSet.fromIterable(input.filter((field) => field.source === "params").map((field) => field.name))
  const segments = path.split(/(:[A-Za-z_][A-Za-z0-9_]*)/g).filter(Boolean)
  return Result.map(
    forEachResult(segments, (segment) => {
      if (!segment.startsWith(":")) return Result.succeed(segment.replaceAll("`", "\\`"))
      const name = segment.slice(1)
      if (!HashSet.has(fields, name)) return failGeneration(`Missing path parameter: ${name}`)
      return Result.succeed(`\${encodeURIComponent(input.${name})}`)
    }),
    (template) => `\`${template.join("")}\``,
  )
}

function uniqueModule(base: string, index: number, modules: MutableHashSet.MutableHashSet<string>) {
  if (!MutableHashSet.has(modules, base.toLowerCase())) return base
  const seed = `${base}-${index}`
  let suffix = 0
  while (MutableHashSet.has(modules, `${seed}${suffix === 0 ? "" : `-${suffix}`}`.toLowerCase())) suffix++
  return `${seed}${suffix === 0 ? "" : `-${suffix}`}`
}

function optionalTransport(
  schema: Schema.Top | undefined,
  source: InputField["source"],
  endpoint: HttpApiEndpoint.Top,
  operation: string,
): Result.Result<Option.Option<Transport>, GenerationError> {
  if (schema === undefined) return Result.succeedNone
  return Result.map(normalizeTransport(schema, source, endpoint, operation), Option.some)
}

function transportSchema(transport: Option.Option<Transport>) {
  return Option.getOrUndefined(Option.map(transport, (item) => item.schema))
}

function normalizeTransport(
  schema: Schema.Top,
  source: InputField["source"] | "success" | "error",
  endpoint: HttpApiEndpoint.Top,
  operation: string,
): Result.Result<Transport, GenerationError> {
  if (isStreamSchema(schema)) return Result.succeed({ schema, effectPortable: true })
  if (!metadataPortable(schema.ast, MutableHashSet.empty())) {
    return failGeneration(`Unportable schema: ${operation}.${source}`)
  }
  const decoded = Schema.toType(schema)
  if (!isPathInput(endpoint.path)) return failGeneration(`Invalid endpoint path: ${operation}`)
  const normalized =
    source === "params"
      ? HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
          params: decoded,
          success: Schema.String,
        }).params
      : source === "query"
        ? HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
            query: decoded,
            success: Schema.String,
          }).query
        : source === "headers"
          ? HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
              headers: decoded,
              success: Schema.String,
            }).headers
          : source === "payload"
            ? HttpMethod.hasBody(endpoint.method)
              ? Array.from(
                  HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
                    payload: decoded,
                    success: Schema.String,
                  }).payload.values(),
                )[0]?.schemas[0]
              : Schema.toCodecStringTree(decoded)
            : source === "success"
              ? Array.from(
                  HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
                    success: decoded,
                  }).success,
                )[0]
              : Array.from(
                  HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
                    success: Schema.String,
                    error: decoded,
                  }).error,
                )[0]
  if (normalized === undefined) return failGeneration(`Unportable schema: ${operation}.${source}`)
  if (!sameEncoding(schema.ast, normalized.ast)) return Result.succeed({ schema, effectPortable: false })
  return Result.succeed({ schema: decoded, effectPortable: true })
}

function isPathInput(path: string): path is HttpRouter.PathInput {
  return path === "*" || path.startsWith("/")
}

function sameEncoding(left: SchemaAST.AST, right: SchemaAST.AST): boolean {
  if (left._tag !== right._tag || left.encoding?.length !== right.encoding?.length) return false
  if (
    left.encoding?.some((link, index) => {
      const other = right.encoding?.[index]
      return other === undefined || link.transformation !== other.transformation || !sameEncoding(link.to, other.to)
    })
  )
    return false
  if (!sameChecks(left.checks, right.checks) || !sameContext(left.context, right.context)) return false
  if (SchemaAST.isSuspend(left) && SchemaAST.isSuspend(right)) return sameEncoding(left.thunk(), right.thunk())
  if (SchemaAST.isUnion(left) && SchemaAST.isUnion(right)) {
    return (
      left.types.length === right.types.length &&
      left.types.every((ast, index) => sameEncoding(ast, right.types[index]))
    )
  }
  if (SchemaAST.isArrays(left) && SchemaAST.isArrays(right)) {
    return (
      left.elements.length === right.elements.length &&
      left.rest.length === right.rest.length &&
      left.elements.every((ast, index) => sameEncoding(ast, right.elements[index])) &&
      left.rest.every((ast, index) => sameEncoding(ast, right.rest[index]))
    )
  }
  if (SchemaAST.isObjects(left) && SchemaAST.isObjects(right)) {
    return (
      left.propertySignatures.length === right.propertySignatures.length &&
      left.indexSignatures.length === right.indexSignatures.length &&
      left.propertySignatures.every((field, index) => sameEncoding(field.type, right.propertySignatures[index].type)) &&
      left.indexSignatures.every(
        (field, index) =>
          sameEncoding(field.parameter, right.indexSignatures[index].parameter) &&
          sameEncoding(field.type, right.indexSignatures[index].type),
      )
    )
  }
  return true
}

function sameChecks(left: SchemaAST.Checks | undefined, right: SchemaAST.Checks | undefined): boolean {
  if (left?.length !== right?.length) return false
  if (left === undefined || right === undefined) return true
  return left.every((check, index) => {
    const other = right[index]
    if (other === undefined || check._tag !== other._tag) return false
    if (check._tag === "Filter" && other._tag === "Filter") {
      return check.run === other.run && check.aborted === other.aborted
    }
    return check._tag === "FilterGroup" && other._tag === "FilterGroup" && sameChecks(check.checks, other.checks)
  })
}

function sameContext(left: SchemaAST.Context | undefined, right: SchemaAST.Context | undefined) {
  return left?.isOptional === right?.isOptional && left?.isMutable === right?.isMutable
}

export function write(
  output: Output,
  directory: string,
): Effect.Effect<void, GenerationError | PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const paths = MutableHashSet.empty<string>()
    const normalizedPaths = MutableHashSet.empty<string>()
    for (const file of output.files) {
      if (!isSafeOutputPath(file.path))
        return yield* new GenerationError({ reason: `Unsafe output path: ${file.path}` })
      const path = file.path.toLowerCase()
      if (MutableHashSet.has(normalizedPaths, path))
        return yield* new GenerationError({ reason: `Duplicate output path: ${file.path}` })
      MutableHashSet.add(normalizedPaths, path)
      MutableHashSet.add(paths, file.path)
    }
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(directory, { recursive: true })
    const manifest = join(directory, manifestName)
    const previous = (yield* fs.exists(manifest))
      ? yield* fs.readFileString(manifest).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Manifest)),
          Effect.mapError(() => new GenerationError({ reason: `Invalid generated file manifest: ${manifest}` })),
        )
      : []
    if (previous.some((path) => !isSafeOutputPath(path))) {
      return yield* new GenerationError({ reason: `Invalid generated file manifest: ${manifest}` })
    }
    yield* Effect.forEach(
      previous.filter((path) => !MutableHashSet.has(paths, path)),
      (path) => fs.remove(join(directory, path), { force: true }),
      { concurrency: 8, discard: true },
    )
    yield* Effect.forEach(
      output.files,
      (file) =>
        fs.exists(join(directory, file.path)).pipe(
          Effect.flatMap((exists) => (exists ? fs.stat(join(directory, file.path)) : Effect.succeed(undefined))),
          Effect.flatMap((info) =>
            info?.type === "SymbolicLink"
              ? new GenerationError({ reason: `Unsafe output path: ${file.path}` })
              : Effect.void,
          ),
        ),
      { concurrency: 8, discard: true },
    )
    yield* Effect.forEach(
      output.files,
      (file) =>
        Effect.tryPromise({
          try: () => format(file.content, { filepath: file.path, parser: "typescript", semi: false, printWidth: 120 }),
          catch: (error) => new GenerationError({ reason: `Failed to format ${file.path}: ${String(error)}` }),
        }).pipe(Effect.flatMap((content) => fs.writeFileString(join(directory, file.path), content))),
      { concurrency: 8, discard: true },
    )
    const content = yield* Schema.encodeEffect(Manifest)(output.files.map((file) => file.path).sort()).pipe(
      Effect.orDie,
    )
    return yield* fs.writeFileString(manifest, content + "\n")
  })
}

function isSafeOutputPath(path: string) {
  return path !== manifestName && !isAbsolute(path) && path !== "." && path !== ".." && !/[\\/]/.test(path)
}

export function generate<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  options: { readonly directory: string },
): Effect.Effect<void, GenerationError | PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.try({
    try: () => Result.flatMap(compileResult(api), emitEffectResult),
    catch: (error) => new GenerationError({ reason: String(error) }),
  }).pipe(
    Effect.flatMap(Effect.fromResult),
    Effect.flatMap((output) => write(output, options.directory)),
  )
}

function inputFields(
  transport: Option.Option<Transport>,
  source: InputField["source"],
  operation: string,
): Result.Result<Array<InputField & { readonly optional: boolean }>, GenerationError> {
  if (Option.isNone(transport)) return Result.succeed([])
  const ast = Schema.toType(transport.value.schema).ast
  if (!SchemaAST.isObjects(ast) || ast.indexSignatures.length > 0) {
    return failGeneration(`Input schema must be a struct: ${operation}.${source}`)
  }
  return forEachResult(ast.propertySignatures, (field) =>
    typeof field.name === "string"
      ? Result.succeed({ name: field.name, source, optional: SchemaAST.isOptional(field.type) })
      : failGeneration(`Input field must have a string name: ${operation}.${source}`),
  )
}

function responseSchemas(
  schema: Schema.Top,
  path: string,
): Result.Result<Array<readonly [string, Schema.Top]>, GenerationError> {
  if (HttpApiSchema.isNoContent(schema.ast)) return Result.succeed([])
  if (!isStreamSchema(schema)) return Result.succeed([[path, schema]])
  if (schema._tag === "StreamUint8Array") return Result.succeed([])
  const value = schema.sseMode === "data" ? streamDataSchema(schema) : Result.succeed(streamEventsSchema(schema))
  return Result.map(value, (value) => [
    [`${path}.${schema.sseMode}`, value],
    [`${path}.error`, schema.error],
  ])
}

function schemaPortable(schema: Schema.Top, portable: MutableHashMap.MutableHashMap<SchemaAST.AST, boolean>): boolean {
  const visiting = MutableHashSet.empty<SchemaAST.AST>()
  const declaredError = declaredErrorFields(schema)
  const visit = (ast: SchemaAST.AST): boolean => {
    const cached = MutableHashMap.get(portable, ast)
    if (Option.isSome(cached)) return cached.value
    if (MutableHashSet.has(visiting, ast)) return true
    MutableHashSet.add(visiting, ast)
    const result = visitCurrent(ast)
    MutableHashSet.remove(visiting, ast)
    MutableHashMap.set(portable, ast, result)
    return result
  }
  const visitCurrent = (ast: SchemaAST.AST): boolean => {
    if (!annotationsPortable(ast.annotations)) return false
    if (!checksPortable(ast.checks) || ("encodingChecks" in ast && !checksPortable(ast.encodingChecks))) return false
    if (SchemaAST.isDeclaration(ast)) {
      return typeof ast.annotations?.toCode === "function" && ast.typeParameters.every(visit)
    }
    if (ast.encoding !== undefined && ast.annotations?.toCode === undefined) return false
    if (SchemaAST.isSuspend(ast)) return visit(ast.thunk())
    if (SchemaAST.isUnion(ast)) return ast.types.every(visit)
    if (SchemaAST.isArrays(ast)) {
      return ast.elements.every(visit) && ast.rest.every(visit)
    }
    if (SchemaAST.isObjects(ast)) {
      return (
        ast.propertySignatures.every((field) => visit(field.type)) &&
        ast.indexSignatures.every((index) => visit(index.parameter) && visit(index.type))
      )
    }
    if (SchemaAST.isTemplateLiteral(ast)) return ast.parts.every(visit)
    return true
  }
  if (declaredError !== undefined && SchemaAST.isDeclaration(schema.ast)) {
    return !(
      schema.ast.checks !== undefined ||
      ("encodingChecks" in schema.ast && !checksPortable(schema.ast.encodingChecks)) ||
      schema.ast.typeParameters.some((ast) => ast.checks !== undefined) ||
      !schema.ast.typeParameters.every(visit)
    )
  }
  return codeDocumentPortable(schema) && visit(schema.ast)
}

function checksPortable(checks: SchemaAST.Checks | undefined): boolean {
  if (checks === undefined) return true
  return checks.every((check) =>
    check._tag === "Filter"
      ? !check.aborted && representationPortable(check.annotations?.representation)
      : checksPortable(check.checks),
  )
}

function representationPortable(value: unknown): boolean {
  if (!Predicate.isObjectOrArray(value) || !("id" in value)) return false
  const id = value.id
  return typeof id === "string" && id.startsWith("effect/schema/")
}

function metadataPortable(ast: SchemaAST.AST, seen: MutableHashSet.MutableHashSet<SchemaAST.AST>): boolean {
  if (MutableHashSet.has(seen, ast)) return true
  MutableHashSet.add(seen, ast)
  if (!annotationsPortable(ast.annotations) || !checksPortable(ast.checks)) return false
  if ("encodingChecks" in ast && !checksPortable(ast.encodingChecks)) return false
  if (ast.encoding?.some((link) => !metadataPortable(link.to, seen))) return false
  if (SchemaAST.isDeclaration(ast)) return ast.typeParameters.every((item) => metadataPortable(item, seen))
  if (SchemaAST.isSuspend(ast)) return metadataPortable(ast.thunk(), seen)
  if (SchemaAST.isUnion(ast)) return ast.types.every((item) => metadataPortable(item, seen))
  if (SchemaAST.isArrays(ast)) {
    return (
      ast.elements.every((item) => metadataPortable(item, seen)) &&
      ast.rest.every((item) => metadataPortable(item, seen))
    )
  }
  if (SchemaAST.isObjects(ast)) {
    return (
      ast.propertySignatures.every((field) => metadataPortable(field.type, seen)) &&
      ast.indexSignatures.every(
        (field) => metadataPortable(field.parameter, seen) && metadataPortable(field.type, seen),
      )
    )
  }
  return true
}

function generationPortable(generation: unknown): boolean {
  if (!Predicate.isObject(generation)) return false
  const runtime = generation.runtime
  if (typeof runtime !== "string" || (generation.Type !== undefined && typeof generation.Type !== "string")) {
    return false
  }
  const imports = [
    ...(generation.importDeclaration === undefined ? [] : [generation.importDeclaration]),
    ...(Array.isArray(generation.importDeclarations) ? generation.importDeclarations : []),
  ]
  if (imports.some((item) => typeof item !== "string" || !/from ["']effect(?:\/[^"']+)?["']$/.test(item))) {
    return false
  }
  const namespaces = imports.flatMap((item) => {
    if (typeof item !== "string") return []
    const namespace = /import(?: type)? \* as ([A-Za-z_$][\w$]*)/.exec(item)?.[1]
    return namespace === undefined ? [] : [namespace]
  })
  return runtime.startsWith("Schema.") || namespaces.some((namespace) => runtime.startsWith(`${namespace}.`))
}

function codeDocumentPortable(schema: Schema.Top): boolean {
  try {
    const document = SchemaRepresentation.toCodeDocument(SchemaRepresentation.toRepresentations([schema.ast]))
    const imports = document.artifacts.flatMap((artifact) =>
      artifact._tag === "Import" ? [artifact.importDeclaration] : [],
    )
    if (imports.some((item) => !/from ["']effect(?:\/[^"']+)?["']$/.test(item))) return false
    const namespaces = imports.flatMap((item) => {
      const namespace = /import(?: type)? \* as ([A-Za-z_$][\w$]*)/.exec(item)?.[1]
      return namespace === undefined ? [] : [namespace]
    })
    const references = HashSet.fromIterable([
      ...document.references.nonRecursives.map((reference) => reference.$ref),
      ...Object.keys(document.references.recursives),
      ...document.artifacts.flatMap((artifact) => (artifact._tag === "Import" ? [] : [artifact.identifier])),
    ])
    const portable = (runtime: string) =>
      runtime.startsWith("Schema.") ||
      HashSet.has(references, runtime) ||
      Array.from(references).some((reference) => runtime.startsWith(`${reference}.`)) ||
      namespaces.some((namespace) => runtime.startsWith(`${namespace}.`))
    return [
      ...document.codes,
      ...document.references.nonRecursives.map((reference) => reference.code),
      ...Object.values(document.references.recursives),
    ].every((code) => portable(code.runtime))
  } catch {
    return false
  }
}

function annotationsPortable(annotations: Schema.Annotations.Annotations | undefined) {
  if (annotations === undefined) return true
  return Object.entries(annotations).every(([key, value]) => {
    if (
      [
        "toCodec",
        "toCodecJson",
        "toCodecStringTree",
        "toCodecIso",
        "toCodecArbitrary",
        "toArbitrary",
        "toFormatter",
        "toEquivalence",
        "toCode",
        "~constructor",
        "~effect/Schema/Class",
      ].includes(key)
    ) {
      return true
    }
    if (key === "generation") return generationPortable(value)
    return serializable(value)
  })
}

function serializable(value: unknown): boolean {
  if (Predicate.isNull(value) || ["string", "number", "boolean"].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(serializable)
  if (typeof value !== "object") return false
  return Object.values(value).every(serializable)
}

function declaredErrorFields(schema: Schema.Top) {
  if (!SchemaAST.isDeclaration(schema.ast) || typeof schema.ast.annotations?.["~constructor"] !== "function") {
    return undefined
  }
  const fields = schema.ast.typeParameters[0]
  if (!SchemaAST.isObjects(fields) || fields.indexSignatures.length > 0) return undefined
  const key = fields.propertySignatures.find((field) => field.name === "_tag" || field.name === "name")?.name
  if (key !== "_tag" && key !== "name") return undefined
  const tag = fields.propertySignatures.find((field) => field.name === key)?.type
  if (tag === undefined || !SchemaAST.isLiteral(tag) || typeof tag.literal !== "string") return undefined
  return {
    key,
    tag: tag.literal,
    identifier: SchemaAST.resolveIdentifier(schema.ast) ?? tag.literal,
    fields: fields.propertySignatures.flatMap((field) =>
      field.name === key || typeof field.name !== "string"
        ? []
        : [[field.name, Schema.make<Schema.Top>(field.type), SchemaAST.isOptional(field.type)] as const],
    ),
  }
}

function isDataEnvelope(schema: Schema.Top) {
  if (isStreamSchema(schema) || HttpApiSchema.isNoContent(schema.ast)) return false
  const ast = Schema.toType(schema).ast
  return (
    SchemaAST.isObjects(ast) &&
    ast.indexSignatures.length === 0 &&
    ast.propertySignatures.length === 1 &&
    ast.propertySignatures[0]?.name === "data"
  )
}

function isStreamSchema(schema: Schema.Top): schema is HttpApiSchema.StreamSchema {
  return "_tag" in schema && (schema._tag === "StreamSse" || schema._tag === "StreamUint8Array")
}

function streamDataSchema(schema: SseStreamSchema): Result.Result<Schema.Top, GenerationError> {
  if (!("fields" in schema.events) || !Predicate.isObjectOrArray(schema.events.fields)) {
    return failGeneration("Invalid SSE data schema")
  }
  const data = Reflect.get(schema.events.fields, "data")
  if (!Schema.isSchema(data) || !("to" in data) || !Schema.isSchema(data.to)) {
    return failGeneration("Invalid SSE data schema")
  }
  return Result.succeed(data.to)
}

function streamEventsSchema(schema: SseStreamSchema) {
  return Schema.make<Schema.Top>(schema.events.ast)
}

function streamEncodedDataSchema(schema: SseStreamSchema) {
  return Result.map(streamDataSchema(schema), (data) => Schema.toEncoded(data))
}

function streamEffectPortable(schema: Schema.Top): Result.Result<boolean, GenerationError> {
  if (!isStreamSchema(schema) || schema._tag === "StreamUint8Array" || schema.sseMode === "events") {
    return Result.succeed(true)
  }
  return Result.map(streamDataSchema(schema), (data) => !hasEncoding(data.ast, MutableHashSet.empty()))
}

function hasEncoding(ast: SchemaAST.AST, seen: MutableHashSet.MutableHashSet<SchemaAST.AST>): boolean {
  if (MutableHashSet.has(seen, ast)) return false
  MutableHashSet.add(seen, ast)
  if (ast.encoding !== undefined) return true
  if (SchemaAST.isDeclaration(ast)) return ast.typeParameters.some((item) => hasEncoding(item, seen))
  if (SchemaAST.isSuspend(ast)) return hasEncoding(ast.thunk(), seen)
  if (SchemaAST.isUnion(ast)) return ast.types.some((item) => hasEncoding(item, seen))
  if (SchemaAST.isArrays(ast)) {
    return [...ast.elements, ...ast.rest].some((item) => hasEncoding(item, seen))
  }
  if (SchemaAST.isObjects(ast)) {
    return (
      ast.propertySignatures.some((field) => hasEncoding(field.type, seen)) ||
      ast.indexSignatures.some((field) => hasEncoding(field.parameter, seen) || hasEncoding(field.type, seen))
    )
  }
  if (SchemaAST.isTemplateLiteral(ast)) return ast.parts.some((item) => hasEncoding(item, seen))
  return false
}

function renderGroup(group: Group, groupIndex: number): Result.Result<string, GenerationError> {
  let slots = Chunk.empty<Slot>()

  function addSlot(schema: Schema.Top | undefined, name: string) {
    if (schema === undefined) return undefined
    const slot = { name, schema }
    slots = Chunk.append(slots, slot)
    return slot
  }

  function renderSuccess(
    schema: Schema.Top,
    name: string,
  ): Result.Result<{ readonly source: string; readonly streamError?: Slot }, GenerationError> {
    if (!isStreamSchema(schema)) return Result.succeed({ source: addSlot(schema, name)!.name })
    const status = resolveHttpApiStatus(schema.ast) ?? 200
    const annotate = status === 200 ? "" : `.pipe(HttpApiSchema.status(${status}))`
    if (schema._tag === "StreamUint8Array") {
      return Result.succeed({
        source: `HttpApiSchema.StreamUint8Array({ contentType: ${encodeJsonString(schema.contentType)} })${annotate}`,
      })
    }
    const valueSchema =
      schema.sseMode === "data" ? streamDataSchema(schema) : Result.succeed(streamEventsSchema(schema))
    return Result.map(valueSchema, (valueSchema) => {
      const value = addSlot(valueSchema, `${name}${schema.sseMode === "data" ? "Data" : "Events"}`)!
      const error = addSlot(schema.error, `${name}Error`)!
      return {
        source: `HttpApiSchema.StreamSse({ ${schema.sseMode}: ${value.name}, error: ${error.name}, contentType: ${encodeJsonString(schema.contentType)} })${annotate}`,
        streamError: error,
      }
    })
  }

  return Result.gen(function* () {
    const renderedEndpoints = yield* forEachResult(group.endpoints, (operation, endpointIndex) =>
      Result.gen(function* () {
        const {
          endpoint,
          errors,
          headers: endpointHeaders,
          params: endpointParams,
          payloads: endpointPayloads,
          query: endpointQuery,
          successes,
        } = operation
        const prefix = `Endpoint${endpointIndex}`
        const params = addSlot(endpointParams, `${prefix}Params`)
        const query = addSlot(endpointQuery, `${prefix}Query`)
        const headers = addSlot(endpointHeaders, `${prefix}Headers`)
        const payloads = endpointPayloads.map((schema, index) => addSlot(schema, `${prefix}Payload${index}`)!)
        const success = yield* renderSuccess(successes[0], `${prefix}Success`)
        const errorSlots = errors.map((error, index) => addSlot(error.schema, `${prefix}Error${index}`)!)
        const options = [
          params === undefined ? undefined : `params: ${params.name}`,
          query === undefined ? undefined : `query: ${query.name}`,
          headers === undefined ? undefined : `headers: ${headers.name}`,
          payloads.length === 0
            ? undefined
            : `payload: ${payloads.length === 1 ? payloads[0].name : `[${payloads.map((slot) => slot.name).join(", ")}]`}`,
          `success: ${success.source}`,
          errorSlots.length === 0
            ? undefined
            : `error: ${errorSlots.length === 1 ? errorSlots[0].name : `[${errorSlots.map((slot) => slot.name).join(", ")}]`}`,
        ].filter((option): option is string => option !== undefined)
        const schemaBySource = { params, query, headers, payload: payloads[0] }
        const inputType = (yield* forEachResult(operation.input, (field) => {
          const slot = schemaBySource[field.source]
          if (slot === undefined) {
            return failGeneration(`Missing input schema: ${group.identifier}.${endpoint.identifier}`)
          }
          return Result.succeed(
            `readonly ${encodeJsonString(field.name)}${field.optional ? "?" : ""}: (typeof ${slot.name}.Type)[${encodeJsonString(field.name)}]`,
          )
        })).join("; ")
        const argument =
          operation.operation.inputMode === "none"
            ? ""
            : `input${operation.operation.inputMode === "optional" ? "?" : ""}: ${prefix}Input`
        const request = (["params", "query", "headers", "payload"] as const)
          .flatMap((source) => {
            const slot = schemaBySource[source]
            if (slot === undefined) return []
            const fields = operation.input
              .filter((field) => field.source === source)
              .map(
                (field) =>
                  `${encodeJsonString(field.name)}: input${operation.operation.inputMode === "optional" ? "?." : ""}[${encodeJsonString(field.name)}]`,
              )
            return [`${source}: { ${fields.join(", ")} }`]
          })
          .join(", ")
        const declared = [...errorSlots, ...(success.streamError === undefined ? [] : [success.streamError])]
        const declaredSchema =
          declared.length === 0 ? "Schema.Never" : `Schema.Union([${declared.map((slot) => slot.name).join(", ")}])`
        const rawCall = `raw[${encodeJsonString(endpoint.identifier)}]({ ${request} })`
        const mapped = `${rawCall}.pipe(Effect.mapError(map${prefix}Error)${operation.unwrapData ? ", Effect.map((value) => value.data)" : ""})`
        const inputDeclaration =
          operation.operation.inputMode === "none" ? "" : `type ${prefix}Input = { ${inputType} }\n`
        const adapter = `${inputDeclaration}const ${prefix}DeclaredError = ${declaredSchema}\nconst map${prefix}Error = (error: unknown) => HttpClientError.isHttpClientError(error) || Schema.isSchemaError(error) || Sse.Retry.is(error) ? new ClientError({ cause: error }) : Schema.is(${prefix}DeclaredError)(error) ? error : new ClientError({ cause: error })\nconst ${prefix} = (raw: RawGroup) => (${argument}) => ${operation.operation.success === "stream" ? `Stream.unwrap(${rawCall}.pipe(Effect.mapError(map${prefix}Error), Effect.map((stream) => stream.pipe(Stream.mapError(map${prefix}Error)))))` : mapped}`
        return {
          source: `HttpApiEndpoint.make(${encodeJsonString(endpoint.method)})(${encodeJsonString(endpoint.identifier)}, ${encodeJsonString(endpoint.path)}, { ${options.join(", ")} })`,
          adapter,
        }
      }),
    )

    const declarations = renderSchemas(Chunk.toReadonlyArray(slots))
    const groupSource = `HttpApiGroup.make(${encodeJsonString(group.identifier)}, { topLevel: ${group.endpoints[0]?.topLevel ?? false} })${renderedEndpoints.map((endpoint) => `.add(${endpoint.source})`).join("")}`
    const usesHttpApiSchema = renderedEndpoints.some((endpoint) => endpoint.source.includes("HttpApiSchema."))
    const methods = group.endpoints
      .map((item, index) => `${encodeJsonString(item.operation.name)}: Endpoint${index}(raw)`)
      .join(", ")
    const rawGroup = group.endpoints[0]?.topLevel
      ? `HttpApiClient.Client<typeof Group${groupIndex}>`
      : `HttpApiClient.Client.Group<typeof Group${groupIndex}, never, never>`
    const usesStream = group.endpoints.some((item) => item.operation.success === "stream")
    return `// Generated by @opencode-ai/httpapi-codegen. Do not edit.\nimport { Effect, Schema${usesStream ? ", Stream" : ""} } from "effect"\nimport { Sse } from "effect/unstable/encoding"\nimport { HttpClientError } from "effect/unstable/http"\nimport { HttpApiClient, HttpApiEndpoint, HttpApiGroup${usesHttpApiSchema ? ", HttpApiSchema" : ""} } from "effect/unstable/httpapi"\nimport { ClientError } from "./client-error"\n\n${declarations}\n\nexport const Group${groupIndex} = ${groupSource}\n\ntype RawGroup = ${rawGroup}\n\n${renderedEndpoints.map((endpoint) => endpoint.adapter).join("\n\n")}\n\nexport const adaptGroup${groupIndex} = (raw: RawGroup) => ({ ${methods} })\n`
  })
}

function renderSchemas(slots: ReadonlyArray<Slot>) {
  if (slots.length === 0) return ""
  const classes = slots.map((slot) => Option.fromNullishOr(declaredErrorFields(slot.schema)))
  const expanded = [
    ...slots.map((slot, index) => (Option.isSome(classes[index]) ? { name: slot.name, schema: Schema.Never } : slot)),
    ...Arr.getSomes(classes).flatMap((declared, classIndex) =>
      declared.fields.map(([name, schema]) => ({ name: `Class${classIndex}${name}`, schema })),
    ),
  ]
  const [first, ...rest] = expanded
  const document = SchemaRepresentation.toCodeDocument(
    SchemaRepresentation.toRepresentations([first.schema.ast, ...rest.map((slot) => slot.schema.ast)]),
  )
  const artifacts = document.artifacts.flatMap((artifact) => {
    if (artifact._tag === "Import") return [artifact.importDeclaration]
    if (artifact._tag === "Enum") return [artifact.code.runtime]
    return [`const ${artifact.identifier} = ${artifact.code.runtime}`]
  })
  const references = [
    ...document.references.nonRecursives.map(({ $ref, code }) => `const ${$ref} = ${code.runtime}`),
    ...Object.entries(document.references.recursives).map(
      ([$ref, code]) => `type ${$ref} = ${code.Type}\nconst ${$ref}: Schema.Codec<${$ref}> = ${code.runtime}`,
    ),
  ]
  let fieldIndex = slots.length
  const declarations = slots.map((slot, index) => {
    const slotClass = classes[index]
    if (Option.isNone(slotClass)) return `const ${slot.name} = ${document.codes[index].runtime}`
    const declared = slotClass.value
    const fields = declared.fields
      .map(([name]) => `${encodeJsonString(name)}: ${document.codes[fieldIndex++].runtime}`)
      .join(", ")
    const annotations = Object.entries({
      httpApiStatus: resolveHttpApiStatus(slot.schema.ast),
      "~httpApiEncoding": resolveHttpApiEncoding(slot.schema.ast),
    }).filter((entry) => entry[1] !== undefined)
    const annotate =
      annotations.length === 0
        ? ""
        : `.annotate({ ${annotations.map(([key, value]) => `${encodeJsonString(key)}: ${encodeJsonValue(value)}`).join(", ")} })`
    const source =
      declared.key === "_tag"
        ? `Schema.TaggedError<${slot.name}Class>(${encodeJsonString(declared.identifier)})(${encodeJsonString(declared.tag)}, { ${fields} })`
        : `Schema.Error<${slot.name}Class>(${encodeJsonString(declared.identifier)})({ "name": Schema.Literal(${encodeJsonString(declared.tag)})${fields === "" ? "" : `, ${fields}`} })`
    return `class ${slot.name}Class extends ${source} {}\nconst ${slot.name} = ${slot.name}Class${annotate}`
  })
  return [...artifacts, ...references, ...declarations].join("\n\n")
}

function renderClient(groups: ReadonlyArray<Group>) {
  const imports = groups
    .map((group, index) => `import { adaptGroup${index}, Group${index} } from ${encodeJsonString(`./${group.module}`)}`)
    .join("\n")
  const api = `HttpApi.make("generated")${groups.map((_, index) => `.add(Group${index})`).join("")}`
  const fields = groups.flatMap((group, index) => {
    if (!group.endpoints[0]?.topLevel) {
      return [`${encodeJsonString(group.identifier)}: adaptGroup${index}(raw[${encodeJsonString(group.identifier)}])`]
    }
    const raw = `{ ${group.endpoints.map((item) => `${encodeJsonString(item.endpoint.identifier)}: raw[${encodeJsonString(item.endpoint.identifier)}]`).join(", ")} }`
    return [`...adaptGroup${index}(${raw})`]
  })
  return `// Generated by @opencode-ai/httpapi-codegen. Do not edit.\nimport { Effect } from "effect"\nimport { HttpApi, HttpApiClient } from "effect/unstable/httpapi"\n${imports}\n\nconst Api = ${api}\nconst adaptClient = (raw: HttpApiClient.ForApi<typeof Api>) => ({ ${fields.join(", ")} })\n\nexport const make = (options?: { readonly baseUrl?: URL | string }) =>\n  HttpApiClient.make(Api, options).pipe(Effect.map(adaptClient))\n`
}
