import type { WebContents } from "electron"
import { Array as Arr, Data, Effect, Schema } from "effect"

export class ForceFocusError extends Data.TaggedError("ForceFocusError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const focusDebuggerOwners = new WeakSet<WebContents>()
const forcedFocusNodes = new WeakMap<WebContents, number[]>()
const focusableSelector = `
  a[href],
  button:not([disabled]),
  input:not([disabled]),
  select:not([disabled]),
  textarea:not([disabled]),
  summary,
  [contenteditable="true"],
  [tabindex]:not([tabindex="-1"])
`

const DocumentResponse = Schema.Struct({ root: Schema.Struct({ nodeId: Schema.Number }) }).annotate({
  identifier: "DomGetDocumentResponse",
})
const QuerySelectorAllResponse = Schema.Struct({ nodeIds: Schema.Array(Schema.Number) }).annotate({
  identifier: "DomQuerySelectorAllResponse",
})

export const setForceFocus = Effect.fnUntraced(function* (contents: WebContents, enabled: boolean) {
  const debuggerApi = contents.debugger
  if (!debuggerApi.isAttached()) {
    if (!enabled) {
      focusDebuggerOwners.delete(contents)
      forcedFocusNodes.delete(contents)
      return
    }
    yield* Effect.try({ try: () => debuggerApi.attach("1.3"), catch: toForceFocusError })
    focusDebuggerOwners.add(contents)
    debuggerApi.once("detach", () => {
      focusDebuggerOwners.delete(contents)
      forcedFocusNodes.delete(contents)
    })
  }

  if (!enabled) {
    yield* forcePseudoState(contents, forcedFocusNodes.get(contents) ?? [], [])
    forcedFocusNodes.delete(contents)
    if (!focusDebuggerOwners.delete(contents)) return
    debuggerApi.detach()
    return
  }

  yield* sendCommand(contents, "DOM.enable")
  yield* sendCommand(contents, "CSS.enable")
  const document = yield* sendCommand(contents, "DOM.getDocument", { depth: -1, pierce: true }).pipe(
    Effect.flatMap(decodeResponse(DocumentResponse, "Invalid DOM.getDocument response")),
  )
  const nodes = yield* sendCommand(contents, "DOM.querySelectorAll", {
    nodeId: document.root.nodeId,
    selector: focusableSelector,
  }).pipe(Effect.flatMap(decodeResponse(QuerySelectorAllResponse, "Invalid DOM.querySelectorAll response")))
  forcedFocusNodes.set(contents, Arr.dedupe([...(forcedFocusNodes.get(contents) ?? []), ...nodes.nodeIds]))
  yield* forcePseudoState(contents, nodes.nodeIds, ["focus", "focus-visible"])
})

// Each node is forced independently and a failed node does not stop the others, as Promise.allSettled did.
const forcePseudoState = (contents: WebContents, nodeIds: readonly number[], forcedPseudoClasses: string[]) =>
  Effect.forEach(
    nodeIds,
    (nodeId) => sendCommand(contents, "CSS.forcePseudoState", { nodeId, forcedPseudoClasses }).pipe(Effect.ignore),
    { concurrency: "unbounded", discard: true },
  )

const sendCommand = (contents: WebContents, method: string, params?: object): Effect.Effect<unknown, ForceFocusError> =>
  Effect.tryPromise({ try: () => contents.debugger.sendCommand(method, params), catch: toForceFocusError })

const decodeResponse =
  <S extends Schema.Decoder<unknown>>(schema: S, message: string) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError((cause) => new ForceFocusError({ message, cause })))

// The IPC boundary forwards the message to the renderer, so an Electron debugger failure keeps its message text.
const toForceFocusError = (cause: unknown) =>
  new ForceFocusError({ message: cause instanceof Error ? cause.message : String(cause), cause })
