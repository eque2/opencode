import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type {
  Event,
  EventMessagePartDelta,
  EventMessagePartUpdated,
  GlobalEvent,
  OpencodeClient,
  Part,
  SessionMessageResponse,
  ToolPart,
} from "@opencode-ai/sdk/v2"
import {
  Array as Arr,
  Deferred,
  Duration,
  Effect,
  Exit,
  Latch,
  MutableHashMap,
  MutableHashSet,
  Option,
  Schema,
  Stream,
} from "effect"
import { ACPSession } from "./session"
import { ACPPermission } from "./permission"
import { partsToContentChunks } from "./content"
import {
  duplicateRunningToolUpdate,
  errorToolUpdate,
  pendingToolCall,
  runningToolUpdate,
  shellOutputSnapshot,
  completedToolUpdate,
} from "./tool"

type Connection = Pick<AgentSideConnection, "sessionUpdate"> &
  Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile">>
type SessionUpdate = Parameters<Connection["sessionUpdate"]>[0]
type Input = {
  sdk: OpencodeClient
  connection: Connection
  session: ACPSession.Interface
}
type Payload = Event | GlobalEvent["payload"]

// The tags do not start with "ACP": the ACP service maps every error with an "ACP" tag as its own request error.
export class SubscriptionStoppedError extends Schema.TaggedError<SubscriptionStoppedError>()(
  "EventSubscriptionStoppedError",
  { message: Schema.String },
) {}

export class StreamDisconnectedError extends Schema.TaggedError<StreamDisconnectedError>()(
  "EventStreamDisconnectedError",
  { message: Schema.String },
) {}

export class ClientError extends Schema.TaggedError<ClientError>()("EventClientError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

class RequestFailedError extends Schema.TaggedError<RequestFailedError>()("EventRequestFailedError", {
  cause: Schema.Defect(),
}) {}

type IdleWaiter = Deferred.Deferred<void, StreamDisconnectedError>

type State = {
  readonly input: Input
  readonly abort: AbortController
  readonly shellSnapshots: MutableHashMap.MutableHashMap<string, string>
  readonly toolStarts: MutableHashSet.MutableHashSet<string>
  // Open while the event stream is connected, and after the subscription stops.
  readonly connection: Latch.Latch
  readonly idleWaiters: MutableHashMap.MutableHashMap<string, ReadonlyArray<IdleWaiter>>
  readonly permission: ACPPermission.Handler
  readonly flags: { connected: boolean; started: boolean }
}

export function start(input: Input) {
  const subscription = new Subscription(input)
  subscription.start()
  return subscription
}

// The ACP service and its tests drive this class through Promises; each method runs one Effect.
export class Subscription {
  private readonly state: State

  constructor(input: Input) {
    this.state = {
      input,
      abort: new AbortController(),
      shellSnapshots: MutableHashMap.empty(),
      toolStarts: MutableHashSet.empty(),
      connection: Latch.makeUnsafe(false),
      idleWaiters: MutableHashMap.empty(),
      permission: new ACPPermission.Handler(input),
      flags: { connected: false, started: false },
    }
  }

  start() {
    if (this.state.flags.started) return
    this.state.flags.started = true
    Effect.runFork(run(this.state))
  }

  stop() {
    this.state.abort.abort()
    disconnected(this.state)
    this.state.connection.openUnsafe()
  }

  runUntilIdle<A>(sessionId: string, request: () => Promise<A>) {
    return Effect.runPromise(
      runUntilIdle(this.state, sessionId, request).pipe(
        // Reject with the request's own error, so the ACP service can still classify it.
        Effect.catchTag("EventRequestFailedError", (error) => Effect.fail(error.cause)),
      ),
    )
  }

  handle(event: Payload) {
    return Effect.runPromise(handle(this.state, event))
  }

  replayMessage(message: SessionMessageResponse) {
    return Effect.runPromise(replayMessage(this.state, message))
  }
}

const run = Effect.fn("ACPEvent.run")(function* (state: State) {
  while (!state.abort.signal.aborted) {
    yield* consume(state).pipe(Effect.catchCause(() => Effect.void))
    disconnected(state)
    if (!state.abort.signal.aborted) yield* Effect.sleep(Duration.seconds(1))
  }
})

const consume = Effect.fn("ACPEvent.consume")(function* (state: State) {
  const events = yield* Effect.tryPromise({
    try: () => state.input.sdk.global.event({ signal: state.abort.signal }),
    catch: (cause) => new ClientError({ message: "ACP event stream request failed", cause }),
  })
  state.flags.connected = true
  yield* state.connection.open

  yield* Stream.fromAsyncIterable(
    events.stream,
    (cause) => new ClientError({ message: "ACP event stream failed", cause }),
  ).pipe(
    Stream.takeWhile(() => !state.abort.signal.aborted),
    Stream.runForEach((event) => handle(state, event.payload).pipe(Effect.catchCause(() => Effect.void))),
  )
})

const runUntilIdle = <A>(state: State, sessionId: string, request: () => Promise<A>) =>
  Effect.gen(function* () {
    yield* waitUntilConnected(state)
    const waiter = Deferred.makeUnsafe<void, StreamDisconnectedError>()
    MutableHashMap.set(state.idleWaiters, sessionId, Arr.append(idleWaitersOf(state, sessionId), waiter))

    // Idle is queued after the turn's events, and this subscription handles each update in order.
    return yield* Effect.tryPromise({
      try: request,
      catch: (cause) => new RequestFailedError({ cause }),
    }).pipe(
      Effect.tap(() => Deferred.await(waiter)),
      Effect.ensuring(Effect.sync(() => removeIdleWaiter(state, sessionId, waiter))),
    )
  })

const waitUntilConnected = Effect.fn("ACPEvent.waitUntilConnected")(function* (state: State) {
  while (!state.flags.connected && !state.abort.signal.aborted) yield* state.connection.await
  return yield* state.flags.connected
    ? Effect.void
    : new SubscriptionStoppedError({ message: "ACP event subscription stopped" })
})

function disconnected(state: State) {
  if (!state.flags.connected) return
  state.flags.connected = false
  state.connection.closeUnsafe()
  const error = Exit.fail(new StreamDisconnectedError({ message: "ACP event stream disconnected" }))
  MutableHashMap.forEach(state.idleWaiters, (waiters) =>
    waiters.forEach((waiter) => Deferred.doneUnsafe(waiter, error)),
  )
  MutableHashMap.clear(state.idleWaiters)
}

function idle(state: State, sessionId: string) {
  const waiters = MutableHashMap.get(state.idleWaiters, sessionId)
  if (Option.isNone(waiters)) return
  MutableHashMap.remove(state.idleWaiters, sessionId)
  waiters.value.forEach((waiter) => Deferred.doneUnsafe(waiter, Exit.void))
}

function idleWaitersOf(state: State, sessionId: string): ReadonlyArray<IdleWaiter> {
  return Option.getOrElse(MutableHashMap.get(state.idleWaiters, sessionId), Arr.empty)
}

function removeIdleWaiter(state: State, sessionId: string, waiter: IdleWaiter) {
  const remaining = idleWaitersOf(state, sessionId).filter((item) => item !== waiter)
  if (remaining.length === 0) {
    MutableHashMap.remove(state.idleWaiters, sessionId)
    return
  }
  MutableHashMap.set(state.idleWaiters, sessionId, remaining)
}

const handle = Effect.fn("ACPEvent.handle")(function* (state: State, event: Payload) {
  switch (event.type) {
    case "session.status":
      if (event.properties.status.type === "idle") idle(state, event.properties.sessionID)
      return
    case "permission.asked":
      state.permission.handle(event)
      return
    case "message.part.updated":
      yield* handlePartUpdated(state, event)
      return
    case "message.part.delta":
      yield* handlePartDelta(state, event)
      return
  }
})

const replayMessage = Effect.fn("ACPEvent.replayMessage")(function* (state: State, message: SessionMessageResponse) {
  const info = message.info
  if (info.role !== "assistant" && info.role !== "user") return

  const cwd = info.role === "assistant" ? Option.fromNullishOr(info.path?.cwd) : Option.none<string>()
  yield* Effect.forEach(
    message.parts,
    Effect.fnUntraced(function* (part) {
      yield* recordFetchedPart(state, info.sessionID, message, part)
      if (part.type === "tool") {
        yield* handleToolPart(
          state,
          info.sessionID,
          part,
          Option.getOrElse(cwd, () => process.cwd()),
        )
        return
      }
      yield* replayContentPart(state, message, part)
    }),
    { discard: true },
  )
})

const replayContentPart = Effect.fn("ACPEvent.replayContentPart")(function* (
  state: State,
  message: SessionMessageResponse,
  part: Part,
) {
  if (part.type !== "text" && part.type !== "file" && part.type !== "reasoning") return

  const sessionUpdate =
    part.type === "reasoning"
      ? "agent_thought_chunk"
      : message.info.role === "user"
        ? "user_message_chunk"
        : "agent_message_chunk"

  yield* Effect.forEach(
    partsToContentChunks([part]),
    (chunk) =>
      send(state, {
        sessionId: message.info.sessionID,
        update: {
          sessionUpdate,
          messageId: part.type === "reasoning" ? part.id : message.info.id,
          ...chunk,
        },
      }),
    { discard: true },
  )
})

const handlePartUpdated = Effect.fn("ACPEvent.handlePartUpdated")(function* (
  state: State,
  event: EventMessagePartUpdated,
) {
  const part = event.properties.part
  const session = yield* state.input.session.tryGet(part.sessionID || event.properties.sessionID)
  if (!session) return

  yield* state.input.session.recordPartMetadata({
    sessionId: session.id,
    messageId: part.messageID,
    partId: part.id,
    partType: part.type,
    ...(part.type === "reasoning" ? { role: "assistant" as const } : {}),
    ...partMetadataFields(part),
  })
  if (part.type === "tool") {
    yield* handleToolPart(state, session.id, part, session.cwd)
  }
})

const handlePartDelta = Effect.fn("ACPEvent.handlePartDelta")(function* (state: State, event: EventMessagePartDelta) {
  const props = event.properties
  const session = yield* state.input.session.tryGet(props.sessionID)
  if (!session) return

  const known = Option.filter(
    Option.fromNullishOr(
      yield* state.input.session.tryGetPartMetadata({
        sessionId: session.id,
        messageId: props.messageID,
        partId: props.partID,
      }),
    ),
    (item) => Boolean(item.role && item.partType),
  )
  const metadata = Option.isSome(known)
    ? known
    : yield* fetchPartMetadata(state, session.id, session.cwd, props.messageID, props.partID)
  if (Option.isNone(metadata) || metadata.value.role !== "assistant") return

  if (metadata.value.partType === "text" && props.field === "text" && metadata.value.ignored !== true) {
    yield* send(state, {
      sessionId: session.id,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: props.messageID,
        content: {
          type: "text",
          text: props.delta,
        },
      },
    })
    return
  }

  if (metadata.value.partType === "reasoning" && props.field === "text") {
    yield* send(state, {
      sessionId: session.id,
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: props.partID,
        content: {
          type: "text",
          text: props.delta,
        },
      },
    })
  }
})

const fetchPartMetadata = Effect.fn("ACPEvent.fetchPartMetadata")(function* (
  state: State,
  sessionId: string,
  cwd: string,
  messageId: string,
  partId: string,
) {
  // A failed lookup leaves the part metadata unknown.
  const message = yield* Effect.tryPromise({
    try: () =>
      state.input.sdk.session.message(
        {
          sessionID: sessionId,
          messageID: messageId,
          directory: cwd,
        },
        { throwOnError: true },
      ),
    catch: (cause) => new ClientError({ message: "ACP part metadata lookup failed", cause }),
  }).pipe(Effect.option, Effect.map(Option.flatMap((response) => Option.fromNullishOr(response.data))))
  if (Option.isNone(message)) return Option.none<ACPSession.KnownMessagePartMetadata>()

  const part = Arr.findFirst(message.value.parts, (item) => item.id === partId)
  if (Option.isNone(part)) return Option.none<ACPSession.KnownMessagePartMetadata>()
  return Option.some(yield* recordFetchedPart(state, sessionId, message.value, part.value))
})

function recordFetchedPart(state: State, sessionId: string, message: SessionMessageResponse, part: Part) {
  return state.input.session.recordPartMetadata({
    sessionId,
    messageId: part.messageID,
    partId: part.id,
    partType: part.type,
    role: message.info.role,
    ...partMetadataFields(part),
  })
}

function partMetadataFields(part: Part) {
  return {
    ...(part.type === "text" ? { ignored: part.ignored } : {}),
    ...(part.type === "tool" ? { toolCallId: part.callID } : {}),
    ...("metadata" in part ? { metadata: part.metadata } : {}),
  }
}

const handleToolPart = Effect.fn("ACPEvent.handleToolPart")(function* (
  state: State,
  sessionId: string,
  part: ToolPart,
  cwd: string,
) {
  yield* toolStart(state, sessionId, part, cwd)

  switch (part.state.status) {
    case "pending":
      MutableHashMap.remove(state.shellSnapshots, part.callID)
      return

    case "running":
      yield* runningTool(state, sessionId, part, cwd)
      return

    case "completed":
      clearTool(state, part.callID)
      yield* send(state, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          ...completedToolUpdate({
            toolCallId: part.callID,
            toolName: part.tool,
            state: part.state,
            cwd,
          }),
        },
      })
      return

    case "error":
      clearTool(state, part.callID)
      yield* send(state, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          ...errorToolUpdate({
            toolCallId: part.callID,
            toolName: part.tool,
            state: part.state,
            cwd,
          }),
        },
      })
      return
  }
})

const runningTool = Effect.fn("ACPEvent.runningTool")(function* (
  state: State,
  sessionId: string,
  part: ToolPart,
  cwd: string,
) {
  const toolState = part.state
  if (toolState.status !== "running") return

  const output = part.tool === "bash" ? Option.fromNullishOr(shellOutputSnapshot(toolState)) : Option.none<string>()
  if (Option.isSome(output)) {
    if (Option.contains(MutableHashMap.get(state.shellSnapshots, part.callID), output.value)) {
      yield* send(state, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          ...duplicateRunningToolUpdate({
            toolCallId: part.callID,
            toolName: part.tool,
            state: toolState,
            cwd,
          }),
        },
      })
      return
    }
    MutableHashMap.set(state.shellSnapshots, part.callID, output.value)
  }

  yield* send(state, {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      ...runningToolUpdate({
        toolCallId: part.callID,
        toolName: part.tool,
        state: toolState,
        ...(Option.isSome(output) ? { output: output.value } : {}),
        cwd,
      }),
    },
  })
})

const toolStart = Effect.fn("ACPEvent.toolStart")(function* (
  state: State,
  sessionId: string,
  part: ToolPart,
  cwd: string,
) {
  if (MutableHashSet.has(state.toolStarts, part.callID)) return
  MutableHashSet.add(state.toolStarts, part.callID)
  yield* send(state, {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      ...pendingToolCall({
        toolCallId: part.callID,
        toolName: part.tool,
        state: part.state,
        cwd,
      }),
    },
  })
})

function clearTool(state: State, toolCallId: string) {
  MutableHashSet.remove(state.toolStarts, toolCallId)
  MutableHashMap.remove(state.shellSnapshots, toolCallId)
}

function send(state: State, params: SessionUpdate) {
  return Effect.tryPromise({
    try: () => state.input.connection.sessionUpdate(params),
    catch: (cause) => new ClientError({ message: "ACP session update failed", cause }),
  })
}

export * as ACPEvent from "./event"
