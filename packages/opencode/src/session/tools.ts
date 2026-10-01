import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Clock, Effect, Exit, HashSet, Option, Predicate, Result, Schema } from "effect"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ModelV2 } from "@opencode-ai/core/model"
import { isRecord } from "@/util/record"
import { RuntimeFlags } from "@/effect/runtime-flags"

const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024

// The AI SDK reports a rejected tool execute as a tool error, and the processor shows its message.
export class McpToolError extends Schema.TaggedError<McpToolError>()("SessionTools.McpToolError", {
  message: Schema.String,
}) {}

// Pretty JSON for the MCP resource listings that the model reads.
const encodeListing = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

// Text and file attachments that one MCP content item contributes, in content order.
type CollectedContent = {
  readonly text: ReadonlyArray<string>
  readonly attachments: ReadonlyArray<Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">>
}
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = HashSet.make(
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
)

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const flags = yield* RuntimeFlags.Service

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          input.processor.updateToolCall(options.toolCallId, (match) => {
            if (!["running", "pending"].includes(match.state.status)) return match
            return {
              ...match,
              state: {
                title: val.title,
                metadata: val.metadata,
                status: "running",
                input: args,
                time: match.state.status === "running" ? match.state.time : { start: now },
              },
            }
          }),
        ),
      ),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    permission: input.session.permission,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const result = yield* item.execute(args, ctx)
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  const hasMcpResourceServer = Object.values(yield* mcp.clients()).some(
    (client) => !!client.getServerCapabilities()?.resources,
  )
  if (hasMcpResourceServer) {
    tools[MCP_RESOURCE_TOOLS.list] = tool({
      description:
        "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "Optional MCP server name. When omitted, lists resources from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = yield* Effect.fromResult(parseListMcpResourcesArgs(args))
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (Option.isSome(parsed.server) && !resourceServers.includes(parsed.server.value)) {
              return yield* new McpToolError({
                message:
                  resourceServers.length === 0
                    ? `MCP server "${parsed.server.value}" does not support resources`
                    : `MCP server "${parsed.server.value}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              })
            }
            const serverMetadata = Option.match(parsed.server, { onNone: () => ({}), onSome: (server) => ({ server }) })
            const permissionPatterns = Option.match(parsed.server, {
              onNone: () => resourceServers.map((server) => `mcp:${server}:*`),
              onSome: (server) => [`mcp:${server}:*`],
            })
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: serverMetadata,
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const resources = Object.values(yield* mcp.resources(Option.getOrUndefined(parsed.server)))
            const filtered = resources
              .filter((resource) =>
                Option.match(parsed.server, { onNone: () => true, onSome: (server) => resource.client === server }),
              )
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uri).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uri,
                ),
              )
            const content = yield* encodeListing({ resources: filtered.map(formatMcpResource) }).pipe(Effect.orDie)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: Option.match(parsed.server, {
                onNone: () => "MCP resources",
                onSome: (server) => `MCP resources: ${server}`,
              }),
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...serverMetadata,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.listTemplates] = tool({
      description:
        "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description:
                "Optional MCP server name. When omitted, lists resource templates from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = yield* Effect.fromResult(parseListMcpResourcesArgs(args))
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (Option.isSome(parsed.server) && !resourceServers.includes(parsed.server.value)) {
              return yield* new McpToolError({
                message:
                  resourceServers.length === 0
                    ? `MCP server "${parsed.server.value}" does not support resources`
                    : `MCP server "${parsed.server.value}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              })
            }
            const serverMetadata = Option.match(parsed.server, { onNone: () => ({}), onSome: (server) => ({ server }) })
            const permissionPatterns = Option.match(parsed.server, {
              onNone: () => resourceServers.map((server) => `mcp:${server}:*`),
              onSome: (server) => [`mcp:${server}:*`],
            })
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: serverMetadata,
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const templates = Object.values(yield* mcp.resourceTemplates(Option.getOrUndefined(parsed.server)))
            const filtered = templates
              .filter((template) =>
                Option.match(parsed.server, { onNone: () => true, onSome: (server) => template.client === server }),
              )
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uriTemplate).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uriTemplate,
                ),
              )
            const content = yield* encodeListing({ resourceTemplates: filtered.map(formatMcpResourceTemplate) }).pipe(
              Effect.orDie,
            )
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: Option.match(parsed.server, {
                onNone: () => "MCP resource templates",
                onSome: (server) => `MCP resource templates: ${server}`,
              }),
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...serverMetadata,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.read] = tool({
      description:
        "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "MCP server name exactly as returned by list_mcp_resources.",
            },
            uri: {
              type: "string",
              description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
            },
          },
          required: ["server", "uri"],
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = yield* Effect.fromResult(parseReadMcpResourceArgs(args))
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const client = clients[parsed.server]
            if (!client) {
              return yield* new McpToolError({ message: `MCP server "${parsed.server}" is not connected` })
            }
            if (!client.getServerCapabilities()?.resources) {
              return yield* new McpToolError({
                message: `MCP server "${parsed.server}" does not support resources`,
              })
            }
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: { server: parsed.server, uri: parsed.uri },
              patterns: [`mcp:${parsed.server}:${parsed.uri}`],
              always: [`mcp:${parsed.server}:*`],
            })

            const content = yield* mcp.readResource(parsed.server, parsed.uri)
            if (!content) {
              return yield* new McpToolError({
                message: `Failed to read MCP resource: ${parsed.server}/${parsed.uri}`,
              })
            }

            const formatted = formatMcpResourceContent(parsed.server, parsed.uri, content)
            const truncated = yield* truncate.output(formatted.text, {}, input.agent)
            const output = {
              title: `MCP resource: ${parsed.uri}`,
              metadata: {
                server: parsed.server,
                uri: parsed.uri,
                contents: formatted.contents,
                attachments: formatted.attachments.length,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
              attachments: formatted.attachments.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  if (flags.experimentalCodeMode) return tools

  for (const [key, entry] of Object.entries(yield* mcp.tools())) {
    const item = McpCatalog.convertTool(entry.def, entry.client, entry.timeout)
    const execute = item.execute
    if (!execute) continue

    const jsonSchemaValue = asSchema(item.inputSchema).jsonSchema
    const schema = Predicate.isPromiseLike(jsonSchemaValue)
      ? yield* Effect.promise(() => jsonSchemaValue)
      : jsonSchemaValue
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const started = yield* Clock.currentTimeMillis
          const result = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            // The AI SDK types execute as any. McpCatalog.convertTool returns a CallToolResult.
            const parsed = CallToolResultSchema.safeParse(yield* Effect.promise(() => execute(args, opts)))
            if (!parsed.success) {
              return yield* new McpToolError({
                message: `MCP tool ${key} returned an invalid result: ${parsed.error.message}`,
              })
            }
            return parsed.data
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
            // The span reaches only an OTLP collector, so the log sinks see an MCP call through this record alone.
            Effect.onExit((exit) =>
              logMcpCall(exit, {
                tool: key,
                server: entry.server,
                callID: opts.toolCallId,
                sessionID: ctx.sessionID,
                started,
              }),
            ),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const collected = result.content.map((contentItem): CollectedContent => {
            if (contentItem.type === "text") return { text: [contentItem.text], attachments: [] }
            if (contentItem.type === "image") {
              return {
                text: [],
                attachments: [
                  {
                    type: "file",
                    mime: contentItem.mimeType,
                    url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
                  },
                ],
              }
            }
            if (contentItem.type !== "resource") return { text: [], attachments: [] }
            const { resource } = contentItem
            const text = "text" in resource && resource.text ? [resource.text] : []
            if (!("blob" in resource) || !resource.blob) return { text, attachments: [] }
            const mime = resource.mimeType ?? "application/octet-stream"
            const size = base64Size(resource.blob)
            if (!HashSet.has(SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES, mime)) {
              return {
                text: [
                  ...text,
                  `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
                ],
                attachments: [],
              }
            }
            if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
              return {
                text: [
                  ...text,
                  `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                ],
                attachments: [],
              }
            }
            return {
              text,
              attachments: [
                { type: "file", mime, url: `data:${mime};base64,${resource.blob}`, filename: resource.uri },
              ],
            }
          })
          const textParts = collected.flatMap((item) => item.text)
          const attachments = collected.flatMap((item) => item.attachments)

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...(isRecord(result.metadata) ? result.metadata : {}),
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  return tools
})

/**
 * Logs one MCP tool call with its outcome and duration. The arguments and the result stay out of the record,
 * because they can hold user content.
 */
function logMcpCall(
  exit: Exit.Exit<unknown, unknown>,
  call: { tool: string; server: string; callID: string; sessionID: string; started: number },
) {
  return Effect.flatMap(Clock.currentTimeMillis, (now) => {
    const fields = {
      tool: call.tool,
      server: call.server,
      callID: call.callID,
      sessionID: call.sessionID,
      durationMs: now - call.started,
    }
    // McpCatalog turns an `isError` result into a failure, so a success is always "ok".
    if (Exit.isSuccess(exit)) return Effect.logInfo("MCP tool call", { ...fields, outcome: "ok" })
    if (Cause.hasInterruptsOnly(exit.cause))
      return Effect.logInfo("MCP tool call", { ...fields, outcome: "interrupted" })
    // A failed MCP result puts the tool's text in the error message, so only the error type is logged.
    const error = Cause.squash(exit.cause)
    const errorType = Predicate.hasProperty(error, "_tag")
      ? String(error._tag)
      : error instanceof Error
        ? error.name
        : typeof error
    return Effect.logWarning("MCP tool call", { ...fields, outcome: "failed", errorType })
  }).pipe(Effect.annotateLogs({ category: "mcp.tool" }))
}

function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
}

function parseListMcpResourcesArgs(value: unknown) {
  const args = toRecord(value)
  return Result.map(optionalString(args, "server"), (server) => ({ server }))
}

function parseReadMcpResourceArgs(value: unknown) {
  const args = toRecord(value)
  return Result.all({ server: requiredString(args, "server"), uri: requiredString(args, "uri") })
}

// A missing, null, or empty argument is absent. Any other non-string value is an error.
function optionalString(
  args: Record<string, unknown>,
  key: string,
): Result.Result<Option.Option<string>, McpToolError> {
  const value = args[key]
  if (Predicate.isNullish(value) || value === "") return Result.succeed(Option.none())
  if (typeof value !== "string") return Result.fail(new McpToolError({ message: `${key} must be a string` }))
  return Result.succeed(Option.some(value))
}

function requiredString(args: Record<string, unknown>, key: string): Result.Result<string, McpToolError> {
  return Result.flatMap(optionalString(args, key), (value) =>
    Option.match(value, {
      onNone: () => Result.fail(new McpToolError({ message: `${key} is required` })),
      onSome: (text) => Result.succeed(text),
    }),
  )
}

function formatMcpResource(resource: MCP.Resource) {
  const result = Object.fromEntries(Object.entries(resource).filter((entry) => entry[0] !== "client"))
  return { ...result, server: resource.client }
}

function formatMcpResourceTemplate(template: Record<string, unknown> & { client: string }) {
  const result = Object.fromEntries(Object.entries(template).filter((entry) => entry[0] !== "client"))
  return { ...result, server: template.client }
}

function formatMcpResourceContent(server: string, uri: string, content: { contents: unknown }) {
  const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(isRecord)
  const collected = items.map((item): CollectedContent => {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string") {
      return { text: [`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`], attachments: [] }
    }
    if (typeof item.blob !== "string") {
      return { text: [`[MCP resource content without text or blob: ${itemUri}]`], attachments: [] }
    }
    const size = base64Size(item.blob)
    if (!HashSet.has(SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES, mime)) {
      return {
        text: [
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        ],
        attachments: [],
      }
    }
    if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
      return {
        text: [
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
        ],
        attachments: [],
      }
    }
    return {
      text: [`[Binary MCP resource attached: ${itemUri} (${mime})]`],
      attachments: [{ type: "file", mime, url: `data:${mime};base64,${item.blob}`, filename: itemUri }],
    }
  })

  return {
    contents: items.length,
    attachments: collected.flatMap((item) => item.attachments),
    text:
      collected.flatMap((item) => item.text).join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
  }
}

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

export * as SessionTools from "./tools"
