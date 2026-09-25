import { onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { Config, Duration, Effect, Fiber, MutableHashMap, MutableHashSet, Option, Schema, SchemaGetter } from "effect"
import { isRecord } from "../util/record"
import { useTuiPaths } from "./runtime"
import { createSimpleContext } from "./helper"
import { editorIntegration } from "../editor"
import { isZedTerminal } from "../editor-zed"

const MCP_PROTOCOL_VERSION = "2025-11-25"

const JsonRpcMessageSchema = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Json),
  result: Schema.optional(Schema.Json),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "TuiEditorContext.JsonRpcMessage" })

const JsonRpcOutgoingSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(Schema.Number),
  method: Schema.String,
  params: Schema.optional(Schema.Json),
}).annotate({ identifier: "TuiEditorContext.JsonRpcOutgoing" })

const PositionSchema = Schema.Struct({
  line: Schema.Number,
  character: Schema.Number,
}).annotate({ identifier: "TuiEditorContext.Position" })

const EditorSelectionRangeSchema = Schema.Struct({
  text: Schema.String,
  selection: Schema.Struct({
    start: PositionSchema,
    end: PositionSchema,
  }),
}).annotate({ identifier: "TuiEditorContext.SelectionRange" })

const EditorSelectionRangesSchema = Schema.Struct({
  filePath: Schema.String,
  source: Schema.optional(Schema.Literals(["websocket", "zed"])),
  ranges: Schema.mutable(Schema.Array(EditorSelectionRangeSchema).check(Schema.isMinLength(1))),
}).annotate({ identifier: "TuiEditorContext.SelectionRanges" })

const EditorSelectionSchema = Schema.Union([
  EditorSelectionRangesSchema,
  Schema.Struct({
    text: Schema.String,
    filePath: Schema.String,
    source: Schema.optional(Schema.Literals(["websocket", "zed"])),
    selection: Schema.Struct({
      start: PositionSchema,
      end: PositionSchema,
    }),
  }),
]).pipe(
  Schema.decodeTo(EditorSelectionRangesSchema, {
    decode: SchemaGetter.transform((value) =>
      "ranges" in value
        ? value
        : {
            filePath: value.filePath,
            source: value.source,
            ranges: [
              {
                text: value.text,
                selection: value.selection,
              },
            ],
          },
    ),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)

const EditorMentionSchema = Schema.Struct({
  filePath: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
}).annotate({ identifier: "TuiEditorContext.Mention" })

const EditorServerInfoSchema = Schema.Struct({
  protocolVersion: Schema.optional(Schema.String),
  serverInfo: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "TuiEditorContext.ServerInfo" })

const decodeJsonRpcMessage = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcMessageSchema))
const encodeJsonRpcOutgoing = Schema.encodeSync(Schema.fromJsonString(JsonRpcOutgoingSchema))
const decodeEditorSelection = Schema.decodeUnknownOption(EditorSelectionSchema)
const decodeEditorMention = Schema.decodeUnknownOption(EditorMentionSchema)
const decodeEditorServerInfo = Schema.decodeUnknownOption(EditorServerInfoSchema)

type JsonRpcMessage = Schema.Schema.Type<typeof JsonRpcMessageSchema>
type JsonRpcOutgoing = Schema.Schema.Type<typeof JsonRpcOutgoingSchema>
export type EditorSelection = Schema.Schema.Type<typeof EditorSelectionSchema>
export type EditorMention = Schema.Schema.Type<typeof EditorMentionSchema>
export type EditorLabelState = "pending" | "sent" | "none"
type EditorServerInfo = Schema.Schema.Type<typeof EditorServerInfoSchema>

type EditorConnection = {
  url: string
  authToken?: string
  source: string
}

export type EditorIntegration = Readonly<{
  connection?(directory: string): EditorConnection | undefined
  /** Reads the editor selection for a directory, for example from the Zed database. A failure keeps the last selection. */
  selection?(directory: string): Effect.Effect<unknown, unknown>
}>

// An empty variable counts as not set, as the former `||` chain did.
const setVariable = (name: string) =>
  Config.option(Config.String(name)).pipe(Config.map(Option.filter((value: string) => value.length > 0)))

// CLAUDE_CODE_SSE_PORT wins over OPENCODE_EDITOR_SSE_PORT. A value that does not parse to a port is ignored.
const EditorPortEnv = Config.all([setVariable("CLAUDE_CODE_SSE_PORT"), setVariable("OPENCODE_EDITOR_SSE_PORT")]).pipe(
  Config.map(([claude, opencode]) => Option.flatMap(Option.orElse(claude, () => opencode), parsePort)),
)

export const { use: useEditorContext, provider: EditorContextProvider } = createSimpleContext({
  name: "EditorContext",
  init: (props: { integration?: EditorIntegration; WebSocketImpl?: typeof WebSocket }) => {
    const paths = useTuiPaths()
    const editor = props.integration ?? editorIntegration
    const mentionListeners = MutableHashSet.empty<(mention: EditorMention) => void>()
    const WebSocketImpl = props.WebSocketImpl ?? WebSocket
    const [store, setStore] = createStore<{
      status: "disabled" | "connecting" | "connected"
      selection: Option.Option<EditorSelection>
      selectionSent: boolean
      server: Option.Option<EditorServerInfo>
      // The configured editor port and the Zed terminal flag. The provider reads both from the environment on mount.
      port: Option.Option<number>
      zedTerminal: boolean
    }>({
      status: "disabled",
      selection: Option.none(),
      selectionSent: false,
      server: Option.none(),
      port: Option.none(),
      zedTerminal: false,
    })

    let socket: Option.Option<WebSocket> = Option.none()
    let closed = false
    // The fiber that connects, or that waits to connect again. A new connection interrupts it, as
    // clearTimeout cancelled the former reconnect timer.
    let connecting: Option.Option<Fiber.Fiber<void>> = Option.none()
    let attempt = 0
    let requestID = 0
    // True while a Zed selection read runs, so that two reads do not overlap.
    let zedSelectionRunning = false
    let lastZedSelectionKey: Option.Option<string> = Option.none()
    let directory = paths.cwd
    let preserveSelectionOnReconnect = false
    // The method of each request that waits for its response, by request id.
    const pending = MutableHashMap.empty<number, string>()

    const isCurrentSocket = (candidate: WebSocket) => Option.exists(socket, (current) => current === candidate)

    const setSelection = (selection: Option.Option<EditorSelection>) => {
      const changed = selectionKey(selection) !== selectionKey(store.selection)
      setStore("selection", selection)
      if (changed) setStore("selectionSent", false)
    }

    const clearSelectionForReconnect = (options?: { resetZedSelectionKey?: boolean }) => {
      if (preserveSelectionOnReconnect) {
        preserveSelectionOnReconnect = false
        return
      }
      if (options?.resetZedSelectionKey) lastZedSelectionKey = Option.none()
      setSelection(Option.none())
    }

    const send = (payload: Omit<JsonRpcOutgoing, "jsonrpc">) => {
      const current = socket
      if (Option.isNone(current) || current.value.readyState !== 1) return
      current.value.send(encodeJsonRpcOutgoing({ jsonrpc: "2.0", ...payload }))
    }

    const request = (method: string, params: Schema.Json) => {
      requestID += 1
      MutableHashMap.set(pending, requestID, method)
      send({ id: requestID, method, params })
    }

    const applyZedSelection = (result: unknown) => {
      if (closed || Option.isSome(socket)) return
      if (!isRecord(result) || result.type === "unavailable") return
      const selection = result.type === "selection" ? decodeEditorSelection(result.selection) : Option.none()
      const key = selectionKey(selection)
      if (Option.contains(lastZedSelectionKey, key)) return
      lastZedSelectionKey = Option.some(key)
      setSelection(selection)
      setStore("status", Option.isSome(selection) ? "connected" : "disabled")
    }

    const readZedSelection = () => {
      if (zedSelectionRunning || !editor.selection) return
      zedSelectionRunning = true
      Effect.runFork(
        editor.selection(directory).pipe(
          Effect.tap((result) => Effect.sync(() => applyZedSelection(result))),
          // Keep the last known Zed selection for transient polling failures.
          Effect.ignore,
          Effect.ensuring(
            Effect.sync(() => {
              zedSelectionRunning = false
            }),
          ),
        ),
      )
    }

    const openSocket = (connection: EditorConnection) => {
      setStore("status", "connecting")
      const current = openEditorSocket(connection, WebSocketImpl)
      socket = Option.some(current)

      current.addEventListener("open", () => {
        if (!isCurrentSocket(current)) {
          current.close()
          return
        }

        attempt = 0
        setStore("status", "connected")
        request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "opencode", version: "0.0.0" },
        })
      })

      current.addEventListener("message", (event) => {
        const parsed = parseMessage(event.data)
        if (Option.isNone(parsed)) return
        const message = parsed.value

        const selection = message.method === "selection_changed" ? decodeEditorSelection(message.params) : Option.none()
        if (Option.isSome(selection)) {
          setSelection(Option.some({ ...selection.value, source: "websocket" }))
          return
        }

        const mention = message.method === "at_mentioned" ? decodeEditorMention(message.params) : Option.none()
        if (Option.isSome(mention)) {
          for (const listener of mentionListeners) listener(mention.value)
          return
        }

        if (typeof message.id !== "number") return

        const method = MutableHashMap.get(pending, message.id)
        if (Option.isNone(method)) return

        MutableHashMap.remove(pending, message.id)
        if (message.error) return

        const initialize = method.value === "initialize" ? decodeEditorServerInfo(message.result) : Option.none()
        if (Option.isSome(initialize)) {
          setStore("server", initialize)
          send({ method: "notifications/initialized" })
          return
        }
      })

      current.addEventListener("close", () => {
        if (!isCurrentSocket(current)) return

        socket = Option.none()
        MutableHashMap.clear(pending)
        if (closed) return

        setStore("status", "connecting")
        runConnect(Effect.sleep(nextReconnectDelay()).pipe(Effect.andThen(connectUntilOpen)))
      })
    }

    // Backs off 1, 2, 4 and 8 seconds, then 10 seconds, until a socket opens.
    const nextReconnectDelay = () => {
      attempt += 1
      return Duration.millis(Math.min(1000 * 2 ** (attempt - 1), 10_000))
    }

    // Tries once to reach the editor. The result is the delay before the next try, or none when a socket
    // holds the connection. In a Zed terminal with no socket, each try reads the Zed selection.
    const connectOnce = Effect.gen(function* () {
      const connection = resolveEditorConnection(directory, store.port, editor.connection)
      if (Option.isSome(connection)) {
        openSocket(connection.value)
        return Option.none<Duration.Duration>()
      }
      if (!store.zedTerminal || !editor.selection) {
        setStore("status", "disabled")
        return Option.some(nextReconnectDelay())
      }
      readZedSelection()
      return Option.some(Duration.seconds(1))
    })

    // Connects, then tries again after each delay until a socket holds the connection or the context closes.
    const connectUntilOpen: Effect.Effect<void> = Effect.suspend(() => {
      if (closed) return Effect.void
      return connectOnce.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (delay) => Effect.sleep(delay).pipe(Effect.andThen(connectUntilOpen)),
          }),
        ),
      )
    })

    const cancelConnect = () => {
      if (Option.isSome(connecting)) Effect.runFork(Fiber.interrupt(connecting.value))
      connecting = Option.none()
    }

    const runConnect = (effect: Effect.Effect<void>) => {
      cancelConnect()
      connecting = Option.some(Effect.runFork(effect))
    }

    const reconnectWithDirectory = (nextDirectory?: string) => {
      const resolved = nextDirectory || paths.cwd
      const sameDirectory = directory === resolved
      clearSelectionForReconnect({ resetZedSelectionKey: !sameDirectory })
      if (sameDirectory) return

      directory = resolved
      attempt = 0
      MutableHashMap.clear(pending)
      cancelConnect()
      if (Option.isSome(socket)) {
        const current = socket.value
        socket = Option.none()
        current.close()
      }
      setStore("status", "disabled")
      setStore("server", Option.none())
      runConnect(connectUntilOpen)
    }

    onMount(() => {
      runConnect(
        Effect.gen(function* () {
          const port = yield* readEnvSnapshot(EditorPortEnv)
          const zedTerminal = yield* isZedTerminal()
          setStore({ port, zedTerminal })
          yield* connectUntilOpen
        }),
      )

      onCleanup(() => {
        closed = true
        cancelConnect()
        if (Option.isSome(socket)) socket.value.close()
      })
    })

    return {
      enabled() {
        return (
          Option.isSome(resolveEditorConnection(directory, store.port, editor.connection)) ||
          (store.zedTerminal && Boolean(editor.selection))
        )
      },
      connected() {
        return store.status === "connected"
      },
      selection() {
        return Option.getOrUndefined(store.selection)
      },
      clearSelection() {
        lastZedSelectionKey = Option.none()
        zedSelectionRunning = false
        setSelection(Option.none())
      },
      preserveSelectionFromNewSession() {
        preserveSelectionOnReconnect = true
      },
      markSelectionSent() {
        if (Option.isNone(store.selection)) return
        setStore("selectionSent", true)
      },
      labelState(): EditorLabelState {
        if (Option.isNone(store.selection)) return "none"
        return store.selectionSent ? "sent" : "pending"
      },
      onMention(listener: (mention: EditorMention) => void) {
        MutableHashSet.add(mentionListeners, listener)
        return () => {
          MutableHashSet.remove(mentionListeners, listener)
        }
      },
      server() {
        return Option.getOrUndefined(store.server)
      },
      reconnect(directory?: string) {
        reconnectWithDirectory(directory)
      },
    }
  },
})

function parsePort(value: string): Option.Option<number> {
  const port = Number.parseInt(value, 10)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? Option.some(port) : Option.none()
}

function resolveEditorConnection(
  directory: string,
  port: Option.Option<number>,
  discover: ((directory: string) => EditorConnection | undefined) | undefined,
): Option.Option<EditorConnection> {
  if (Option.isSome(port)) {
    return Option.some({
      url: `ws://127.0.0.1:${port.value}`,
      source: `env:${port.value}`,
    })
  }

  return Option.fromNullishOr(discover?.(directory))
}

/** A key that differs when the file, a range or its text differs. An empty key means no selection. */
export function editorSelectionKey(selection: EditorSelection | undefined) {
  return selectionKey(Option.fromNullishOr(selection))
}

function selectionKey(selection: Option.Option<EditorSelection>) {
  if (Option.isNone(selection)) return ""
  return [
    selection.value.filePath,
    ...selection.value.ranges.flatMap((range) => [
      range.selection.start.line,
      range.selection.start.character,
      range.selection.end.line,
      range.selection.end.character,
      range.text,
    ]),
  ].join("\0")
}

function openEditorSocket(connection: EditorConnection, WebSocketImpl: typeof WebSocket) {
  if (!connection.authToken) return new WebSocketImpl(connection.url)

  return new WebSocketImpl(connection.url, {
    headers: {
      "x-claude-code-ide-authorization": connection.authToken,
    },
  } as any)
}

// A text frame that is not JSON, or JSON that is not a JSON-RPC message, decodes to none.
function parseMessage(value: unknown): Option.Option<JsonRpcMessage> {
  return typeof value === "string" ? decodeJsonRpcMessage(value) : Option.none()
}
