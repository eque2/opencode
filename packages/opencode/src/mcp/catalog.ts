import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolSchema,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool } from "ai"
import { Array as Arr, Effect, HashSet, Option, Predicate, Schema } from "effect"

const DEFAULT_TIMEOUT = 30_000
const MAX_LIST_PAGES = 1_000

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

// Structured tool output is opaque MCP payload data; it is only relayed as JSON text.
const encodeStructuredContent = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

export class CatalogError extends Schema.TaggedError<CatalogError>()("McpCatalogError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Wrap a rejected MCP SDK call; keep the original message so logs and statuses stay readable. */
const catalogError = (cause: unknown) =>
  new CatalogError({ message: cause instanceof Error ? cause.message : String(cause), cause })

const cursorParams = (cursor: Option.Option<string>) =>
  Option.getOrUndefined(Option.map(cursor, (value) => ({ cursor: value })))

export function paginate<T, R extends { nextCursor?: string }>(
  list: (cursor: Option.Option<string>) => Effect.Effect<R, CatalogError>,
  items: (result: R) => ReadonlyArray<T>,
) {
  const step = (
    cursor: Option.Option<string>,
    seen: HashSet.HashSet<string>,
    collected: Array<T>,
    page: number,
  ): Effect.Effect<Array<T>, CatalogError> => {
    if (page >= MAX_LIST_PAGES)
      return Effect.fail(new CatalogError({ message: `MCP list exceeded ${MAX_LIST_PAGES} pages` }))
    return list(cursor).pipe(
      Effect.flatMap((result) => {
        const next = Arr.appendAll(collected, items(result))
        const nextCursor = result.nextCursor
        if (nextCursor === undefined) return Effect.succeed(next)
        if (HashSet.has(seen, nextCursor))
          return Effect.fail(new CatalogError({ message: `MCP list returned duplicate cursor: ${nextCursor}` }))
        return step(Option.some(nextCursor), HashSet.add(seen, nextCursor), next, page + 1)
      }),
    )
  }
  return step(Option.none(), HashSet.empty(), [], 0)
}

export function defs(client: Client, timeout?: number) {
  return listTools(client, timeout ?? DEFAULT_TIMEOUT).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("MCP tool list failed", { error: error.message }).pipe(
        Effect.annotateLogs({ category: "mcp.tools" }),
      ),
    ),
    Effect.option,
  )
}

export function convertTool(mcpTool: MCPToolDef, client: Client, timeout?: number): Tool {
  const inputSchema: JSONSchema7 = {
    ...(mcpTool.inputSchema as JSONSchema7),
    type: "object",
    properties: (mcpTool.inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(inputSchema),
    // The AI SDK tool contract is Promise-based, so the Effect runs once at this hook.
    execute: (args: unknown, options) =>
      Effect.runPromise(callTool(client, mcpTool.name, args, options.abortSignal, timeout)),
  })
}

const callTool = Effect.fnUntraced(function* (
  client: Client,
  name: string,
  args: unknown,
  signal: AbortSignal | undefined,
  timeout: number | undefined,
) {
  const result = yield* Effect.tryPromise({
    try: () =>
      client.callTool(
        {
          name,
          arguments: Predicate.isObject(args) ? args : {},
        },
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          signal,
          timeout,
          // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
          onprogress: () => {},
        },
      ),
    catch: catalogError,
  })
  if (result.isError)
    return yield* new CatalogError({
      message:
        result.content
          .flatMap((item) => (item.type === "text" ? [item.text] : []))
          .filter((text) => text.trim())
          .join("\n\n") || "MCP tool returned an error",
    })
  if (result.content.length > 0) return result
  const structured = Option.fromNullishOr(result.structuredContent)
  if (Option.isNone(structured)) return result
  const text = yield* encodeStructuredContent(structured.value).pipe(Effect.mapError(catalogError))
  return {
    ...result,
    content: [{ type: "text" as const, text }],
  }
})

export function fetch<T extends { name: string }>(
  clientName: string,
  client: Client,
  list: (client: Client) => Effect.Effect<Array<T>, CatalogError>,
  label: string,
  key?: (item: T) => string,
) {
  return list(client).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`failed to get ${label}`, {
        clientName,
        error: error.message,
      }),
    ),
    Effect.map((items) => {
      const sanitizedClient = sanitize(clientName)
      // Escape both the separator and escape marker so `server:uri` keys remain unambiguous.
      const resourceClient = clientName.replaceAll("%", "%25").replaceAll(":", "%3A")
      return Object.fromEntries(
        items.map((item) => [
          key ? resourceClient + ":" + key(item) : sanitizedClient + ":" + sanitize(item.name),
          { ...item, client: clientName },
        ]),
      )
    }),
    Effect.orElseSucceed((): Record<string, T & { client: string }> => ({})),
  )
}

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

export const toolName = (clientName: string, name: string) => sanitize(clientName) + "_" + sanitize(name)

export function prompts(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.prompts) return Effect.succeed([])
  return paginate(
    (cursor) =>
      Effect.tryPromise({ try: () => client.listPrompts(cursorParams(cursor), { timeout }), catch: catalogError }),
    (result) => result.prompts,
  )
}

export function resources(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Effect.succeed([])
  return paginate(
    (cursor) =>
      Effect.tryPromise({ try: () => client.listResources(cursorParams(cursor), { timeout }), catch: catalogError }),
    (result) => result.resources,
  )
}

export function resourceTemplates(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Effect.succeed([])
  return paginate(
    (cursor) =>
      Effect.tryPromise({
        try: () => client.listResourceTemplates(cursorParams(cursor), { timeout }),
        catch: catalogError,
      }),
    (result) => result.resourceTemplates,
  )
}

function listTools(client: Client, timeout: number) {
  return paginate(
    (cursor) => {
      const params = cursorParams(cursor)
      return Effect.tryPromise({ try: () => client.listTools(params, { timeout }), catch: catalogError }).pipe(
        // Some servers publish output schemas the SDK validator cannot resolve; list them without those schemas.
        Effect.catchIf(isOutputSchemaValidationError, () =>
          Effect.tryPromise({
            try: () => client.request({ method: "tools/list", params }, TolerantListToolsResultSchema, { timeout }),
            catch: catalogError,
          }),
        ),
      )
    },
    (result) => result.tools,
  )
}

function isOutputSchemaValidationError(error: CatalogError) {
  return (
    error.cause instanceof Error &&
    /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
      error.cause.message,
    )
  )
}

export * as McpCatalog from "./catalog"
