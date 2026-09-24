import { ToolOutput, ToolResultValue, type LLMEvent, type ProviderMetadata, type Usage } from "@opencode-ai/llm"
import { DateTime, Effect, Option, Schema } from "effect"
import { EventV2 } from "../../event"
import { ModelV2 } from "../../model"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly agent: string
  readonly model: ModelV2.Ref
  readonly snapshot?: string
}

const safe = (value: number | undefined) => Math.max(0, Number.isFinite(value) ? (value ?? 0) : 0)

const tokens = (usage: Usage | undefined) => {
  const reasoning = safe(usage?.reasoningTokens)
  const read = safe(usage?.cacheReadInputTokens)
  const write = safe(usage?.cacheWriteInputTokens)
  return {
    input: safe(usage?.nonCachedInputTokens),
    output: safe(usage?.visibleOutputTokens),
    reasoning,
    cache: { read, write },
  }
}

const isJson = Schema.is(Schema.Json)
const isJsonObject = Schema.is(Schema.JsonObject)
const encodeJsonText = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))
const encodeToolResult = (result: ToolResultValue) => Schema.encodeEffect(ToolResultValue)(result).pipe(Effect.orDie)

/**
 * The JSON form that a durable tool event stores. A JSON value stays as it is. Any other value goes through JSON
 * encoding: undefined-valued keys drop out and Dates become ISO strings. A value with no JSON form becomes absent.
 */
const toJson = (value: unknown): Option.Option<Schema.Json> =>
  isJson(value) ? Option.some(value) : Option.flatMap(encodeJsonText(value), decodeJsonText)

/** A JSON object stays as it is; any other value is wrapped as `{ value }`. */
const record = (value: unknown): Schema.JsonObject =>
  Option.match(toJson(value), {
    onNone: () => ({}),
    onSome: (json) => (isJsonObject(json) ? json : { value: json }),
  })

const message = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

type SettledOutput =
  | { readonly structured: Schema.JsonObject; readonly content: ToolOutput["content"] }
  | { readonly error: { readonly type: "unknown"; readonly message: string } }

const settledOutput = (value: ToolOutput | undefined, result: ToolResultValue): SettledOutput => {
  if (result.type === "error") return { error: { type: "unknown", message: message(result.value) } }
  const settled = value ?? ToolOutput.fromResultValue(result)
  if (!settled) throw new Error(`Unsupported tool result: ${message(result)}`)
  return { structured: record(settled.structured), content: settled.content }
}

/** Persist one provider turn without executing tools or starting a continuation turn. */
export const createLLMEventPublisher = (events: EventV2.Interface, input: Input) => {
  const tools = new Map<
    SessionMessage.ToolCallID,
    {
      readonly assistantMessageID: SessionMessage.ID
      readonly name: string
      inputEnded: boolean
      called: boolean
      settled: boolean
      providerExecuted: boolean
      providerMetadata?: ProviderMetadata
    }
  >()
  const timestamp = DateTime.now
  let assistantMessageID: SessionMessage.ID | undefined
  let assistantActive = false
  let assistantFailed = false
  let providerFailed = false
  let stepSettlement: { readonly finish: string; readonly tokens: ReturnType<typeof tokens> } | undefined

  const startAssistant = Effect.fnUntraced(function* () {
    if (assistantMessageID !== undefined) return assistantMessageID
    assistantMessageID = SessionMessage.ID.create()
    assistantActive = true
    yield* events.publish(SessionEvent.Step.Started, {
      ...input,
      assistantMessageID,
      timestamp: yield* timestamp,
      snapshot: input.snapshot,
    })
    return assistantMessageID
  })
  const currentAssistantMessageID = () =>
    assistantMessageID === undefined
      ? Effect.die("Tool event before assistant step start")
      : Effect.succeed(assistantMessageID)

  const fragments = <ID extends string>(
    name: string,
    ended: (id: ID, value: string, providerMetadata?: ProviderMetadata) => Effect.Effect<void>,
  ) => {
    const chunks = new Map<ID, string[]>()
    const start = (id: ID) =>
      Effect.suspend(() => {
        if (chunks.has(id)) return Effect.die(`Duplicate ${name} start: ${id}`)
        chunks.set(id, [])
        return Effect.void
      })
    const append = (id: ID, value: string) =>
      Effect.suspend(() => {
        const current = chunks.get(id)
        if (!current) return Effect.die(`${name} delta before start: ${id}`)
        current.push(value)
        return Effect.void
      })
    const end = Effect.fnUntraced(function* (id: ID, providerMetadata?: ProviderMetadata) {
      const current = chunks.get(id)
      if (!current) return yield* Effect.die(`${name} end before start: ${id}`)
      yield* ended(id, current.join(""), providerMetadata)
      chunks.delete(id)
    })
    const flush = Effect.fnUntraced(function* () {
      for (const id of chunks.keys()) yield* end(id)
    })
    return { start, append, end, flush }
  }

  const text = fragments("text", (textID: SessionMessage.TextID, value) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: yield* currentAssistantMessageID(),
        timestamp: yield* timestamp,
        textID,
        text: value,
      })
    }),
  )
  const reasoning = fragments("reasoning", (reasoningID: SessionMessage.ReasoningID, value, providerMetadata) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Reasoning.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: yield* currentAssistantMessageID(),
        timestamp: yield* timestamp,
        reasoningID,
        text: value,
        providerMetadata,
      })
    }),
  )
  const toolInput = fragments("tool input", (callID: SessionMessage.ToolCallID, value) =>
    Effect.gen(function* () {
      const tool = tools.get(callID)
      if (!tool) return yield* Effect.die(`Tool input end before start: ${callID}`)
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        text: value,
      })
      tool.inputEnded = true
    }),
  )

  const flushFragments = Effect.fnUntraced(function* () {
    yield* text.flush()
    yield* reasoning.flush()
    yield* toolInput.flush()
  })

  const startToolInput = Effect.fnUntraced(function* (event: {
    readonly id: SessionMessage.ToolCallID
    readonly name: string
  }) {
    if (tools.has(event.id)) return yield* Effect.die(`Duplicate tool input start: ${event.id}`)
    const assistantMessageID = yield* startAssistant()
    tools.set(event.id, {
      assistantMessageID,
      name: event.name,
      inputEnded: false,
      called: false,
      settled: false,
      providerExecuted: false,
    })
    yield* toolInput.start(event.id)
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID,
      callID: event.id,
      name: event.name,
    })
  })

  const endToolInput = Effect.fnUntraced(function* (event: {
    readonly id: SessionMessage.ToolCallID
    readonly name: string
  }) {
    const tool = tools.get(event.id)
    if (!tool) return yield* Effect.die(`Tool input end before start: ${event.id}`)
    if (tool.name !== event.name)
      return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
    if (tool.inputEnded) return yield* Effect.die(`Duplicate tool input end: ${event.id}`)
    yield* toolInput.end(event.id)
  })

  const flush = Effect.fn("SessionRunner.flush")(function* () {
    yield* flushFragments()
  })

  const failAssistant = Effect.fnUntraced(function* (message: string) {
    if (assistantFailed) return
    yield* flush()
    const assistantMessageID = yield* startAssistant()
    assistantActive = false
    assistantFailed = true
    yield* events.publish(SessionEvent.Step.Failed, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID,
      error: { type: "unknown", message },
    })
  })

  const failUnsettledTools = Effect.fn("SessionRunner.failUnsettledTools")(function* (
    message: string,
    hostedOnly = false,
  ) {
    for (const [callID, tool] of tools) {
      if (tool.settled || (hostedOnly && !tool.providerExecuted)) continue
      tool.settled = true
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        error: { type: "unknown", message },
        provider: {
          executed: tool.providerExecuted,
          ...(tool.providerMetadata === undefined ? {} : { metadata: tool.providerMetadata }),
        },
      })
    }
  })

  const assistantMessageIDForTool = (callID: string) => {
    const tool = tools.get(SessionMessage.ToolCallID.make(callID))
    return tool ? Effect.succeed(tool.assistantMessageID) : Effect.die(`Unknown tool call: ${callID}`)
  }

  const publish = Effect.fn("SessionRunner.publishLLMEvent")(function* (
    event: LLMEvent,
    outputPaths: ReadonlyArray<string> = [],
  ) {
    switch (event.type) {
      case "step-start":
        return
      case "text-start": {
        const textID = SessionMessage.TextID.make(event.id)
        yield* text.start(textID)
        yield* events.publish(SessionEvent.Text.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          textID,
        })
        return
      }
      case "text-delta": {
        const textID = SessionMessage.TextID.make(event.id)
        yield* text.append(textID, event.text)
        yield* events.publish(SessionEvent.Text.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          textID,
          delta: event.text,
        })
        return
      }
      case "text-end":
        yield* text.end(SessionMessage.TextID.make(event.id))
        return
      case "reasoning-start": {
        const reasoningID = SessionMessage.ReasoningID.make(event.id)
        yield* reasoning.start(reasoningID)
        yield* events.publish(SessionEvent.Reasoning.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          reasoningID,
          providerMetadata: event.providerMetadata,
        })
        return
      }
      case "reasoning-delta": {
        const reasoningID = SessionMessage.ReasoningID.make(event.id)
        yield* reasoning.append(reasoningID, event.text)
        yield* events.publish(SessionEvent.Reasoning.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          reasoningID,
          delta: event.text,
        })
        return
      }
      case "reasoning-end":
        yield* reasoning.end(SessionMessage.ReasoningID.make(event.id), event.providerMetadata)
        return
      case "tool-input-start":
        yield* startToolInput({ id: SessionMessage.ToolCallID.make(event.id), name: event.name })
        return
      case "tool-input-delta": {
        const callID = SessionMessage.ToolCallID.make(event.id)
        const tool = tools.get(callID)
        if (!tool) return yield* Effect.die(`Tool input delta before start: ${callID}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool input name changed for ${callID}: ${tool.name} -> ${event.name}`)
        if (tool.inputEnded) return yield* Effect.die(`Tool input delta after end: ${callID}`)
        yield* toolInput.append(callID, event.text)
        yield* events.publish(SessionEvent.Tool.Input.Delta, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID,
          delta: event.text,
        })
        return
      }
      case "tool-input-end":
        yield* endToolInput({ id: SessionMessage.ToolCallID.make(event.id), name: event.name })
        return
      case "tool-call": {
        const callID = SessionMessage.ToolCallID.make(event.id)
        if (!tools.has(callID)) yield* startToolInput({ id: callID, name: event.name })
        const tool = tools.get(callID)!
        if (!tool.inputEnded) yield* endToolInput({ id: callID, name: event.name })
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool call name changed for ${callID}: ${tool.name} -> ${event.name}`)
        if (tool.called) return yield* Effect.die(`Duplicate tool call: ${callID}`)
        tool.called = true
        tool.providerExecuted = event.providerExecuted === true
        tool.providerMetadata = event.providerMetadata
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID,
          tool: event.name,
          input: record(event.input),
          provider: {
            executed: tool.providerExecuted,
            ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
          },
        })
        return
      }
      case "tool-result": {
        const callID = SessionMessage.ToolCallID.make(event.id)
        const tool = tools.get(callID)
        if (!tool?.called) return yield* Effect.die(`Tool result before call: ${callID}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool result name changed for ${callID}: ${tool.name} -> ${event.name}`)
        if (tool.settled) {
          if (event.result.type === "error") return
          return yield* Effect.die(`Duplicate tool result: ${callID}`)
        }
        tool.settled = true
        const result = settledOutput(event.output, event.result)
        const provider = {
          executed: event.providerExecuted === true || tool.providerExecuted,
          ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
        }
        if ("error" in result) {
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID: input.sessionID,
            timestamp: yield* timestamp,
            assistantMessageID: tool.assistantMessageID,
            callID,
            error: result.error,
            result: yield* encodeToolResult(event.result),
            provider,
          })
          return
        }
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID,
          ...result,
          outputPaths,
          ...(provider.executed ? { result: yield* encodeToolResult(event.result) } : {}),
          provider,
        })
        return
      }
      case "tool-error": {
        const callID = SessionMessage.ToolCallID.make(event.id)
        const tool = tools.get(callID)
        if (!tool?.called) return yield* Effect.die(`Tool error before call: ${callID}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool error name changed for ${callID}: ${tool.name} -> ${event.name}`)
        if (tool.settled) return yield* Effect.die(`Duplicate tool error: ${callID}`)
        tool.settled = true
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID,
          error: { type: "unknown", message: event.message },
          provider: {
            executed: tool.providerExecuted,
            ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
          },
        })
        return
      }
      case "step-finish":
        yield* flush()
        assistantActive = false
        if (stepSettlement) return yield* Effect.die("Duplicate step finish")
        stepSettlement = { finish: event.reason, tokens: tokens(event.usage) }
        return
      case "finish":
        return
      case "provider-error":
        providerFailed = true
        yield* failAssistant(event.message)
        return
    }
  })

  return {
    publish,
    flush,
    failAssistant,
    failUnsettledTools,
    hasActiveAssistant: () => assistantActive,
    hasAssistantStarted: () => assistantMessageID !== undefined,
    hasProviderError: () => providerFailed,
    stepSettlement: () => stepSettlement,
    startAssistant,
    assistantMessageID: assistantMessageIDForTool,
  }
}
