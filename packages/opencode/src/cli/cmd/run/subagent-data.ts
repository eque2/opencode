import { HashMap, HashSet, MutableHashMap, MutableHashSet, Option } from "effect"
import type { Event, Message, Part, PermissionRequest, QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2"
import * as Locale from "@/util/locale"
import {
  bootstrapSessionData,
  createSessionData,
  formatError,
  reduceSessionData,
  type SessionData,
} from "./session-data"
import type { FooterSubagentState, FooterSubagentTab, StreamCommit } from "./types"

export const SUBAGENT_BOOTSTRAP_LIMIT = 200
export const SUBAGENT_CALL_BOOTSTRAP_LIMIT = 80

const SUBAGENT_COMMIT_LIMIT = 80
const SUBAGENT_CALL_LIMIT = 32
const SUBAGENT_ROLE_LIMIT = 32
const SUBAGENT_ERROR_LIMIT = 16
const SUBAGENT_ECHO_LIMIT = 8

type SessionMessage = {
  parts: Part[]
}

type BootstrapChildMessage = SessionMessage & {
  info: Message
}

type Frame = {
  key: string
  commit: StreamCommit
}

type DetailState = {
  sessionID: string
  data: SessionData
  frames: Frame[]
}

export type SubagentData = {
  tabs: MutableHashMap.MutableHashMap<string, FooterSubagentTab>
  details: MutableHashMap.MutableHashMap<string, DetailState>
}

export type BootstrapSubagentInput = {
  data: SubagentData
  messages: SessionMessage[]
  children: Array<{ id: string; title?: string }>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  // Clock reading in epoch milliseconds for tabs that carry no timestamp of their own.
  now: number
}

function createDetail(sessionID: string): DetailState {
  return {
    sessionID,
    data: createSessionData({
      includeUserText: true,
    }),
    frames: [],
  }
}

function ensureDetail(data: SubagentData, sessionID: string) {
  const current = MutableHashMap.get(data.details, sessionID)
  if (Option.isSome(current)) {
    return current.value
  }

  const next = createDetail(sessionID)
  MutableHashMap.set(data.details, sessionID, next)
  return next
}

export function sameSubagentTab(a: FooterSubagentTab, b: FooterSubagentTab) {
  return (
    a.sessionID === b.sessionID &&
    a.partID === b.partID &&
    a.callID === b.callID &&
    a.label === b.label &&
    a.description === b.description &&
    a.status === b.status &&
    a.background === b.background &&
    a.title === b.title &&
    a.toolCalls === b.toolCalls &&
    a.lastUpdatedAt === b.lastUpdatedAt
  )
}

function sameQueue<T extends { id: string }>(left: T[], right: T[]) {
  return (
    left.length === right.length && left.every((item, index) => item.id === right[index]?.id && item === right[index])
  )
}

function queueSnapshot(data: SessionData) {
  return {
    permissions: data.permissions.slice(),
    questions: data.questions.slice(),
  }
}

function queueChanged(data: SessionData, before: ReturnType<typeof queueSnapshot>) {
  return !sameQueue(before.permissions, data.permissions) || !sameQueue(before.questions, data.questions)
}

function sameCommit(left: StreamCommit, right: StreamCommit) {
  return (
    left.kind === right.kind &&
    left.text === right.text &&
    left.phase === right.phase &&
    left.source === right.source &&
    left.messageID === right.messageID &&
    left.partID === right.partID &&
    left.tool === right.tool &&
    left.interrupted === right.interrupted &&
    left.toolState === right.toolState &&
    left.toolError === right.toolError
  )
}

// A trimmed, non-empty string, or none.
function text(value: unknown): Option.Option<string> {
  return typeof value === "string"
    ? Option.some(value.trim()).pipe(Option.filter((next) => next !== ""))
    : Option.none()
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  return undefined
}

function inputLabel(input: Record<string, unknown>): Option.Option<string> {
  return Option.firstSomeOf([
    text(input.description),
    text(input.command),
    text(input.filePath),
    text(input.filepath),
    text(input.pattern),
    text(input.query),
    text(input.url),
    text(input.path),
    text(input.prompt),
  ])
}

function stateTitle(part: ToolPart): Option.Option<string> {
  return "title" in part.state ? text(part.state.title) : Option.none()
}

function callKey(messageID: string | undefined, callID: string | undefined): string | undefined {
  if (!messageID || !callID) {
    return undefined
  }

  return `${messageID}:${callID}`
}

function compactToolState(part: ToolPart): ToolPart["state"] {
  if (part.state.status === "pending") {
    return {
      status: "pending",
      input: part.state.input,
      raw: part.state.raw,
    }
  }

  if (part.state.status === "running") {
    return {
      status: "running",
      input: part.state.input,
      time: part.state.time,
      ...(part.state.metadata ? { metadata: part.state.metadata } : {}),
      ...(part.state.title ? { title: part.state.title } : {}),
    }
  }

  if (part.state.status === "completed") {
    return {
      status: "completed",
      input: part.state.input,
      output: part.state.output,
      title: part.state.title,
      metadata: part.state.metadata,
      time: part.state.time,
    }
  }

  return {
    status: "error",
    input: part.state.input,
    error: part.state.error,
    time: part.state.time,
    ...(part.state.metadata ? { metadata: part.state.metadata } : {}),
  }
}

function recent<T>(input: Iterable<T>, limit: number) {
  const list = [...input]
  return list.slice(Math.max(0, list.length - limit))
}

function copyMap<V>(source: MutableHashMap.MutableHashMap<string, V>, keep: HashSet.HashSet<string>) {
  return MutableHashMap.fromIterable([...source].filter(([key]) => HashSet.has(keep, key)))
}

function compactToolPart(part: ToolPart): ToolPart {
  return {
    id: part.id,
    type: "tool",
    sessionID: part.sessionID,
    messageID: part.messageID,
    callID: part.callID,
    tool: part.tool,
    state: compactToolState(part),
    ...(part.metadata ? { metadata: part.metadata } : {}),
  }
}

function compactCommit(commit: StreamCommit): StreamCommit {
  if (!commit.part) {
    return commit
  }

  return {
    ...commit,
    part: compactToolPart(commit.part),
  }
}

// `now` is the reducer's clock reading, used when the part state has no timestamp.
function stateUpdatedAt(part: ToolPart, now: number) {
  if (!("time" in part.state)) {
    return now
  }

  const time = part.state.time
  if (!("end" in time)) {
    return time.start ?? now
  }

  return time.end ?? time.start ?? now
}

function metadata(part: ToolPart, key: string) {
  if ("metadata" in part.state) {
    return part.state.metadata?.[key] ?? part.metadata?.[key]
  }

  return part.metadata?.[key]
}

function taskStatus(part: ToolPart): FooterSubagentTab["status"] {
  if (part.state.status === "completed") {
    return "completed"
  }

  if (part.state.status === "error") {
    if (metadata(part, "interrupted") === true || Option.contains(text(part.state.error), "Tool execution aborted")) {
      return "cancelled"
    }

    return "error"
  }

  return "running"
}

function taskTab(part: ToolPart, sessionID: string, now: number): FooterSubagentTab {
  const label = Locale.titlecase(Option.getOrElse(text(part.state.input.subagent_type), () => "general"))
  const description = Option.firstSomeOf([
    text(part.state.input.description),
    stateTitle(part),
    inputLabel(part.state.input),
  ]).pipe(Option.getOrElse(() => ""))

  return {
    sessionID,
    partID: part.id,
    callID: part.callID,
    label,
    description,
    status: taskStatus(part),
    background: metadata(part, "background") === true,
    // FooterSubagentTab.title is an optional string field of the footer contract.
    title: Option.getOrUndefined(stateTitle(part)),
    toolCalls: num(metadata(part, "toolcalls")) ?? num(metadata(part, "toolCalls")) ?? num(metadata(part, "calls")),
    lastUpdatedAt: stateUpdatedAt(part, now),
  }
}

function taskSessionID(part: ToolPart) {
  return Option.firstSomeOf([text(metadata(part, "sessionId")), text(metadata(part, "sessionID"))])
}

function syncTaskTab(data: SubagentData, part: ToolPart, now: number, children?: HashSet.HashSet<string>) {
  if (part.tool !== "task") {
    return false
  }

  const found = taskSessionID(part)
  if (Option.isNone(found)) {
    return false
  }

  const sessionID = found.value
  if (children && HashSet.size(children) > 0 && !HashSet.has(children, sessionID)) {
    return false
  }

  const next = taskTab(part, sessionID, now)
  if (Option.exists(MutableHashMap.get(data.tabs, sessionID), (current) => sameSubagentTab(current, next))) {
    ensureDetail(data, sessionID)
    return false
  }

  MutableHashMap.set(data.tabs, sessionID, next)
  ensureDetail(data, sessionID)
  return true
}

function frameKey(commit: StreamCommit) {
  if (commit.partID) {
    return `${commit.kind}:${commit.partID}:${commit.phase}`
  }

  if (commit.messageID) {
    return `${commit.kind}:${commit.messageID}:${commit.phase}`
  }

  return `${commit.kind}:${commit.phase}:${commit.text}`
}

function limitFrames(detail: DetailState) {
  if (detail.frames.length <= SUBAGENT_COMMIT_LIMIT) {
    return
  }

  detail.frames.splice(0, detail.frames.length - SUBAGENT_COMMIT_LIMIT)
}

function mergeLiveCommit(current: StreamCommit, next: StreamCommit) {
  if (current.phase !== "progress" || next.phase !== "progress") {
    if (sameCommit(current, next)) {
      return current
    }

    return next
  }

  const merged = {
    ...current,
    ...next,
    text: current.text + next.text,
  }

  if (sameCommit(current, merged)) {
    return current
  }

  return merged
}

function appendCommits(detail: DetailState, commits: StreamCommit[]) {
  let changed = false

  for (const commit of commits.map(compactCommit)) {
    const key = frameKey(commit)
    const index = detail.frames.findIndex((item) => item.key === key)
    if (index === -1) {
      detail.frames.push({
        key,
        commit,
      })
      changed = true
      continue
    }

    const next = mergeLiveCommit(detail.frames[index].commit, commit)
    if (sameCommit(detail.frames[index].commit, next)) {
      continue
    }

    detail.frames[index] = {
      key,
      commit: next,
    }
    changed = true
  }

  if (changed) {
    limitFrames(detail)
  }

  return changed
}

function ensureBlockerTab(
  data: SubagentData,
  sessionID: string,
  title: string | undefined,
  kind: "permission" | "question",
  now: number,
) {
  const found = MutableHashMap.get(data.tabs, sessionID)
  if (Option.isSome(found)) {
    const current = found.value
    ensureDetail(data, sessionID)
    if (current.status !== "running") {
      return false
    }

    const next = {
      ...current,
      description: kind === "permission" ? "Pending permission" : "Pending question",
      status: "running" as const,
      title: current.title ?? title,
      lastUpdatedAt: now,
    }
    if (sameSubagentTab(current, next)) {
      return false
    }

    MutableHashMap.set(data.tabs, sessionID, next)
    return true
  }

  MutableHashMap.set(data.tabs, sessionID, {
    sessionID,
    partID: `bootstrap:${sessionID}`,
    callID: `bootstrap:${sessionID}`,
    label: Option.getOrElse(text(title), () => Locale.titlecase(kind)),
    description: kind === "permission" ? "Pending permission" : "Pending question",
    status: "running",
    lastUpdatedAt: now,
  })
  ensureDetail(data, sessionID)
  return true
}

function isAbortedAssistantMessage(info: Message) {
  return info.role === "assistant" && info.error?.name === "MessageAbortedError"
}

function cancelSubagentTab(data: SubagentData, sessionID: string, now: number) {
  const found = MutableHashMap.get(data.tabs, sessionID)
  if (Option.isNone(found) || found.value.status !== "running") {
    return false
  }

  const current = found.value
  const next = {
    ...current,
    status: "cancelled" as const,
    lastUpdatedAt: now,
  }
  if (sameSubagentTab(current, next)) {
    return false
  }

  MutableHashMap.set(data.tabs, sessionID, next)
  return true
}

function compactCallMap(detail: DetailState) {
  const keep = HashSet.fromIterable([
    ...recent(MutableHashMap.keys(detail.data.call), SUBAGENT_CALL_LIMIT),
    ...detail.data.permissions.flatMap((request) => {
      const key = callKey(request.tool?.messageID, request.tool?.callID)
      return key ? [key] : []
    }),
    ...detail.frames.flatMap((item) => {
      const key = callKey(item.commit.part?.messageID, item.commit.part?.callID)
      return key ? [key] : []
    }),
  ])

  return copyMap(detail.data.call, keep)
}

function compactEchoMap(data: SessionData, messageIDs: HashSet.HashSet<string>) {
  const keys = HashSet.union(
    messageIDs,
    HashSet.fromIterable(recent(MutableHashMap.keys(data.echo), SUBAGENT_ECHO_LIMIT)),
  )
  return copyMap(data.echo, keys)
}

function compactIDs(detail: DetailState) {
  return MutableHashSet.fromIterable(recent(detail.data.ids, SUBAGENT_COMMIT_LIMIT + SUBAGENT_ERROR_LIMIT))
}

function compactDetail(detail: DetailState) {
  const next = createSessionData({
    includeUserText: true,
  })
  const activePartIDs = HashSet.fromIterable(MutableHashMap.keys(detail.data.part))
  const framePartIDs = detail.frames.flatMap((item) => (item.commit.partID ? [item.commit.partID] : []))
  const partIDs = HashSet.fromIterable([...activePartIDs, ...framePartIDs, ...detail.data.tools])
  const messageIDs = HashSet.fromIterable([
    ...[...MutableHashMap.keys(detail.data.part)].flatMap((partID) =>
      Option.toArray(MutableHashMap.get(detail.data.msg, partID)),
    ),
    ...recent(MutableHashMap.keys(detail.data.role), SUBAGENT_ROLE_LIMIT),
  ])

  next.announced = detail.data.announced
  next.permissions = detail.data.permissions
  next.questions = detail.data.questions
  next.ids = compactIDs(detail)
  next.tools = MutableHashSet.fromIterable([...detail.data.tools].filter((item) => HashSet.has(partIDs, item)))
  next.call = compactCallMap(detail)
  next.role = copyMap(detail.data.role, messageIDs)
  next.msg = copyMap(detail.data.msg, activePartIDs)
  next.part = copyMap(detail.data.part, activePartIDs)
  next.text = copyMap(detail.data.text, activePartIDs)
  next.sent = copyMap(detail.data.sent, activePartIDs)
  next.end = MutableHashSet.fromIterable([...detail.data.end].filter((item) => HashSet.has(activePartIDs, item)))
  next.echo = compactEchoMap(detail.data, messageIDs)
  detail.data = next
}

function applyChildEvent(input: {
  detail: DetailState
  event: Event
  thinking: boolean
  limits: Record<string, number>
}) {
  const before = queueSnapshot(input.detail.data)
  const out = reduceSessionData({
    data: input.detail.data,
    event: input.event,
    sessionID: input.detail.sessionID,
    thinking: input.thinking,
    limits: input.limits,
  })
  const changed = appendCommits(input.detail, out.commits)
  compactDetail(input.detail)

  return changed || queueChanged(input.detail.data, before)
}

function bootstrapChildEvent(input: {
  detail: DetailState
  event: Event
  thinking: boolean
  limits: Record<string, number>
}) {
  const out = reduceSessionData({
    data: input.detail.data,
    event: input.event,
    sessionID: input.detail.sessionID,
    thinking: input.thinking,
    limits: input.limits,
  })

  return appendCommits(input.detail, out.commits)
}

function bootstrapChildMessages(input: {
  detail: DetailState
  messages: BootstrapChildMessage[]
  thinking: boolean
  limits: Record<string, number>
}) {
  let changed = false

  for (const message of input.messages) {
    changed =
      bootstrapChildEvent({
        detail: input.detail,
        event: {
          id: `bootstrap:message:${message.info.id}`,
          type: "message.updated",
          properties: {
            sessionID: input.detail.sessionID,
            info: message.info,
          },
        },
        thinking: input.thinking,
        limits: input.limits,
      }) || changed

    for (const part of message.parts) {
      changed =
        bootstrapChildEvent({
          detail: input.detail,
          event: {
            id: `bootstrap:part:${part.id}`,
            type: "message.part.updated",
            properties: {
              sessionID: input.detail.sessionID,
              part,
              time: 0,
            },
          },
          thinking: input.thinking,
          limits: input.limits,
        }) || changed
    }
  }

  compactDetail(input.detail)
  return changed
}

function knownSession(data: SubagentData, sessionID: string) {
  return MutableHashMap.has(data.tabs, sessionID)
}

export function listSubagentPermissions(data: SubagentData) {
  return [...MutableHashMap.values(data.details)].flatMap((detail) => detail.data.permissions)
}

export function listSubagentQuestions(data: SubagentData) {
  return [...MutableHashMap.values(data.details)].flatMap((detail) => detail.data.questions)
}

export function createSubagentData(): SubagentData {
  return {
    tabs: MutableHashMap.empty(),
    details: MutableHashMap.empty(),
  }
}

function snapshotDetail(detail: DetailState) {
  return {
    sessionID: detail.sessionID,
    commits: detail.frames.map((item) => item.commit),
  }
}

export function listSubagentTabs(data: SubagentData) {
  return [...MutableHashMap.values(data.tabs)].sort((a, b) => {
    const active = Number(b.status === "running") - Number(a.status === "running")
    if (active !== 0) {
      return active
    }

    return b.lastUpdatedAt - a.lastUpdatedAt
  })
}

function snapshotQueues(data: SubagentData) {
  return {
    permissions: listSubagentPermissions(data).sort((a, b) => a.id.localeCompare(b.id)),
    questions: listSubagentQuestions(data).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function snapshotState(data: SubagentData, details: FooterSubagentState["details"]): FooterSubagentState {
  return {
    tabs: listSubagentTabs(data),
    details,
    ...snapshotQueues(data),
  }
}

export function snapshotSubagentData(data: SubagentData): FooterSubagentState {
  return snapshotState(
    data,
    Object.fromEntries([...data.details].map(([sessionID, detail]) => [sessionID, snapshotDetail(detail)])),
  )
}

export function snapshotSelectedSubagentData(
  data: SubagentData,
  selectedSessionID: string | undefined,
): FooterSubagentState {
  const detail = selectedSessionID ? MutableHashMap.get(data.details, selectedSessionID) : Option.none()

  return snapshotState(
    data,
    Option.match(detail, {
      onNone: () => ({}),
      onSome: (item) => ({ [item.sessionID]: snapshotDetail(item) }),
    }),
  )
}

// The child title feeds the optional `title` of a footer tab.
function childTitle(child: HashMap.HashMap<string, { id: string; title?: string }>, sessionID: string) {
  return Option.getOrUndefined(
    HashMap.get(child, sessionID).pipe(Option.flatMap((item) => Option.fromNullishOr(item.title))),
  )
}

export function bootstrapSubagentData(input: BootstrapSubagentInput) {
  const child = HashMap.fromIterable(input.children.map((item) => [item.id, item] as const))
  const children = HashSet.fromIterable(HashMap.keys(child))
  let changed = false

  for (const message of input.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") {
        continue
      }

      changed = syncTaskTab(input.data, part, input.now, children) || changed
    }
  }

  for (const item of input.permissions) {
    if (!HashSet.has(children, item.sessionID)) {
      continue
    }

    changed =
      ensureBlockerTab(input.data, item.sessionID, childTitle(child, item.sessionID), "permission", input.now) ||
      changed
  }

  for (const item of input.questions) {
    if (!HashSet.has(children, item.sessionID)) {
      continue
    }

    changed =
      ensureBlockerTab(input.data, item.sessionID, childTitle(child, item.sessionID), "question", input.now) || changed
  }

  for (const sessionID of MutableHashMap.keys(input.data.tabs)) {
    const detail = ensureDetail(input.data, sessionID)
    const before = queueSnapshot(detail.data)

    bootstrapSessionData({
      data: detail.data,
      messages: [],
      permissions: input.permissions
        .filter((item) => item.sessionID === sessionID)
        .sort((a, b) => a.id.localeCompare(b.id)),
      questions: input.questions
        .filter((item) => item.sessionID === sessionID)
        .sort((a, b) => a.id.localeCompare(b.id)),
    })
    compactDetail(detail)

    changed = queueChanged(detail.data, before) || changed
  }

  return changed
}

export function bootstrapSubagentCalls(input: {
  data: SubagentData
  sessionID: string
  messages: BootstrapChildMessage[]
  thinking: boolean
  limits: Record<string, number>
}) {
  if (!knownSession(input.data, input.sessionID) || input.messages.length === 0) {
    return false
  }

  const detail = ensureDetail(input.data, input.sessionID)
  const before = queueSnapshot(detail.data)
  const beforeCallCount = MutableHashMap.size(detail.data.call)
  bootstrapSessionData({
    data: detail.data,
    messages: input.messages,
    permissions: detail.data.permissions,
    questions: detail.data.questions,
  })
  const changed = bootstrapChildMessages({
    detail,
    messages: input.messages,
    thinking: input.thinking,
    limits: input.limits,
  })

  return changed || beforeCallCount !== MutableHashMap.size(detail.data.call) || queueChanged(detail.data, before)
}

function eventSessionID(event: Event): Option.Option<string> {
  if (
    event.type === "message.updated" ||
    event.type === "message.part.delta" ||
    event.type === "permission.asked" ||
    event.type === "permission.replied" ||
    event.type === "question.asked" ||
    event.type === "question.replied" ||
    event.type === "question.rejected" ||
    event.type === "session.error" ||
    event.type === "session.status"
  ) {
    return Option.fromNullishOr(event.properties.sessionID)
  }

  if (event.type === "message.part.updated") {
    return Option.some(event.properties.part.sessionID)
  }

  return Option.none()
}

export function reduceSubagentData(input: {
  data: SubagentData
  event: Event
  sessionID: string
  thinking: boolean
  limits: Record<string, number>
  // Clock reading in epoch milliseconds for tabs that carry no timestamp of their own.
  now: number
}) {
  const event = input.event

  if (event.type === "message.part.updated") {
    const part = event.properties.part
    if (part.sessionID === input.sessionID) {
      if (part.type !== "tool") {
        return false
      }

      return syncTaskTab(input.data, part, input.now)
    }
  }

  const found = eventSessionID(event).pipe(
    Option.filter((sessionID) => sessionID !== "" && knownSession(input.data, sessionID)),
  )
  if (Option.isNone(found)) {
    return false
  }

  const sessionID = found.value
  const detail = ensureDetail(input.data, sessionID)
  const cancelled =
    event.type === "message.updated" && isAbortedAssistantMessage(event.properties.info)
      ? cancelSubagentTab(input.data, sessionID, input.now)
      : false
  if (event.type === "session.status") {
    if (event.properties.status.type !== "retry") {
      return cancelled
    }

    return (
      appendCommits(detail, [
        {
          kind: "error",
          text: event.properties.status.message,
          phase: "start",
          source: "system",
          messageID: `retry:${event.properties.status.attempt}`,
        },
      ]) || cancelled
    )
  }

  if (event.type === "session.error" && event.properties.error) {
    return (
      appendCommits(detail, [
        {
          kind: "error",
          text: formatError(event.properties.error),
          phase: "start",
          source: "system",
          messageID: `session.error:${event.properties.sessionID}:${formatError(event.properties.error)}`,
        },
      ]) || cancelled
    )
  }

  return (
    applyChildEvent({
      detail,
      event,
      thinking: input.thinking,
      limits: input.limits,
    }) || cancelled
  )
}
