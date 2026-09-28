import { expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Layer, Logger, Schema } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { CallToolResultSchema, type CallToolRequest } from "@modelcontextprotocol/sdk/types.js"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"
import { ProjectV2 } from "@opencode-ai/core/project"
import type { TaskPromptOps } from "@/tool/task"

const callID = "call-test"
const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()
const partID = PartID.ascending()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

// A non-OpenAI npm package and a plain provider ID keep ProviderTransform.schema a pass-through.
const model: Provider.Model = ProviderTest.model({
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/anthropic" },
})

const session: Session.Info = {
  id: sessionID,
  slug: "test-session",
  projectID: ProjectV2.ID.global,
  directory: "/tmp",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  title: "Test session",
  version: "1.0.0",
  time: { created: 1, updated: 1 },
  permission: [],
}

// The timing tool never starts a subtask.
const promptOps: TaskPromptOps = {
  cancel: () => Effect.die("unused"),
  resolvePromptParts: () => Effect.die("unused"),
  prompt: () => Effect.die("unused"),
}

const fakePlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (_name, _input, output) => Effect.succeed(output),
} satisfies Plugin.Interface)

const fakePermission = Permission.Service.of({
  ask: () => Effect.void,
  reply: () => Effect.void,
  list: () => Effect.succeed([]),
} satisfies Permission.Interface)

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} satisfies Truncate.Interface)

// A real SDK Client that answers tools/call in-process.
class StubClient extends Client {
  constructor(private readonly handler: (args: Record<string, unknown>) => unknown) {
    super({ name: "session-tools-test", version: "1.0.0" })
  }

  override async callTool(params: CallToolRequest["params"]) {
    return CallToolResultSchema.parse(await this.handler(params.arguments ?? {}))
  }
}

const mcpTools: Record<string, MCP.McpTool> = {
  weather_current: {
    def: {
      name: "current",
      description: "current weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    },
    client: new StubClient(() => ({ content: [{ type: "text", text: "sunny" }] })),
    server: "weather",
  },
  weather_broken: {
    def: { name: "broken", description: "always fails", inputSchema: { type: "object", properties: {} } },
    client: new StubClient(() => ({ content: [{ type: "text", text: "upstream down" }], isError: true })),
    server: "weather",
  },
}

const layerWith = (tools: Record<string, MCP.McpTool>) =>
  Layer.mergeAll(
    Layer.succeed(Plugin.Service, fakePlugin),
    Layer.succeed(Permission.Service, fakePermission),
    Layer.mock(MCP.Service)({
      tools: () => Effect.succeed(tools),
      clients: () => Effect.succeed({}),
    }),
    Layer.succeed(Truncate.Service, fakeTruncate),
    RuntimeFlags.layer(),
    Layer.succeed(
      ToolRegistry.Service,
      ToolRegistry.Service.of({
        ids: () => Effect.succeed(["timing"]),
        all: () => Effect.succeed([]),
        named: () => Effect.die("unused"),
        tools: () =>
          Effect.succeed([
            {
              id: "timing",
              description: "updates metadata more than once",
              parameters: Schema.Struct({}),
              jsonSchema: { type: "object", properties: {} },
              execute: (_args, ctx) =>
                Effect.gen(function* () {
                  yield* ctx.metadata({ metadata: { output: "first" } })
                  yield* ctx.metadata({ metadata: { output: "second" } })
                  return { title: "timing", metadata: {}, output: "done" }
                }),
            } satisfies Tool.Def,
          ]),
      }),
    ),
  )

const it = testEffect(layerWith({}))
const withMcp = testEffect(layerWith(mcpTools))

const assistant = {
  id: messageID,
  sessionID,
  role: "assistant",
  parentID: MessageID.ascending(),
  agent: "build",
  mode: "build",
  path: { cwd: "/tmp", root: "/tmp" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test"),
  time: { created: 1 },
} satisfies SessionV1.Assistant

it.effect("preserves running tool start time across metadata updates", () =>
  Effect.gen(function* () {
    const state: SessionV1.ToolPart = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      tool: "timing",
      callID,
      state: {
        status: "running",
        input: {},
        time: { start: 100 },
      },
    }
    const updates: number[] = []
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: (_toolCallID, update) =>
        Effect.sync(() => {
          const next = update(state)
          state.state = next.state
          if (state.state.status === "running") updates.push(state.state.time.start)
          return state
        }),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps,
    })
    const execute = tools.timing.execute
    if (!execute) throw new Error("timing tool is missing execute")

    yield* Effect.promise(() =>
      execute(
        {},
        {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    )

    expect(updates).toEqual([100, 100])
    expect(state.state.status).toBe("running")
    if (state.state.status === "running") {
      expect(state.state.time.start).toBe(100)
    }
  }),
)

withMcp.effect("logs each MCP tool call with its outcome and without its arguments or result", () =>
  Effect.gen(function* () {
    const records: Array<{ level: string; message: unknown; annotations: Record<string, unknown> }> = []
    const capture = Logger.make((options) => {
      records.push({
        level: options.logLevel,
        message: options.message,
        annotations: Logger.formatStructured.log(options).annotations,
      })
    })
    const processor = {
      message: assistant,
      updateToolCall: () => Effect.die("unused"),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
    const options = { abortSignal: new AbortController().signal, messages: [] }

    yield* Effect.gen(function* () {
      const tools = yield* SessionTools.resolve({
        agent,
        model,
        session,
        processor,
        bypassAgentCheck: false,
        messages: [],
        promptOps,
      })
      for (const name of ["weather_current", "weather_broken"]) {
        const execute = tools[name]?.execute
        if (!execute) throw new Error(`${name} is missing execute`)
        // The broken tool rejects, as the AI SDK expects for a tool error.
        yield* Effect.tryPromise(() => execute({ city: "Paris" }, { ...options, toolCallId: `call-${name}` })).pipe(
          Effect.ignore,
        )
      }
    }).pipe(Effect.provide(Logger.layer([capture])))

    const calls = records.filter((record) => record.annotations.category === "mcp.tool")
    expect(calls.map((record) => record.level)).toEqual(["Info", "Warn"])
    const fields = { server: "weather", sessionID, durationMs: 0 }
    expect(calls[0]?.message).toEqual([
      "MCP tool call",
      { ...fields, tool: "weather_current", callID: "call-weather_current", outcome: "ok" },
    ])
    expect(calls[1]?.message).toMatchObject([
      "MCP tool call",
      {
        ...fields,
        tool: "weather_broken",
        callID: "call-weather_broken",
        outcome: "failed",
        error: { message: "upstream down" },
      },
    ])
    expect(JSON.stringify(calls)).not.toMatch(/Paris|sunny/)
  }),
)
