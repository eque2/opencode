import { For, Show, onMount, Suspense, onCleanup, createMemo, createSignal, SuspenseList } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Array as Arr, Duration, Effect, Fiber, Option, Predicate, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/schema/v1/session"
import { IconArrowDown } from "./icons"
import { IconOpencode } from "./icons/custom"
import { ShareI18nProvider, formatCurrency, formatNumber } from "./share/common"
import styles from "./share.module.css"
import type { MessageInfo, MessagePart, ToolPart } from "./share/message"
import type { Session } from "opencode/session/session"
import { Part, ProviderIcon, formatTimestamp } from "./share/part"

type MessageWithParts = MessageInfo & { parts: readonly MessagePart[] }

// A share_poll frame. The key names the record and the content is the record:
// "session/info" carries a Session, "session/message/<id>" a Message and
// "session/part/..." a Part. Each branch of applyFrame decodes the content.
const ShareFrame = Schema.Struct({
  key: Schema.String,
  content: Schema.Json,
}).annotate({ identifier: "ShareFrame" })
const decodeShareFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(ShareFrame))
const decodeSessionInfo = Schema.decodeUnknownEffect(SessionV1.SessionInfo)
const decodeMessageInfo = Schema.decodeUnknownEffect(SessionV1.Info)
// A current message frame can carry its parts next to the Info fields.
const decodeMessageParts = Schema.decodeUnknownEffect(
  Schema.Struct({ parts: Schema.optional(Schema.Array(SessionV1.Part)) }),
)
const decodePart = Schema.decodeUnknownEffect(SessionV1.Part)
const encodeDebugJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

// A legacy v1 message, recognised by its `metadata` field. Only the fields that
// fromV1 reads are declared; the field schemas come from SessionV1 so the
// decoded IDs carry the SessionV1 brands.
const LegacyToolCall = Schema.Struct({
  toolCallId: Schema.String.pipe(Schema.brand("LegacyToolCallID")),
  toolName: Schema.String,
  args: Schema.Record(Schema.String, Schema.Json),
}).annotate({ identifier: "LegacyToolCall" })
const LegacyToolInvocation = Schema.Union([
  Schema.Struct({ ...LegacyToolCall.fields, state: Schema.Literal("partial-call") }),
  Schema.Struct({ ...LegacyToolCall.fields, state: Schema.Literal("call") }),
  Schema.Struct({ ...LegacyToolCall.fields, state: Schema.Literal("result"), result: Schema.String }),
]).annotate({ discriminator: "state" })
const LegacyPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("step-start") }),
  Schema.Struct({ type: Schema.Literal("tool-invocation"), toolInvocation: LegacyToolInvocation }),
  Schema.Struct({
    type: Schema.Literal("file"),
    mediaType: Schema.String,
    filename: Schema.optional(Schema.String),
    url: Schema.String,
  }),
  // fromV1 drops these parts, so their other fields stay unread.
  Schema.Struct({ type: Schema.Literals(["reasoning", "source-url"]) }),
])
const legacyMessageFields = {
  id: SessionV1.Assistant.fields.id,
  parts: Schema.Array(LegacyPart),
}
const legacyMetadataFields = {
  sessionID: SessionV1.Assistant.fields.sessionID,
  time: SessionV1.Assistant.fields.time,
}
const LegacyMessage = Schema.Union([
  Schema.Struct({
    ...legacyMessageFields,
    role: Schema.Literal("user"),
    metadata: Schema.Struct(legacyMetadataFields),
  }),
  Schema.Struct({
    ...legacyMessageFields,
    role: Schema.Literal("assistant"),
    metadata: Schema.Struct({
      ...legacyMetadataFields,
      error: SessionV1.Assistant.fields.error,
      tool: Schema.Record(
        Schema.String,
        Schema.StructWithRest(
          Schema.Struct({
            title: Schema.String,
            time: Schema.Struct({ start: Schema.Finite, end: Schema.Finite }),
          }),
          [Schema.Record(Schema.String, Schema.Json)],
        ),
      ),
      assistant: Schema.Struct({
        modelID: SessionV1.Assistant.fields.modelID,
        providerID: SessionV1.Assistant.fields.providerID,
        path: SessionV1.Assistant.fields.path,
        cost: SessionV1.Assistant.fields.cost,
        summary: SessionV1.Assistant.fields.summary,
        tokens: Schema.optional(SessionV1.Assistant.fields.tokens),
      }),
    }),
  }),
]).annotate({ identifier: "LegacyMessage", discriminator: "role" })
type LegacyMessage = typeof LegacyMessage.Type
const decodeLegacyMessage = Schema.decodeUnknownEffect(LegacyMessage)

type Status = "disconnected" | "connecting" | "connected" | "error" | "reconnecting"

function scrollToAnchor(id: string) {
  const el = document.getElementById(id)
  if (!el) return

  el.scrollIntoView({ behavior: "smooth" })
}

function interruptFiber(fiber: Option.Option<Fiber.Fiber<void>>) {
  if (Option.isSome(fiber)) Effect.runFork(Fiber.interrupt(fiber.value))
}

function getStatusText(status: [Status, string?], messages: Record<string, string>): string {
  switch (status[0]) {
    case "connected":
      return messages.status_connected_waiting
    case "connecting":
      return messages.status_connecting
    case "disconnected":
      return messages.status_disconnected
    case "reconnecting":
      return messages.status_reconnecting
    case "error":
      return status[1] || messages.status_error
    default:
      return messages.status_unknown
  }
}

export default function Share(props: {
  id: string
  api: string
  info: Session.Info
  messages: { locale: string } & Record<string, string>
}) {
  let lastScrollY = 0
  let hasScrolledToAnchor = false
  let hideScrollButtonFiber: Option.Option<Fiber.Fiber<void>> = Option.none()
  let scrollSentinel: HTMLElement | undefined
  let scrollObserver: IntersectionObserver | undefined

  const params = new URLSearchParams(window.location.search)
  const debug = params.get("debug") === "true"

  const [showScrollButton, setShowScrollButton] = createSignal(false)
  const [isButtonHovered, setIsButtonHovered] = createSignal(false)
  const [isNearBottom, setIsNearBottom] = createSignal(false)

  const [store, setStore] = createStore<{
    info?: SessionV1.SessionInfo
    messages: Record<string, MessageWithParts>
  }>({
    info: {
      id: props.id,
      slug: props.info.slug,
      projectID: props.info.projectID,
      directory: props.info.directory,
      title: props.info.title,
      version: props.info.version,
      time: {
        created: props.info.time.created,
        updated: props.info.time.updated,
      },
    },
    messages: {},
  })
  const messages = createMemo(() =>
    Object.values(store.messages).toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id)),
  )
  const [connectionStatus, setConnectionStatus] = createSignal<[Status, string?]>(["disconnected"])

  onMount(() => {
    const apiUrl = props.api

    if (!props.id) {
      setConnectionStatus(["error", props.messages.error_id_not_found])
      return
    }

    if (!apiUrl) {
      Effect.runFork(Effect.logError("API URL not found in environment variables"))
      setConnectionStatus(["error", props.messages.error_api_url_not_found])
      return
    }

    let reconnectFiber: Option.Option<Fiber.Fiber<void>> = Option.none()
    let socket: Option.Option<WebSocket> = Option.none()

    const applyFrame = Effect.fnUntraced(function* (data: unknown) {
      const frame = yield* decodeShareFrame(data)
      const [root, type, ...splits] = frame.key.split("/")
      if (root !== "session") return
      if (type === "info") {
        setStore("info", reconcile(yield* decodeSessionInfo(frame.content)))
        return
      }
      if (type === "message") {
        const [, messageID] = splits
        const content = frame.content
        const message: MessageWithParts = Predicate.hasProperty(content, "metadata")
          ? yield* fromV1(yield* decodeLegacyMessage(content))
          : {
              ...(yield* decodeMessageInfo(content)),
              parts: (yield* decodeMessageParts(content)).parts ?? store.messages[messageID]?.parts ?? [],
            }
        setStore("messages", messageID, reconcile(message))
      }
      if (type === "part") {
        const part = yield* decodePart(frame.content)
        setStore("messages", part.messageID, "parts", (arr) => {
          const index = arr.findIndex((x) => x.id === part.id)
          return index === -1 ? [...arr, part] : arr.map((x, i) => (i === index ? part : x))
        })
      }
    })

    // Function to create and set up WebSocket with auto-reconnect
    const setupWebSocket = () => {
      // Close any existing connection
      if (Option.isSome(socket)) {
        socket.value.close()
      }

      setConnectionStatus(["connecting"])

      // Always use secure WebSocket protocol (wss)
      const wsBaseUrl = apiUrl.replace(/^https?:\/\//, "wss://")
      const wsUrl = `${wsBaseUrl}/share_poll?id=${props.id}`
      // Create WebSocket connection
      const ws = new WebSocket(wsUrl)
      socket = Option.some(ws)

      // Handle connection opening
      ws.onopen = () => {
        setConnectionStatus(["connected"])
      }

      // Handle incoming messages
      ws.onmessage = (event) => {
        Effect.runFork(
          applyFrame(event.data).pipe(
            Effect.catchCause((cause) => Effect.logError("Error parsing WebSocket message:", cause)),
          ),
        )
      }

      // Handle errors
      ws.onerror = (error) => {
        Effect.runFork(Effect.logError("WebSocket error:", error))
        setConnectionStatus(["error", props.messages.error_connection_failed])
      }

      // Handle connection close and reconnection
      ws.onclose = () => {
        setConnectionStatus(["reconnecting"])

        // Try to reconnect after 2 seconds
        interruptFiber(reconnectFiber)
        reconnectFiber = Option.some(
          Effect.runFork(Effect.sleep("2 seconds").pipe(Effect.andThen(Effect.sync(setupWebSocket)))),
        )
      }
    }

    // Initial connection
    setupWebSocket()

    // Clean up on component unmount
    onCleanup(() => {
      if (Option.isSome(socket)) {
        socket.value.close()
      }
      interruptFiber(reconnectFiber)
    })
  })

  // Hide the button after the delay unless it is hovered.
  function scheduleHideScrollButton(delay: Duration.Input) {
    hideScrollButtonFiber = Option.some(
      Effect.runFork(
        Effect.sleep(delay).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (!isButtonHovered()) {
                setShowScrollButton(false)
              }
            }),
          ),
        ),
      ),
    )
  }

  function checkScrollNeed() {
    const currentScrollY = window.scrollY
    const isScrollingDown = currentScrollY > lastScrollY
    const scrolled = currentScrollY > 200 // Show after scrolling 200px

    // Only show when scrolling down, scrolled enough, and not near bottom
    const shouldShow = isScrollingDown && scrolled && !isNearBottom()

    // Update last scroll position
    lastScrollY = currentScrollY

    if (shouldShow) {
      setShowScrollButton(true)
      // Clear existing timeout
      interruptFiber(hideScrollButtonFiber)
      // Hide button after 1.5 seconds of no scrolling (unless hovered)
      scheduleHideScrollButton("1500 millis")
    } else if (!isButtonHovered()) {
      // Only hide if not hovered (to prevent disappearing while user is about to click)
      setShowScrollButton(false)
      interruptFiber(hideScrollButtonFiber)
    }
  }

  onMount(() => {
    lastScrollY = window.scrollY // Initialize scroll position

    // Create sentinel element
    const sentinel = document.createElement("div")
    sentinel.style.height = "1px"
    sentinel.style.position = "absolute"
    sentinel.style.bottom = "100px"
    sentinel.style.width = "100%"
    sentinel.style.pointerEvents = "none"
    document.body.appendChild(sentinel)

    // Create intersection observer
    const observer = new IntersectionObserver((entries) => {
      setIsNearBottom(entries[0].isIntersecting)
    })
    observer.observe(sentinel)

    // Store references for cleanup
    scrollSentinel = sentinel
    scrollObserver = observer

    checkScrollNeed()
    window.addEventListener("scroll", checkScrollNeed)
    window.addEventListener("resize", checkScrollNeed)
  })

  onCleanup(() => {
    window.removeEventListener("scroll", checkScrollNeed)
    window.removeEventListener("resize", checkScrollNeed)

    // Clean up observer and sentinel
    if (scrollObserver) {
      scrollObserver.disconnect()
    }
    if (scrollSentinel) {
      document.body.removeChild(scrollSentinel)
    }

    interruptFiber(hideScrollButtonFiber)
  })

  const data = createMemo(() => {
    const info = Option.fromNullishOr(store.info)
    const msgs = Option.isSome(info) ? messages() : []
    const assistants = Arr.flatMap(msgs, (msg) => (msg.role === "assistant" ? [msg] : []))
    const sum = (read: (msg: (typeof assistants)[number]) => number) =>
      Arr.reduce(assistants, 0, (total, msg) => total + read(msg))

    return {
      rootDir: Option.map(
        Arr.findLast(assistants, (msg) => Boolean(msg.path.root)),
        (msg) => msg.path.root,
      ),
      created: Option.map(info, (value) => value.time.created),
      completed: Option.map(
        Arr.findLast(assistants, (msg) => Boolean(msg.time.completed)),
        (msg) => msg.time.completed,
      ),
      messages: msgs,
      models: Object.fromEntries(
        Arr.map(assistants, (msg): [string, string[]] => [
          `${msg.providerID} ${msg.modelID}`,
          [msg.providerID, msg.modelID],
        ]),
      ),
      cost: sum((msg) => msg.cost),
      tokens: {
        input: sum((msg) => msg.tokens.input),
        output: sum((msg) => msg.tokens.output),
        reasoning: sum((msg) => msg.tokens.reasoning),
      },
    }
  })

  return (
    <Show when={store.info}>
      <ShareI18nProvider messages={props.messages}>
        <main classList={{ [styles.root]: true, "not-content": true }}>
          <div data-component="header">
            <h1 data-component="header-title">{store.info?.title}</h1>
            <div data-component="header-details">
              <ul data-component="header-stats">
                <li title={props.messages.opencode_version} data-slot="item">
                  <div data-slot="icon" title={props.messages.opencode_name}>
                    <IconOpencode width={16} height={16} />
                  </div>
                  <Show when={store.info?.version} fallback="v0.0.1">
                    <span>v{store.info?.version}</span>
                  </Show>
                </li>
                {Object.values(data().models).length > 0 ? (
                  <For each={Object.values(data().models)}>
                    {([provider, model]) => (
                      <li data-slot="item">
                        <div data-slot="icon" title={provider}>
                          <ProviderIcon model={model} />
                        </div>
                        <span data-slot="model">{model}</span>
                      </li>
                    )}
                  </For>
                ) : (
                  <li>
                    <span data-element-label>{props.messages.models}</span>
                    <span data-placeholder>&mdash;</span>
                  </li>
                )}
              </ul>
              <div
                data-component="header-time"
                title={formatTimestamp(
                  Option.getOrElse(data().created, () => 0),
                  props.messages.locale,
                  "full",
                )}
              >
                {formatTimestamp(
                  Option.getOrElse(data().created, () => 0),
                  props.messages.locale,
                  "medium",
                )}
              </div>
            </div>
          </div>

          <div>
            <Show when={data().messages.length > 0} fallback={<p>{props.messages.waiting_for_messages}</p>}>
              <div class={styles.parts}>
                <SuspenseList revealOrder="forwards">
                  <For each={data().messages}>
                    {(msg, msgIndex) => {
                      const filteredParts = createMemo(() =>
                        msg.parts.filter((x, index) => {
                          if (x.type === "step-start" && index > 0) return false
                          if (x.type === "snapshot") return false
                          if (x.type === "patch") return false
                          if (x.type === "step-finish") return false
                          if (x.type === "text" && x.synthetic === true) return false
                          if (x.type === "text" && !x.text) return false
                          if (x.type === "tool" && (x.state.status === "pending" || x.state.status === "running"))
                            return false
                          return true
                        }),
                      )

                      return (
                        <Suspense>
                          <For each={filteredParts()}>
                            {(part, partIndex) => {
                              const last = () =>
                                data().messages.length === msgIndex() + 1 && filteredParts().length === partIndex() + 1

                              onMount(() => {
                                const hash = window.location.hash.slice(1)
                                // Wait till all parts are loaded
                                if (hash !== "" && !hasScrolledToAnchor && last()) {
                                  hasScrolledToAnchor = true
                                  scrollToAnchor(hash)
                                }
                              })

                              return <Part last={last()} part={part} index={partIndex()} message={msg} />
                            }}
                          </For>
                        </Suspense>
                      )
                    }}
                  </For>
                </SuspenseList>
                <div data-section="part" data-part-type="summary">
                  <div data-section="decoration">
                    <span data-status={connectionStatus()[0]}></span>
                  </div>
                  <div data-section="content">
                    <p data-section="copy">{getStatusText(connectionStatus(), props.messages)}</p>
                    <ul data-section="stats">
                      <li>
                        <span data-element-label>{props.messages.cost}</span>
                        {data().cost !== undefined ? (
                          <span>{formatCurrency(data().cost, props.messages.locale)}</span>
                        ) : (
                          <span data-placeholder>&mdash;</span>
                        )}
                      </li>
                      <li>
                        <span data-element-label>{props.messages.input_tokens}</span>
                        {data().tokens.input ? (
                          <span>{formatNumber(data().tokens.input, props.messages.locale)}</span>
                        ) : (
                          <span data-placeholder>&mdash;</span>
                        )}
                      </li>
                      <li>
                        <span data-element-label>{props.messages.output_tokens}</span>
                        {data().tokens.output ? (
                          <span>{formatNumber(data().tokens.output, props.messages.locale)}</span>
                        ) : (
                          <span data-placeholder>&mdash;</span>
                        )}
                      </li>
                      <li>
                        <span data-element-label>{props.messages.reasoning_tokens}</span>
                        {data().tokens.reasoning ? (
                          <span>{formatNumber(data().tokens.reasoning, props.messages.locale)}</span>
                        ) : (
                          <span data-placeholder>&mdash;</span>
                        )}
                      </li>
                    </ul>
                  </div>
                </div>
              </div>
            </Show>
          </div>

          <Show when={debug}>
            <div style={{ margin: "2rem 0" }}>
              <div
                style={{
                  border: "1px solid #ccc",
                  padding: "1rem",
                  "overflow-y": "auto",
                }}
              >
                <Show when={data().messages.length > 0} fallback={<p>{props.messages.waiting_for_messages}</p>}>
                  <ul style={{ "list-style-type": "none", padding: 0 }}>
                    <For each={data().messages}>
                      {(msg) => (
                        <li
                          style={{
                            padding: "0.75rem",
                            margin: "0.75rem 0",
                            "box-shadow": "0 1px 3px rgba(0,0,0,0.1)",
                          }}
                        >
                          <div>
                            <strong>{props.messages.debug_key}:</strong> {msg.id}
                          </div>
                          <pre>{encodeDebugJson(msg)}</pre>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            </div>
          </Show>

          <Show when={showScrollButton()}>
            <button
              type="button"
              class={styles["scroll-button"]}
              onClick={() => document.body.scrollIntoView({ behavior: "smooth", block: "end" })}
              onMouseEnter={() => {
                setIsButtonHovered(true)
                interruptFiber(hideScrollButtonFiber)
              }}
              onMouseLeave={() => {
                setIsButtonHovered(false)
                if (showScrollButton()) {
                  scheduleHideScrollButton("3 seconds")
                }
              }}
              title={props.messages.scroll_to_bottom}
              aria-label={props.messages.scroll_to_bottom}
            >
              <IconArrowDown width={20} height={20} />
            </button>
          </Show>
        </main>
      </ShareI18nProvider>
    </Show>
  )
}

export class ShareV1MessageError extends Schema.TaggedError<ShareV1MessageError>()("ShareV1MessageError", {
  message: Schema.String,
}) {}

export const fromV1 = Effect.fnUntraced(function* (v1: LegacyMessage) {
  if (v1.role === "assistant") {
    const metadata = v1.metadata
    const parts = yield* Effect.forEach(v1.parts, (part, index) =>
      Effect.gen(function* (): Effect.gen.Return<MessagePart[], ShareV1MessageError> {
        const base = {
          id: index.toString(),
          messageID: v1.id,
          sessionID: metadata.sessionID,
        }
        if (part.type === "text") {
          return [
            {
              ...base,
              type: "text",
              text: part.text,
            },
          ]
        }
        if (part.type === "step-start") {
          return [
            {
              ...base,
              type: "step-start",
            },
          ]
        }
        if (part.type === "tool-invocation") {
          const invocation = part.toolInvocation
          return [
            {
              ...base,
              type: "tool",
              callID: invocation.toolCallId,
              tool: invocation.toolName,
              state: yield* Effect.gen(function* (): Effect.gen.Return<ToolPart["state"], ShareV1MessageError> {
                if (invocation.state === "partial-call") {
                  return {
                    status: "pending",
                    input: {},
                    raw: "",
                  }
                }

                const tool = Option.fromNullishOr(metadata.tool[invocation.toolCallId])
                if (Option.isNone(tool)) {
                  return yield* new ShareV1MessageError({ message: "missing tool invocation metadata" })
                }
                const { title, time, ...toolMetadata } = tool.value
                if (invocation.state === "call") {
                  return {
                    status: "running",
                    input: invocation.args,
                    time: {
                      start: time.start,
                    },
                  }
                }

                return {
                  status: "completed",
                  input: invocation.args,
                  output: invocation.result,
                  title,
                  time,
                  metadata: toolMetadata,
                }
              }),
            },
          ]
        }
        return []
      }),
    )
    const assistant = metadata.assistant
    const message: MessageWithParts = {
      id: v1.id,
      sessionID: metadata.sessionID,
      role: "assistant",
      parentID: "",
      agent: "build",
      time: {
        created: metadata.time.created,
        completed: metadata.time.completed,
      },
      cost: assistant.cost,
      path: assistant.path,
      summary: assistant.summary,
      tokens: assistant.tokens ?? {
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0,
        },
        reasoning: 0,
      },
      modelID: assistant.modelID,
      providerID: assistant.providerID,
      mode: "build",
      error: metadata.error,
      parts: Arr.flatten(parts),
    }
    return message
  }

  const message: MessageWithParts = {
    id: v1.id,
    sessionID: v1.metadata.sessionID,
    role: "user",
    agent: "user",
    model: {
      providerID: "",
      modelID: "",
    },
    time: {
      created: v1.metadata.time.created,
    },
    parts: v1.parts.flatMap((part, index): MessagePart[] => {
      const base = {
        id: index.toString(),
        messageID: v1.id,
        sessionID: v1.metadata.sessionID,
      }
      if (part.type === "text") {
        return [
          {
            ...base,
            type: "text",
            text: part.text,
          },
        ]
      }
      if (part.type === "file") {
        return [
          {
            ...base,
            type: "file",
            mime: part.mediaType,
            filename: part.filename,
            url: part.url,
          },
        ]
      }
      return []
    }),
  }
  return message
})
