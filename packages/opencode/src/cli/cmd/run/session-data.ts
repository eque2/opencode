// Core reducer for direct interactive mode.
//
// Takes raw SDK events and produces two outputs:
//   - StreamCommit[]: append-only scrollback entries (text, tool, error, etc.)
//   - FooterOutput:   status bar patches and view transitions (permission, question)
//
// The reducer mutates SessionData in place for performance but has no
// external side effects -- no IO, no footer calls. The caller
// (stream.transport.ts) feeds events in and forwards output to the footer
// through stream.ts.
//
// Key design decisions:
//
// - Text parts buffer in `data.text` until their message role is confirmed as
//   "assistant". This prevents echoing user-role text parts. The `ready()`
//   check gates output: if we see a text delta before the message.updated
//   event that tells us the role, we stash it and flush later via `replay()`.
//
// - Tool echo stripping: bash tools may echo their own output in the next
//   assistant text part. `stashEcho()` records completed bash output, and
//   `stripEcho()` removes it from the start of the next assistant chunk.
//
// - Permission and question requests queue in `data.permissions` and
//   `data.questions`. The footer shows whichever is first. When a reply
//   event arrives, the queue entry is removed and the footer falls back
//   to the next pending request or to the prompt view.
import { Array as Arr, MutableHashMap, MutableHashSet, Option } from "effect"
import type { Event, Part, PermissionRequest, QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2"
import * as Locale from "@/util/locale"
import { toolView } from "./tool"
import type { FooterOutput, FooterPatch, FooterView, StreamCommit } from "./types"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

type Tokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: {
    read?: number
    write?: number
  }
}

type PartKind = "assistant" | "reasoning" | "user"
type MessageRole = "assistant" | "user"
type Dict = Record<string, unknown>
type SessionCommit = StreamCommit

// Mutable accumulator for the reducer. Each field tracks a different aspect
// of the stream so we can produce correct incremental output:
//
// - ids:    parts and error keys we've already committed (dedup guard)
// - tools:  tool parts we've emitted a "start" for but not yet completed
// - call:   tool call inputs, keyed by msg:call, for enriching permission views
// - role:   message ID → "assistant" | "user", learned from message.updated
// - msg:    part ID → message ID
// - part:   part ID → "assistant" | "reasoning" (text parts only)
// - text:   part ID → full accumulated text so far
// - sent:   part ID → byte offset of last flushed text (for incremental output)
// - visible: part ID → rendered text for an active part after display transforms
// - end:    part IDs whose time.end has arrived (part is finished)
// - shell:  shell call ID → chosen transcript source for direct shell calls
// - echo:   message ID → bash outputs to strip from the next assistant chunk
type ShellCall = {
  source: "shell" | "tool"
  command?: string
}

export type SessionData = {
  includeUserText: boolean
  announced: boolean
  ids: MutableHashSet.MutableHashSet<string>
  tools: MutableHashSet.MutableHashSet<string>
  call: MutableHashMap.MutableHashMap<string, Dict>
  shell: MutableHashMap.MutableHashMap<string, ShellCall>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  role: MutableHashMap.MutableHashMap<string, MessageRole>
  msg: MutableHashMap.MutableHashMap<string, string>
  part: MutableHashMap.MutableHashMap<string, PartKind>
  text: MutableHashMap.MutableHashMap<string, string>
  sent: MutableHashMap.MutableHashMap<string, number>
  visible: MutableHashMap.MutableHashMap<string, string>
  end: MutableHashSet.MutableHashSet<string>
  echo: MutableHashMap.MutableHashMap<string, MutableHashSet.MutableHashSet<string>>
}

export type SessionDataInput = {
  data: SessionData
  event: Event
  sessionID: string
  thinking: boolean
  limits: Record<string, number>
}

export type SessionDataOutput = {
  data: SessionData
  commits: SessionCommit[]
  footer?: FooterOutput
}

export function createSessionData(
  input: {
    includeUserText?: boolean
  } = {},
): SessionData {
  return {
    includeUserText: input.includeUserText ?? false,
    announced: false,
    ids: MutableHashSet.empty(),
    tools: MutableHashSet.empty(),
    call: MutableHashMap.empty(),
    shell: MutableHashMap.empty(),
    permissions: [],
    questions: [],
    role: MutableHashMap.empty(),
    msg: MutableHashMap.empty(),
    part: MutableHashMap.empty(),
    text: MutableHashMap.empty(),
    sent: MutableHashMap.empty(),
    visible: MutableHashMap.empty(),
    end: MutableHashSet.empty(),
    echo: MutableHashMap.empty(),
  }
}

// Reads a keyed value from a SessionData map, with a fallback for an absent key.
export function lookup<V>(map: MutableHashMap.MutableHashMap<string, V>, key: string, fallback: V): V {
  return Option.getOrElse(MutableHashMap.get(map, key), () => fallback)
}

// Message and part IDs are non-empty strings; an empty ID counts as absent, as it did with Map lookups.
function lookupID(map: MutableHashMap.MutableHashMap<string, string>, key: string): Option.Option<string> {
  return MutableHashMap.get(map, key).pipe(Option.filter((value) => value !== ""))
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

function formatUsage(
  tokens: Tokens | undefined,
  limit: number | undefined,
  cost: number | undefined,
): string | undefined {
  const total =
    (tokens?.input ?? 0) +
    (tokens?.output ?? 0) +
    (tokens?.reasoning ?? 0) +
    (tokens?.cache?.read ?? 0) +
    (tokens?.cache?.write ?? 0)

  if (total <= 0) {
    if (typeof cost === "number" && cost > 0) {
      return money.format(cost)
    }
    return undefined
  }

  const text =
    limit && limit > 0 ? `${Locale.number(total)} (${Math.round((total / limit) * 100)}%)` : Locale.number(total)

  if (typeof cost === "number" && cost > 0) {
    return `${text} · ${money.format(cost)}`
  }

  return text
}

export function formatError(error: { name?: string; message?: string; data?: unknown }): string {
  const data = error.data
  if (data && typeof data === "object" && "message" in data && typeof data.message === "string" && data.message) {
    return data.message
  }

  if (error.message) {
    return error.message
  }

  if (error.name) {
    return error.name
  }

  return "unknown error"
}

function isAbort(error: { name?: string } | undefined): boolean {
  return error?.name === "MessageAbortedError"
}

function msgErr(id: string): string {
  return `msg:${id}:error`
}

function patch(patch?: FooterPatch, view?: FooterView): FooterOutput | undefined {
  if (!patch && !view) {
    return undefined
  }

  return {
    patch,
    view,
  }
}

function out(data: SessionData, commits: SessionCommit[], footer?: FooterOutput): SessionDataOutput {
  if (!footer) {
    return {
      data,
      commits,
    }
  }

  return {
    data,
    commits,
    footer,
  }
}

export function pickBlockerView(input: { permission?: PermissionRequest; question?: QuestionRequest }): FooterView {
  if (input.permission) {
    return { type: "permission", request: input.permission }
  }

  if (input.question) {
    return { type: "question", request: input.question }
  }

  return { type: "prompt" }
}

export function blockerStatus(view: FooterView) {
  if (view.type === "permission") {
    return "awaiting permission"
  }

  if (view.type === "question") {
    return "awaiting answer"
  }

  return ""
}

function pickSessionView(data: SessionData): FooterView {
  return pickBlockerView({
    permission: data.permissions[0],
    question: data.questions[0],
  })
}

function queueFooter(data: SessionData): FooterOutput {
  const view = pickSessionView(data)

  return {
    view,
    patch: { status: blockerStatus(view) },
  }
}

function queueOut(data: SessionData, commits: SessionCommit[]): SessionDataOutput {
  return out(data, commits, queueFooter(data))
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((entry) => entry.id === item.id)
  if (idx === -1) {
    return Arr.append(list, item)
  }

  return list.map((entry, index) => (index === idx ? item : entry))
}

// Returns the list without the first entry that has this ID, or none when no entry matches.
function remove<T extends { id: string }>(list: T[], id: string): Option.Option<T[]> {
  const idx = list.findIndex((entry) => entry.id === id)
  if (idx === -1) {
    return Option.none()
  }

  return Option.some(Arr.remove(list, idx))
}

export function bootstrapSessionData(input: {
  data: SessionData
  messages: Array<{
    parts: Part[]
  }>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
}) {
  for (const message of input.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") {
        continue
      }

      MutableHashMap.set(input.data.call, key(part.messageID, part.callID), part.state.input)
    }
  }

  for (const request of input.permissions.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    input.data.permissions = upsert(input.data.permissions, enrichPermission(input.data, request))
  }

  for (const request of input.questions.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    input.data.questions = upsert(input.data.questions, request)
  }
}

function key(msg: string, call: string): string {
  return `${msg}:${call}`
}

function enrichPermission(data: SessionData, request: PermissionRequest): PermissionRequest {
  if (!request.tool) {
    return request
  }

  const found = MutableHashMap.get(data.call, key(request.tool.messageID, request.tool.callID))
  if (Option.isNone(found)) {
    return request
  }

  const input = found.value

  const meta = request.metadata ?? {}
  if (meta.input === input) {
    return request
  }

  return {
    ...request,
    metadata: {
      ...meta,
      input,
    },
  }
}

// Updates the active permission request when the matching tool part gets
// new input (e.g., a diff). This keeps the permission UI in sync with the
// tool's evolving state. Only triggers a footer update if the currently
// displayed permission was the one that changed.
function syncPermission(data: SessionData, part: ToolPart): FooterOutput | undefined {
  MutableHashMap.set(data.call, key(part.messageID, part.callID), part.state.input)
  if (data.permissions.length === 0) {
    return undefined
  }

  let changed = false
  let active = false
  data.permissions = data.permissions.map((request, index) => {
    if (!request.tool || request.tool.messageID !== part.messageID || request.tool.callID !== part.callID) {
      return request
    }

    const next = enrichPermission(data, request)
    if (next === request) {
      return request
    }

    changed = true
    active ||= index === 0
    return next
  })

  if (!changed || !active) {
    return undefined
  }

  return {
    view: pickSessionView(data),
  }
}

// Question tool replies can complete without a matching question.replied event.
// When that happens, drop the recovered pending request tied to this tool call so
// the footer can return to the next blocker or to the prompt.
function syncQuestion(data: SessionData, part: ToolPart): FooterOutput | undefined {
  if (part.tool !== "question") {
    return undefined
  }

  if (part.state.status !== "completed" && part.state.status !== "error") {
    return undefined
  }

  const next = data.questions.filter(
    (request) => request.tool?.messageID !== part.messageID || request.tool?.callID !== part.callID,
  )
  if (next.length === data.questions.length) {
    return undefined
  }

  data.questions = next
  return queueFooter(data)
}

function toolStatus(part: ToolPart): string {
  if (part.tool !== "task") {
    return `running ${part.tool}`
  }

  const state = part.state as {
    input?: {
      description?: unknown
      subagent_type?: unknown
    }
  }
  const desc = state.input?.description
  if (typeof desc === "string" && desc.trim()) {
    return `running ${desc.trim()}`
  }

  const type = state.input?.subagent_type
  if (typeof type === "string" && type.trim()) {
    return `running ${type.trim()}`
  }

  return "running task"
}

// Returns true if we can flush this part's text to scrollback.
//
// We gate on the message role being "assistant" because user-role messages
// also contain text parts (the user's own input) which we don't want to
// echo. If we haven't received the message.updated event yet, we return
// false and the text stays buffered until replay() flushes it.
function ready(data: SessionData, partID: string): boolean {
  const msg = lookupID(data.msg, partID)
  if (Option.isNone(msg)) {
    return true
  }

  const role = MutableHashMap.get(data.role, msg.value)
  if (Option.isNone(role)) {
    return false
  }

  if (role.value === "assistant") {
    return true
  }

  return data.includeUserText && role.value === "user"
}

function syncText(data: SessionData, partID: string, next: string) {
  const prev = lookup(data.text, partID, "")
  if (!next) {
    return prev
  }

  if (!prev || next.length >= prev.length) {
    MutableHashMap.set(data.text, partID, next)
    return next
  }

  return prev
}

// Records bash tool output for echo stripping. Some models echo bash output
// verbatim at the start of their next text part. We save both the raw and
// trimmed forms so stripEcho() can match either.
function stashEcho(data: SessionData, part: ToolPart) {
  if (part.tool !== "bash") {
    return
  }

  if (typeof part.messageID !== "string" || !part.messageID) {
    return
  }

  if (!("output" in part.state) || typeof part.state.output !== "string") {
    return
  }

  const text = part.state.output.replace(/^\n+/, "")
  if (!text.trim()) {
    return
  }

  const set = Option.getOrElse(MutableHashMap.get(data.echo, part.messageID), () => MutableHashSet.empty<string>())
  MutableHashSet.add(set, text)
  const trim = text.replace(/\n+$/, "")
  if (trim && trim !== text) {
    MutableHashSet.add(set, trim)
  }
  MutableHashMap.set(data.echo, part.messageID, set)
}

function stripEcho(data: SessionData, msg: string | undefined, chunk: string): string {
  if (!msg) {
    return chunk
  }

  const set = MutableHashMap.get(data.echo, msg)
  if (Option.isNone(set) || MutableHashSet.size(set.value) === 0) {
    return chunk
  }

  MutableHashMap.remove(data.echo, msg)
  const list = [...set.value].sort((a, b) => b.length - a.length)
  for (const item of list) {
    if (!item || !chunk.startsWith(item)) {
      continue
    }

    return chunk.slice(item.length).replace(/^\n+/, "")
  }

  return chunk
}

function flushPart(data: SessionData, partID: string, interrupted = false): SessionCommit[] {
  const found = MutableHashMap.get(data.part, partID)
  if (Option.isNone(found)) {
    return []
  }

  const kind = found.value
  const text = lookup(data.text, partID, "")
  const sent = lookup(data.sent, partID, 0)
  let chunk = text.slice(sent)
  // StreamCommit.messageID is an optional string field of the footer contract.
  const msg = Option.getOrUndefined(MutableHashMap.get(data.msg, partID))

  if (sent === 0) {
    chunk = chunk.replace(/^\n+/, "")
    // Some models emit a standalone whitespace token before real content.
    // Keep buffering until we have visible text so scrollback doesn't get a blank row.
    if (!chunk.trim()) {
      return []
    }
    if (kind === "reasoning" && chunk) {
      chunk = `Thinking: ${chunk.replace(/\[REDACTED\]/g, "")}`
    }
    if (kind === "assistant" && chunk) {
      chunk = stripEcho(data, msg, chunk)
      if (!chunk.trim()) {
        return []
      }
    }
  }

  const progress: SessionCommit[] = chunk
    ? [
        {
          kind,
          text: chunk,
          phase: "progress",
          source: kind === "user" ? "system" : kind,
          messageID: msg,
          partID,
        },
      ]
    : []
  if (chunk) {
    MutableHashMap.set(data.sent, partID, text.length)
    MutableHashMap.set(data.visible, partID, lookup(data.visible, partID, "") + chunk)
  }

  if (!interrupted) {
    return progress
  }

  return Arr.append(progress, {
    kind,
    text: "",
    phase: "final",
    source: kind === "user" ? "system" : kind,
    messageID: msg,
    partID,
    interrupted: true,
  })
}

function drop(data: SessionData, partID: string) {
  MutableHashMap.remove(data.part, partID)
  MutableHashMap.remove(data.text, partID)
  MutableHashMap.remove(data.sent, partID)
  MutableHashMap.remove(data.visible, partID)
  MutableHashMap.remove(data.msg, partID)
  MutableHashSet.remove(data.end, partID)
}

// Called when we learn a message's role (from message.updated). Flushes any
// buffered text parts that were waiting on role confirmation. User-role
// parts are silently dropped.
//
// Each step only drops its own part, so a snapshot of the entries visits the
// same parts in the same order as the live map did.
function replay(data: SessionData, messageID: string, role: MessageRole, thinking: boolean): SessionCommit[] {
  return [...data.msg].flatMap(([partID, msg]) => {
    if (msg !== messageID || MutableHashSet.has(data.ids, partID)) {
      return []
    }

    if (role === "user" && !data.includeUserText) {
      MutableHashSet.add(data.ids, partID)
      drop(data, partID)
      return []
    }

    const found = MutableHashMap.get(data.part, partID)
    if (Option.isNone(found)) {
      return []
    }

    const kind = found.value
    if (role === "user" && kind === "assistant") {
      MutableHashMap.set(data.part, partID, "user")
    }

    if (kind === "reasoning" && !thinking) {
      if (MutableHashSet.has(data.end, partID)) {
        MutableHashSet.add(data.ids, partID)
      }
      drop(data, partID)
      return []
    }

    const flushed = flushPart(data, partID)

    if (MutableHashSet.has(data.end, partID)) {
      MutableHashSet.add(data.ids, partID)
      drop(data, partID)
    }

    return flushed
  })
}

function toolCommit(
  part: ToolPart,
  next: Pick<SessionCommit, "text" | "phase" | "toolState"> & { toolError?: string },
): SessionCommit {
  return {
    kind: "tool",
    source: "tool",
    messageID: part.messageID,
    partID: part.id,
    tool: part.tool,
    part,
    ...next,
  }
}

function shellPartID(callID: string): string {
  return `shell:${callID}`
}

function claimShell(
  data: SessionData,
  callID: string,
  source: ShellCall["source"],
  command: Option.Option<string>,
): ShellCall {
  // An empty command string counts as no command.
  const known = Option.filter(command, (value) => value !== "")
  const found = MutableHashMap.get(data.shell, callID)
  if (Option.isSome(found)) {
    const current = found.value
    if (Option.isSome(known) && !current.command) {
      current.command = known.value
    }

    return current
  }

  const next = {
    source,
    ...(Option.isSome(known) ? { command: known.value } : {}),
  } satisfies ShellCall
  MutableHashMap.set(data.shell, callID, next)
  return next
}

function bashCommand(part: ToolPart): Option.Option<string> {
  if (part.tool !== "bash") {
    return Option.none()
  }

  const input = part.state.input
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return Option.none()
  }

  const command = Reflect.get(input, "command")
  return typeof command === "string" ? Option.some(command) : Option.none()
}

function shellCommit(
  input: {
    callID: string
    command: string
  },
  next: Pick<SessionCommit, "text" | "phase" | "toolState">,
): SessionCommit {
  return {
    kind: "tool",
    source: "tool",
    partID: shellPartID(input.callID),
    tool: "bash",
    shell: input,
    ...next,
  }
}

function startShell(callID: string, command: string): SessionCommit {
  return shellCommit(
    {
      callID,
      command,
    },
    {
      text: "running shell",
      phase: "start",
      toolState: "running",
    },
  )
}

function doneShell(callID: string, command: string, output: string): SessionCommit {
  return shellCommit(
    {
      callID,
      command,
    },
    {
      text: output,
      phase: "progress",
      toolState: "completed",
    },
  )
}

function startTool(part: ToolPart): SessionCommit {
  return toolCommit(part, {
    text: toolStatus(part),
    phase: "start",
    toolState: "running",
  })
}

function doneTool(part: ToolPart): SessionCommit {
  return toolCommit(part, {
    text: "",
    phase: "final",
    toolState: "completed",
  })
}

function failTool(part: ToolPart, text: string): SessionCommit {
  return toolCommit(part, {
    text,
    phase: "final",
    toolState: "error",
    toolError: text,
  })
}

// Emits "interrupted" final entries for all in-flight parts. Called when a turn is aborted.
export function flushInterrupted(data: SessionData): SessionCommit[] {
  return [...MutableHashMap.keys(data.part)].flatMap((partID) => {
    if (MutableHashSet.has(data.ids, partID)) {
      return []
    }

    const user = lookupID(data.msg, partID).pipe(
      Option.flatMap((msg) => MutableHashMap.get(data.role, msg)),
      Option.contains("user"),
    )
    if (user && !data.includeUserText) {
      MutableHashSet.add(data.ids, partID)
      drop(data, partID)
      return []
    }

    const flushed = flushPart(data, partID, true)
    MutableHashSet.add(data.ids, partID)
    drop(data, partID)
    return flushed
  })
}

// Records a message role and flushes the parts that waited on it.
function learnRole(data: SessionData, messageID: string, role: MessageRole, thinking: boolean) {
  MutableHashMap.set(data.role, messageID, role)
  return replay(data, messageID, role, thinking)
}

// Marks the message error as committed and builds its scrollback entry.
function messageError(data: SessionData, messageID: string, error: Parameters<typeof formatError>[0]): SessionCommit {
  MutableHashSet.add(data.ids, msgErr(messageID))
  return {
    kind: "error",
    text: formatError(error),
    phase: "start",
    source: "system",
    messageID,
  }
}

// The main reducer. Takes one SDK event and returns scrollback commits and
// footer updates. Called once per event from the stream transport's watch loop.
//
// Event handling follows the SDK event types:
//   message.updated      → learn role, flush buffered parts, track usage
//   message.part.delta   → accumulate text, flush if ready
//   message.part.updated → handle text/reasoning/tool state transitions
//   permission.*         → manage the permission queue, drive footer view
//   question.*           → manage the question queue, drive footer view
//   session.error        → emit error scrollback entry
export function reduceSessionData(input: SessionDataInput): SessionDataOutput {
  const data = input.data
  const event = input.event

  if (event.type === "session.next.shell.started") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, [])
    }

    const shell = claimShell(data, event.properties.callID, "shell", Option.some(event.properties.command))
    if (shell.source !== "shell") {
      return out(data, [])
    }

    const partID = shellPartID(event.properties.callID)
    if (MutableHashSet.has(data.ids, partID) || MutableHashSet.has(data.tools, partID)) {
      return out(data, [], patch({ status: "running shell" }))
    }

    MutableHashSet.add(data.tools, partID)
    return out(
      data,
      [startShell(event.properties.callID, shell.command ?? event.properties.command)],
      patch({ status: "running shell" }),
    )
  }

  if (event.type === "session.next.shell.ended") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, [])
    }

    const shell = claimShell(data, event.properties.callID, "shell", Option.none())
    if (shell.source !== "shell") {
      return out(data, [])
    }

    const partID = shellPartID(event.properties.callID)
    const seen = MutableHashSet.has(data.tools, partID)
    const command = shell.command ?? ""
    MutableHashSet.remove(data.tools, partID)
    if (MutableHashSet.has(data.ids, partID)) {
      return out(data, [])
    }

    MutableHashSet.add(data.ids, partID)
    return out(data, [
      ...(!seen && command ? [startShell(event.properties.callID, command)] : []),
      doneShell(event.properties.callID, command, event.properties.output),
    ])
  }

  if (event.type === "message.updated") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, [])
    }

    const info = event.properties.info
    const replayed = typeof info.id === "string" ? learnRole(data, info.id, info.role, input.thinking) : []

    if (info.role !== "assistant") {
      return out(data, replayed)
    }

    let next: FooterPatch | undefined
    if (!data.announced) {
      data.announced = true
      next = { status: "assistant responding" }
    }

    const usage = formatUsage(
      info.tokens,
      input.limits[modelKey(info.providerID, info.modelID)],
      // formatUsage ignores a cost that is not a positive number.
      info.cost,
    )
    if (usage) {
      next = {
        ...next,
        usage,
      }
    }

    const failed =
      typeof info.id === "string" &&
      info.error &&
      !isAbort(info.error) &&
      !MutableHashSet.has(data.ids, msgErr(info.id))
        ? [messageError(data, info.id, info.error)]
        : []

    return out(data, [...replayed, ...failed], patch(next))
  }

  if (event.type === "message.part.delta") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, [])
    }

    if (
      typeof event.properties.partID !== "string" ||
      typeof event.properties.field !== "string" ||
      typeof event.properties.delta !== "string"
    ) {
      return out(data, [])
    }

    if (event.properties.field !== "text") {
      return out(data, [])
    }

    const partID = event.properties.partID
    if (MutableHashSet.has(data.ids, partID)) {
      return out(data, [])
    }

    if (typeof event.properties.messageID === "string") {
      MutableHashMap.set(data.msg, partID, event.properties.messageID)
    }

    const text = lookup(data.text, partID, "")
    MutableHashMap.set(data.text, partID, text + event.properties.delta)

    const found = MutableHashMap.get(data.part, partID)
    if (Option.isNone(found)) {
      return out(data, [])
    }

    const kind = found.value

    if (kind === "reasoning" && !input.thinking) {
      return out(data, [])
    }

    if (!ready(data, partID)) {
      return out(data, [])
    }

    return out(data, flushPart(data, partID))
  }

  if (event.type === "message.part.updated") {
    const part = event.properties.part
    if (part.sessionID !== input.sessionID) {
      return out(data, [])
    }

    if (part.type === "tool") {
      const view = syncPermission(data, part) ?? syncQuestion(data, part)
      if (part.tool === "bash" && part.callID) {
        if (claimShell(data, part.callID, "tool", bashCommand(part)).source === "shell") {
          return out(data, [], view)
        }
      }

      if (part.state.status === "running") {
        if (MutableHashSet.has(data.ids, part.id)) {
          return out(data, [], view)
        }

        const started = !MutableHashSet.has(data.tools, part.id)
        MutableHashSet.add(data.tools, part.id)
        return out(data, started ? [startTool(part)] : [], view ?? patch({ status: toolStatus(part) }))
      }

      if (part.state.status === "completed") {
        const seen = MutableHashSet.has(data.tools, part.id)
        const mode = toolView(part.tool)
        MutableHashSet.remove(data.tools, part.id)
        if (MutableHashSet.has(data.ids, part.id)) {
          return out(data, [], view)
        }

        MutableHashSet.add(data.ids, part.id)
        stashEcho(data, part)

        const output = part.state.output
        return out(
          data,
          [
            ...(seen ? [] : [startTool(part)]),
            ...(mode.output && typeof output === "string" && output.trim()
              ? [
                  {
                    kind: "tool",
                    text: output,
                    phase: "progress",
                    source: "tool",
                    messageID: part.messageID,
                    partID: part.id,
                    tool: part.tool,
                    part,
                    toolState: "completed",
                  } satisfies SessionCommit,
                ]
              : []),
            ...(mode.final ? [doneTool(part)] : []),
          ],
          view,
        )
      }

      if (part.state.status === "error") {
        const seen = MutableHashSet.has(data.tools, part.id)
        MutableHashSet.remove(data.tools, part.id)
        if (MutableHashSet.has(data.ids, part.id)) {
          return out(data, [], view)
        }

        MutableHashSet.add(data.ids, part.id)
        const text =
          typeof part.state.error === "string" && part.state.error.trim() ? part.state.error : "unknown error"
        return out(data, [...(seen ? [] : [startTool(part)]), failTool(part, text)], view)
      }
    }

    if (part.type !== "text" && part.type !== "reasoning") {
      return out(data, [])
    }

    if (MutableHashSet.has(data.ids, part.id)) {
      return out(data, [])
    }

    const kind = part.type === "text" ? "assistant" : "reasoning"
    if (typeof part.messageID === "string") {
      MutableHashMap.set(data.msg, part.id, part.messageID)
    }

    const msg = part.messageID
    const role = msg ? MutableHashMap.get(data.role, msg) : Option.none<MessageRole>()
    const user = Option.contains(role, "user")
    if (user && part.type === "text" && !data.includeUserText) {
      MutableHashSet.add(data.ids, part.id)
      drop(data, part.id)
      return out(data, [])
    }

    if (kind === "reasoning" && !input.thinking) {
      if (part.time?.end) {
        MutableHashSet.add(data.ids, part.id)
      }
      drop(data, part.id)
      return out(data, [])
    }

    MutableHashMap.set(data.part, part.id, user && kind === "assistant" ? "user" : kind)
    syncText(data, part.id, part.text)

    if (part.time?.end) {
      MutableHashSet.add(data.end, part.id)
    }

    if (msg && Option.isNone(role)) {
      return out(data, [])
    }

    if (!ready(data, part.id)) {
      return out(data, [])
    }

    const flushed = flushPart(data, part.id)

    if (!part.time?.end) {
      return out(data, flushed)
    }

    MutableHashSet.add(data.ids, part.id)
    drop(data, part.id)
    return out(data, flushed)
  }

  if (event.type === "permission.asked") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, [])
    }

    data.permissions = upsert(data.permissions, enrichPermission(data, event.properties))
    return queueOut(data, [])
  }

  if (event.type === "permission.replied") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, [])
    }

    const permissions = remove(data.permissions, event.properties.requestID)
    if (Option.isNone(permissions)) {
      return out(data, [])
    }

    data.permissions = permissions.value
    return queueOut(data, [])
  }

  if (event.type === "question.asked") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, [])
    }

    data.questions = upsert(data.questions, event.properties)
    return queueOut(data, [])
  }

  if (event.type === "question.replied" || event.type === "question.rejected") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, [])
    }

    const questions = remove(data.questions, event.properties.requestID)
    if (Option.isNone(questions)) {
      return out(data, [])
    }

    data.questions = questions.value
    return queueOut(data, [])
  }

  if (event.type === "session.error") {
    if (event.properties.sessionID !== input.sessionID || !event.properties.error) {
      return out(data, [])
    }

    return out(data, [
      {
        kind: "error",
        text: formatError(event.properties.error),
        phase: "start",
        source: "system",
      },
    ])
  }

  return out(data, [])
}
