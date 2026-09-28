import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import type { ToolExecutionOptions } from "ai"
import { McpCatalog } from "@/mcp/catalog"
import { Effect, Option } from "effect"

const options: ToolExecutionOptions = {
  toolCallId: "call_mcp",
  messages: [],
  abortSignal: new AbortController().signal,
}

/** A real MCP client whose server answers every tool call with `result`. */
async function clientReturning(result: CallToolResult) {
  const server = new Server({ name: "fixed-result", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(CallToolRequestSchema, () => result)
  const client = new Client({ name: "fixed-result-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return {
    client,
    [Symbol.asyncDispose]: async () => {
      await Promise.all([client.close(), server.close()])
    },
  }
}

function mcpTool(): MCPToolDef {
  return {
    name: "screenshot",
    description: "Take a screenshot",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  }
}

describe("McpCatalog.convertTool", () => {
  test("preserves content when structuredContent is also present", async () => {
    const content = [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }]
    const structuredContent = { image: { mimeType: "image/png", data: "AAAA" } }
    await using fixture = await clientReturning({ content, structuredContent })
    const converted = McpCatalog.convertTool(mcpTool(), fixture.client)

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({ content, structuredContent })
  })

  test("falls back to structuredContent only when content is absent", async () => {
    const structuredContent = { results: [{ title: "one" }] }
    await using fixture = await clientReturning({ content: [], structuredContent })
    const converted = McpCatalog.convertTool(mcpTool(), fixture.client)

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    })
  })
})

test("preserves output schema validation across paginated tool discovery", async () => {
  const server = new Server({ name: "pagination", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, ({ params }) =>
    Promise.resolve(
      params?.cursor === "page-2"
        ? {
            tools: [
              {
                name: "second",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "number" } },
                  required: ["value"],
                },
              },
            ],
          }
        : {
            tools: [
              {
                name: "first",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
            nextCursor: "page-2",
          },
    ),
  )
  server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
    Promise.resolve({
      content: [],
      structuredContent: { value: params.name === "first" ? 42 : 1 },
    }),
  )

  const client = new Client({ name: "pagination-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  try {
    const tools = await Effect.runPromise(McpCatalog.defs(client))
    expect(Option.map(tools, (list) => list.map((tool) => tool.name))).toEqual(Option.some(["first", "second"]))
    const failure = await client.callTool({ name: "first", arguments: {} }).then(
      () => "resolved",
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toHaveProperty(
      "message",
      expect.stringContaining("Structured content does not match the tool's output schema"),
    )
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})
