import { ToolOutput, ToolResultValue, type LLMEvent, type ProviderMetadata, type Usage } from "@opencode-ai/llm"
import { DateTime, Effect, MutableHashMap, Option, Schema } from "effect"
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

/** Text for an error value: strings pass through, JSON-encodable values encode, anything else stringifies. */
const message = (value: unknown) =>
  typeof value === "string" ? value : Option.getOrElse(encodeJsonText(value), () => String(value))

type SettledOutput =
  | { readonly structured: Schema.JsonObject; readonly content: ToolOutput["content"] }
  | { readonly error: { readonly type: "unknown"; readonly message: string } }

const settledOutput = (value: ToolOutput | undefined, result: ToolResultValue): Effect.Effect<SettledOutput> => {
  if (result.type === "error") return Effect.succeed({ error: { type: "unknown", message: message(result.value) } })
  return Option.match(Option.fromUndefinedOr(value ?? ToolOutput.fromResultValue(result)), {
    onNone: () => Effect.die(`Unsupported tool result: ${message(result)}`),
    onSome: (settled) => Effect.succeed({ structured: record(settled.structured), content: settled.content }),
  })
}

/** A provider stream that breaks the event grammar is a defect, not a recoverable failure. */
const ensure = (holds: boolean, violation: string): Effect.Effect<void> => (holds ? Effect.void : Effect.die(violation))

type ToolCallState = {
  readonly assistantMessageID: SessionMessage.ID
  readonly name: string
  inputEnded: boolean
  called: boolean
  settled: boolean
  providerExecuted: boolean
  providerMetadata?: ProviderMetadata
}

/** Persist one provider turn without executing tools or starting a continuation turn. */
export const createLLMEventPublisher = (events: EventV2.Interface, input: Input) => {
  const tools = MutableHashMap.empty<SessionMessage.ToolCallID, ToolCallState>()
  /** The recorded state of a tool call; a call the stream never started is a defect. */
  const recordedTool = (callID: SessionMessage.ToolCallID, missing: string): Effect.Effect<ToolCallState> =>
    Option.match(MutableHashMap.get(tools, callID), {
      onNone: () => Effect.die(missing),
      onSome: (tool) => Effect.succeed(tool),
    })
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
    const chunks = MutableHashMap.empty<ID, string[]>()
    /** The chunks buffered for a started fragment; a fragment the stream never started is a defect. */
    const buffered = (id: ID, missing: string): Effect.Effect<string[]> =>
      Option.match(MutableHashMap.get(chunks, id), {
        onNone: () => Effect.die(missing),
        onSome: (current) => Effect.succeed(current),
      })
    const start = (id: ID) =>
      Effect.suspend(() => {
        if (MutableHashMap.has(chunks, id)) return Effect.die(`Duplicate ${name} start: ${id}`)
        MutableHashMap.set(chunks, id, [])
        return Effect.void
      })
    const append = Effect.fnUntraced(function* (id: ID, value: string) {
      const current = yield* buffered(id, `${name} delta before start: ${id}`)
      current.push(value)
    })
    const end = Effect.fnUntraced(function* (id: ID, providerMetadata?: ProviderMetadata) {
      const current = yield* buffered(id, `${name} end before start: ${id}`)
      yield* ended(id, current.join(""), providerMetadata)
      MutableHashMap.remove(chunks, id)
    })
    const flush = Effect.fnUntraced(function* () {
      for (const id of MutableHashMap.keys(chunks)) yield* end(id)
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
      const tool = yield* recordedTool(callID, `Tool input end before start: ${callID}`)
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
    yield* ensure(!MutableHashMap.has(tools, event.id), `Duplicate tool input start: ${event.id}`)
    const assistantMessageID = yield* startAssistant()
    MutableHashMap.set(tools, event.id, {
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
    const tool = yield* recordedTool(event.id, `Tool input end before start: ${event.id}`)
    yield* ensure(tool.name === event.name, `Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
    yield* ensure(!tool.inputEnded, `Duplicate tool input end: ${event.id}`)
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

  const assistantMessageIDForTool = (callID: string) =>
    recordedTool(SessionMessage.ToolCallID.make(callID), `Unknown tool call: ${callID}`).pipe(
      Effect.map((tool) => tool.assistantMessageID),
    )

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
        const tool = yield* recordedTool(callID, `Tool input delta before start: ${callID}`)
        yield* ensure(tool.name === event.name, `Tool input name changed for ${callID}: ${tool.name} -> ${event.name}`)
        yield* ensure(!tool.inputEnded, `Tool input delta after end: ${callID}`)
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
        if (!MutableHashMap.has(tools, callID)) yield* startToolInput({ id: callID, name: event.name })
        const tool = yield* recordedTool(callID, `Tool call before start: ${callID}`)
        if (!tool.inputEnded) yield* endToolInput({ id: callID, name: event.name })
        yield* ensure(tool.name === event.name, `Tool call name changed for ${callID}: ${tool.name} -> ${event.name}`)
        yield* ensure(!tool.called, `Duplicate tool call: ${callID}`)
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
        const tool = yield* recordedTool(callID, `Tool result before call: ${callID}`)
        yield* ensure(tool.called, `Tool result before call: ${callID}`)
        yield* ensure(tool.name === event.name, `Tool result name changed for ${callID}: ${tool.name} -> ${event.name}`)
        if (tool.settled) {
          // A late error for an already settled call is ignored; a second result is a defect.
          yield* ensure(event.result.type === "error", `Duplicate tool result: ${callID}`)
          return
        }
        tool.settled = true
        const result = yield* settledOutput(event.output, event.result)
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
        const tool = yield* recordedTool(callID, `Tool error before call: ${callID}`)
        yield* ensure(tool.called, `Tool error before call: ${callID}`)
        yield* ensure(tool.name === event.name, `Tool error name changed for ${callID}: ${tool.name} -> ${event.name}`)
        yield* ensure(!tool.settled, `Duplicate tool error: ${callID}`)
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
        yield* ensure(stepSettlement === undefined, "Duplicate step finish")
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
