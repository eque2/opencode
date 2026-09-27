import { HashSet, MutableHashMap, MutableHashSet, Option } from "effect"
import type { Event, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { bootstrapSessionData, createSessionData, lookup, reduceSessionData, type SessionData } from "./session-data"
import { messagePrompt, type SessionMessages } from "./session.shared"
import { messageTurnSummaryCommit } from "./turn-summary"
import type { FooterPatch, LocalReplayRow, RunProvider, StreamCommit } from "./types"

type ReplayInput = {
  messages: SessionMessages
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  thinking: boolean
  limits: Record<string, number>
  providers?: RunProvider[]
}

type ReplayConfig = {
  limits: Record<string, number>
  providers?: RunProvider[]
  summaries: HashSet.HashSet<string>
}

export type SessionReplay = {
  data: SessionData
  commits: StreamCommit[]
  patch?: FooterPatch
}

type ReplayMessage = {
  commits: StreamCommit[]
  patch?: FooterPatch
}

const SHELL_SYNTHETIC_USER_TEXT = "The following tool was executed by the user"

function apply(data: SessionData, event: Event, sessionID: string, thinking: boolean, limits: Record<string, number>) {
  return reduceSessionData({
    data,
    event,
    sessionID,
    thinking,
    limits,
  })
}

// Later patches override earlier ones; a lone patch passes through unchanged.
function mergePatches(patches: ReadonlyArray<FooterPatch | undefined>): FooterPatch | undefined {
  const defined = patches.filter((item): item is FooterPatch => !!item)
  if (defined.length === 0) {
    return undefined
  }

  return defined.reduce((left, right) => ({ ...left, ...right }))
}

function active(data: SessionData) {
  return MutableHashMap.size(data.part) > 0 || MutableHashSet.size(data.tools) > 0
}

function replayPatch(data: SessionData, patch: FooterPatch | undefined) {
  if (active(data)) {
    if (!patch) {
      return {
        phase: "running",
      } satisfies FooterPatch
    }

    return {
      ...patch,
      phase: "running",
    } satisfies FooterPatch
  }

  if (data.permissions.length > 0 || data.questions.length > 0) {
    if (!patch) {
      return {
        phase: "idle",
      } satisfies FooterPatch
    }

    return {
      ...patch,
      phase: "idle",
    } satisfies FooterPatch
  }

  if (!patch) {
    return undefined
  }

  return {
    ...patch,
    phase: "idle",
    status: "",
  } satisfies FooterPatch
}

function isShellSyntheticUser(message: SessionMessages[number]) {
  if (message.info.role !== "user") {
    return false
  }

  const prompt = messagePrompt(message)
  return (
    !prompt.text.trim() &&
    prompt.parts.length === 0 &&
    message.parts.some((part) => part.type === "text" && part.synthetic && part.text === SHELL_SYNTHETIC_USER_TEXT)
  )
}

function isShellSyntheticAssistant(message: SessionMessages[number], shellParents: HashSet.HashSet<string>) {
  return (
    message.info.role === "assistant" &&
    HashSet.has(shellParents, message.info.parentID) &&
    message.parts.some((part) => part.type === "tool" && part.tool === "bash")
  )
}

function summaryMessageIDs(messages: SessionMessages): HashSet.HashSet<string> {
  const shellParents = HashSet.fromIterable(messages.filter(isShellSyntheticUser).map((message) => message.info.id))
  const parents = MutableHashSet.empty<string>()
  const summaries = MutableHashSet.empty<string>()

  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const message = messages[idx]
    if (!message || message.info.role !== "assistant") {
      continue
    }

    if (isShellSyntheticAssistant(message, shellParents)) {
      continue
    }

    if (MutableHashSet.has(parents, message.info.parentID)) {
      continue
    }

    MutableHashSet.add(parents, message.info.parentID)

    const completed = message.info.time.completed
    if (typeof completed === "number" && completed > message.info.time.created) {
      MutableHashSet.add(summaries, message.info.id)
    }
  }

  return HashSet.fromIterable(summaries)
}

function replayMessage(
  data: SessionData,
  message: SessionMessages[number],
  thinking: boolean,
  config: ReplayConfig,
): ReplayMessage {
  if (message.info.role === "user") {
    const prompt = messagePrompt(message)
    if (!prompt.text.trim()) {
      return {
        commits: [],
      }
    }

    return {
      commits: [
        {
          kind: "user",
          text: prompt.text,
          phase: "start",
          source: "system",
          messageID: message.info.id,
        },
      ],
    }
  }

  const info = apply(
    data,
    {
      id: `bootstrap:message:${message.info.id}`,
      type: "message.updated",
      properties: {
        sessionID: message.info.sessionID,
        info: message.info,
      },
    },
    message.info.sessionID,
    thinking,
    config.limits,
  )
  // apply() mutates `data`, so the parts reduce in message order.
  const parts = message.parts.map((part) =>
    apply(
      data,
      {
        id: `bootstrap:part:${part.id}`,
        type: "message.part.updated",
        properties: {
          sessionID: part.sessionID,
          part,
          time: 0,
        },
      },
      message.info.sessionID,
      thinking,
      config.limits,
    ),
  )
  const outputs = [info, ...parts]

  const summary = HashSet.has(config.summaries, message.info.id)
    ? Option.fromNullishOr(messageTurnSummaryCommit(message, config.providers))
    : Option.none()

  return {
    commits: [...outputs.flatMap((item) => item.commits), ...Option.toArray(summary)],
    patch: mergePatches(outputs.map((item) => item.footer?.patch)),
  }
}

export function replaySession(input: ReplayInput): SessionReplay {
  const data = createSessionData()
  const summaries = summaryMessageIDs(input.messages)

  bootstrapSessionData({
    data,
    messages: input.messages,
    permissions: input.permissions,
    questions: input.questions,
  })

  // replayMessage() mutates `data`, so the messages replay in order.
  const replayed = input.messages.map((message) =>
    replayMessage(data, message, input.thinking, {
      limits: input.limits,
      providers: input.providers,
      summaries,
    }),
  )

  return {
    data,
    commits: replayed.flatMap((item) => item.commits),
    patch: replayPatch(data, mergePatches(replayed.map((item) => item.patch))),
  }
}

export function replayLocalRows(
  messages: SessionMessages,
  commits: StreamCommit[],
  rows: LocalReplayRow[],
): StreamCommit[] {
  const persisted = HashSet.fromIterable(messages.map((message) => message.info.id))
  return rows.reduce((out, local) => {
    const row = local.commit
    if (row.kind === "user" && row.messageID && HashSet.has(persisted, row.messageID)) {
      return out
    }

    if (!row.messageID) {
      return [...out, row]
    }

    const exact = local.after
      ? out.findIndex(
          (commit) =>
            commit.kind === local.after?.kind &&
            commit.text === local.after.text &&
            commit.phase === local.after.phase &&
            commit.toolState === local.after.toolState &&
            (local.after.partID ? commit.partID === local.after.partID : commit.messageID === local.after.messageID),
        )
      : -1
    const anchored =
      exact !== -1
        ? exact
        : local.after
          ? out.findLastIndex((commit) =>
              local.after?.partID
                ? commit.partID === local.after.partID
                : commit.kind === local.after?.kind && commit.messageID === local.after.messageID,
            )
          : -1
    if (anchored !== -1) {
      const commit = out[anchored]
      const visible = local.after?.visible
      if (commit && visible && commit.text.startsWith(visible) && commit.text.length > visible.length) {
        return [
          ...out.slice(0, anchored),
          { ...commit, text: visible },
          row,
          { ...commit, text: commit.text.slice(visible.length) },
          ...out.slice(anchored + 1),
        ]
      }

      return [...out.slice(0, anchored + 1), row, ...out.slice(anchored + 1)]
    }

    const after = out.findIndex((commit) => commit.kind === "user" && commit.messageID === row.messageID)
    if (after !== -1) {
      return [...out.slice(0, after + 1), row, ...out.slice(after + 1)]
    }

    const before = out.findIndex((commit) => commit.messageID && row.messageID! < commit.messageID)
    if (before === -1) {
      return [...out, row]
    }

    return [...out.slice(0, before), row, ...out.slice(before)]
  }, commits)
}

export function replayActiveText(data: SessionData, current: SessionData): StreamCommit[] {
  return [...current.part].flatMap(([partID, kind]) => {
    if (kind === "user" || MutableHashSet.has(current.end, partID) || MutableHashSet.has(data.ids, partID)) {
      return []
    }

    const text = lookup(current.text, partID, "")
    const existing = lookup(data.text, partID, "")
    const sent = lookup(current.sent, partID, 0)
    const existingSent = lookup(data.sent, partID, 0)
    const visible = lookup(current.visible, partID, "")
    const existingVisible = lookup(data.visible, partID, "")
    if (!text.startsWith(existing) || existingSent > sent || !visible.startsWith(existingVisible)) {
      return []
    }

    MutableHashMap.set(data.part, partID, kind)
    MutableHashMap.set(data.text, partID, text)
    MutableHashMap.set(data.sent, partID, sent)
    MutableHashMap.set(data.visible, partID, visible)
    const messageID = lookup(current.msg, partID, "")
    if (messageID) {
      MutableHashMap.set(data.msg, partID, messageID)
      const role = MutableHashMap.get(current.role, messageID)
      if (Option.isSome(role)) {
        MutableHashMap.set(data.role, messageID, role.value)
      }
    }

    const chunk = visible.slice(existingVisible.length)
    if (!chunk) {
      return []
    }

    return [
      {
        kind,
        text: chunk,
        phase: "progress",
        source: kind,
        ...(messageID ? { messageID } : {}),
        partID,
      },
    ] satisfies StreamCommit[]
  })
}
