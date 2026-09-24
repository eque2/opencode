import { HashSet, Option } from "effect"
import { HttpClient, HttpMethod } from "effect/unstable/http"
import { isDefinition, make, type Definition } from "../tool.js"
import { invoke } from "./runtime.js"
import {
  componentDefinitions,
  inputSchema,
  isRecord,
  methods,
  nonEmptyString,
  operationInput,
  operationOutput,
  operationPath,
  operationSecurityRequirements,
  own,
  securityRequirements,
  securitySchemes,
  specServerUrl,
  validateBaseUrl,
} from "./spec.js"
import type { Operation, Options, Result, Skipped, Tools } from "./types.js"

export type {
  AuthResolver,
  Credential,
  Document,
  Operation,
  Options,
  Result,
  SecurityScheme,
  Skipped,
  Tools,
} from "./types.js"

/**
 * Builds a CodeMode tool subtree from an OpenAPI 3.x document, one tool per
 * operation. Auth is resolved host-side via `auth.resolve` and never
 * model-visible. Tools require `HttpClient.HttpClient`; unrepresentable
 * operations land in `skipped`.
 */
export const fromSpec = (options: Options): Result => {
  const document = options.spec
  const schemes = securitySchemes(document)
  const defaultSecurity = securityRequirements(document.security)
  const definitions = componentDefinitions(document)
  const paths = isRecord(document.paths) ? document.paths : {}
  let used = HashSet.empty<string>()
  let namespaces = HashSet.empty<string>()
  const skipped: Array<Skipped> = []
  const tools = emptyTools()

  for (const [path, pathValue] of Object.entries(paths)) {
    if (!isRecord(pathValue)) continue
    for (const [method, operationValue] of Object.entries(pathValue)) {
      const httpMethod = method.toUpperCase()
      if (!HashSet.has(methods, method) || !HttpMethod.isHttpMethod(httpMethod) || !isRecord(operationValue)) continue
      const segments = operationPath(method, path, operationValue, used, namespaces)
      const operation: Operation = {
        operationId: Option.getOrUndefined(nonEmptyString(operationValue.operationId)),
        method: httpMethod,
        path,
        summary: Option.getOrUndefined(nonEmptyString(operationValue.summary)),
        description: Option.getOrUndefined(nonEmptyString(operationValue.description)),
      }
      const output = operationOutput(document, operationValue, definitions)
      if (!output.ok) {
        skipped.push({ method: operation.method, path, reason: output.reason })
        continue
      }

      const resolvedBaseUrl = (() => {
        if (options.baseUrl !== undefined) return validateBaseUrl(options.baseUrl)
        if (operationValue.servers !== undefined) return specServerUrl(operationValue)
        if (pathValue.servers !== undefined) return specServerUrl(pathValue)
        return specServerUrl(document)
      })()
      if (!resolvedBaseUrl.ok) {
        skipped.push({ method: operation.method, path, reason: resolvedBaseUrl.reason })
        continue
      }
      const parsedInput = operationInput(document, pathValue, operationValue)
      if (!parsedInput.ok) {
        skipped.push({ method: operation.method, path, reason: parsedInput.reason })
        continue
      }
      const input = parsedInput.value

      const security = operationSecurityRequirements(operationValue.security, defaultSecurity, schemes)
      if (!security.ok) {
        skipped.push({ method: operation.method, path, reason: security.reason })
        continue
      }
      const plan = {
        operation,
        method: httpMethod,
        url: `${resolvedBaseUrl.value.replace(/\/+$/, "")}${path}`,
        fields: input.fields,
        body: input.body,
        security: security.value,
        schemes,
        auth: options.auth,
        headers: options.headers ?? {},
      }
      used = HashSet.add(used, segments.join("."))
      for (const index of segments.slice(0, -1).keys()) {
        namespaces = HashSet.add(namespaces, segments.slice(0, index + 1).join("."))
      }
      setTool(
        tools,
        segments,
        make({
          description: operation.description ?? operation.summary ?? `${operation.method} ${path}`,
          input: inputSchema(input.fields, definitions),
          output: Option.getOrUndefined(output.value),
          run: (input) => invoke(plan, input),
        }),
      )
    }
  }

  return { tools, skipped }
}

// Tool names come from the spec, so the tree is prototype-free: a segment such as
// `constructor` never reads an inherited member.
// eslint-disable-next-line effect/no-null-use-option -- Object.create(null) is the only platform API that builds a prototype-free object
const emptyTools = (): Tools => Object.create(null)

const setTool = (tools: Tools, path: ReadonlyArray<string>, definition: Definition<HttpClient.HttpClient>): void => {
  const [head, ...rest] = path
  if (head === undefined) return
  if (rest.length === 0) {
    tools[head] = definition
    return
  }
  const child = own(tools, head)
  if (Option.isSome(child) && !isDefinition<HttpClient.HttpClient>(child.value)) {
    setTool(child.value, rest, definition)
    return
  }
  const namespace = emptyTools()
  tools[head] = namespace
  setTool(namespace, rest, definition)
}
