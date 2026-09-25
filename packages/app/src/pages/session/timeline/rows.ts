import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import { AssistantMessage, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { groupParts, renderable, type PartGroup } from "@opencode-ai/session-ui/message-part"
import { Array as Arr, MutableHashMap, Option, Predicate, Schema } from "effect"
import { TimelineRow, type SummaryDiff } from "./timeline-row"
import { uniqueSummaryDiffs } from "./summary-diffs"
import { compareMessages } from "@/utils/session-message"

export { TimelineRow, type SummaryDiff } from "./timeline-row"

export type TimelineRowMap = {
  TurnGap: { userMessageID: string }
  CommentStrip: {
    userMessageID: string
  }
  UserMessage: {
    userMessageID: string
    anchor: boolean
  }
  TurnDivider: {
    userMessageID: string
    label: "compaction" | "interrupted"
  }
  AssistantPart: {
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
  }
  Thinking: { userMessageID: string; reasoningHeading?: string }
  Retry: { userMessageID: string }
  DiffSummary: { userMessageID: string; diffs: SummaryDiff[] }
  Error: { userMessageID: string; text: string }
}

export namespace Timeline {
  type Turn = { user: UserMessage; assistants: AssistantMessage[] }

  const noTurns: readonly Turn[] = []
  const noRows: readonly TimelineRow.TimelineRow[] = []
  const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

  export function constructSessionMessageRows(
    messages: SessionMessageInfo[],
    getMessage: (messageID: string) => UserMessage | AssistantMessage | undefined,
    getMessageParts: (messageID: string) => Part[],
    showReasoning: boolean,
    status: SessionStatus["type"],
    inlineComments: boolean,
    projectedUserMessages: UserMessage[],
  ) {
    const turnByUserID = MutableHashMap.empty<string, Turn>()
    // A new turn returns unwrapped and a skipped message returns the shared empty array, so flatMap allocates no wrapper.
    const sourceTurns = messages.flatMap((message): Turn | readonly Turn[] => {
      const projected = getMessage(message.id)
      if (message.type === "shell" && projected?.role === "user") {
        const assistant = getMessage(`${message.id}:assistant`)
        const turn: Turn = { user: projected, assistants: assistant?.role === "assistant" ? [assistant] : [] }
        MutableHashMap.set(turnByUserID, projected.id, turn)
        return turn
      }
      if (projected?.role === "user") {
        if (MutableHashMap.has(turnByUserID, projected.id)) return noTurns
        const turn: Turn = { user: projected, assistants: [] }
        MutableHashMap.set(turnByUserID, projected.id, turn)
        return turn
      }
      if (projected?.role !== "assistant") return noTurns
      const existing = MutableHashMap.get(turnByUserID, projected.parentID)
      if (Option.isSome(existing)) {
        existing.value.assistants.push(projected)
        return noTurns
      }
      const user = getMessage(projected.parentID)
      if (user?.role !== "user") return noTurns
      const turn: Turn = { user, assistants: [projected] }
      MutableHashMap.set(turnByUserID, user.id, turn)
      return turn
    })
    const turns = projectedUserMessages.reduce<readonly Turn[]>((current, user) => {
      if (MutableHashMap.has(turnByUserID, user.id)) return current
      const turn: Turn = { user, assistants: [] }
      MutableHashMap.set(turnByUserID, user.id, turn)
      const index = current.findIndex((item) => compareMessages(user, item.user) < 0)
      return index < 0 ? [...current, turn] : current.toSpliced(index, 0, turn)
    }, sourceTurns)
    const activeMessageID = turns.at(-1)?.user.id
    return {
      activeMessageID,
      rows: turns.flatMap((turn, index) =>
        constructMessageRows(
          turn.user,
          getMessageParts,
          turn.assistants,
          index,
          showReasoning,
          status,
          turn.user.id === activeMessageID,
          inlineComments,
        ),
      ),
    }
  }

  export function constructMessageRows(
    userMessage: UserMessage,
    getMessageParts: (messageID: string) => Part[],
    assistantMessages: AssistantMessage[],
    index: number,
    showReasoning: boolean,
    status: SessionStatus["type"],
    isActive: boolean,
    // v2 renders comments inside the user message attachments row instead of a strip row
    inlineComments: boolean,
  ) {
    const previousUserMessage = index > 0
    const userParts = getMessageParts(userMessage.id)
    const comments = userParts.flatMap((p) => MessageComment.fromPart(p) ?? [])
    const compaction = userParts.some((p) => p.type === "compaction")
    const interruptedMessageIndex = assistantMessages.findIndex((m) => m.error?.name === "MessageAbortedError")
    const interrupted = interruptedMessageIndex !== -1
    const error = Option.fromNullishOr(assistantMessages.at(-1)?.error).pipe(
      Option.filter((value) => value.name !== "MessageAbortedError"),
    )

    const assistantPartRefs = assistantMessages.flatMap((message, messageIndex) =>
      getMessageParts(message.id)
        .filter((part) => renderable(part, showReasoning))
        .map((part) => ({ messageID: message.id, messageIndex, part })),
    )
    const assistantItems =
      interrupted && !compaction
        ? [
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex <= interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
            { type: "interrupted" as const },
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex > interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
          ]
        : groupParts(assistantPartRefs).map((group) => ({ type: "part" as const, group }))
    // A part row follows another part row when an earlier item is a part; an interrupted divider does not count.
    const firstPartIndex = assistantItems.findIndex((item) => item.type === "part")
    const assistantRows = assistantItems.map((item, itemIndex) =>
      item.type === "interrupted"
        ? new TimelineRow.TurnDivider({
            userMessageID: userMessage.id,
            label: "interrupted",
          })
        : new TimelineRow.AssistantPart({
            userMessageID: userMessage.id,
            group: item.group,
            previousAssistantPart: itemIndex > firstPartIndex,
          }),
    )
    const thinking =
      isActive && status === "busy" && Option.isNone(error) && (showReasoning ? assistantPartRefs.length === 0 : true)
    const diffs = uniqueSummaryDiffs(userMessage.summary?.diffs)

    // concat appends a row or an array of rows. The shared noRows adds nothing and allocates nothing.
    return noRows.concat(
      previousUserMessage ? new TimelineRow.TurnGap({ userMessageID: userMessage.id }) : noRows,
      comments.length > 0 && !inlineComments
        ? new TimelineRow.CommentStrip({
            userMessageID: userMessage.id,
          })
        : noRows,
      new TimelineRow.UserMessage({
        userMessageID: userMessage.id,
        anchor: inlineComments || comments.length === 0,
      }),
      compaction
        ? new TimelineRow.TurnDivider({
            userMessageID: userMessage.id,
            label: "compaction",
          })
        : noRows,
      assistantRows,
      thinking
        ? new TimelineRow.Thinking({
            userMessageID: userMessage.id,
            reasoningHeading: Option.getOrUndefined(
              Arr.findFirst(
                assistantMessages.flatMap((message) => getMessageParts(message.id)),
                (part) => (part.type === "reasoning" && part.text ? reasoningHeading(part.text) : Option.none()),
              ),
            ),
          })
        : noRows,
      isActive && status === "retry" ? new TimelineRow.Retry({ userMessageID: userMessage.id }) : noRows,
      diffs.length > 0 && (status === "idle" || !isActive)
        ? new TimelineRow.DiffSummary({
            userMessageID: userMessage.id,
            diffs,
          })
        : noRows,
      Option.isSome(error)
        ? new TimelineRow.Error({
            userMessageID: userMessage.id,
            text: unwrapErrorMessage(errorDataMessage(error.value.data)),
          })
        : noRows,
    )
  }

  /** Finds the first non-empty heading in a reasoning text. */
  function reasoningHeading(text: string): Option.Option<string> {
    const markdown = text.replace(/\r\n?/g, "\n")
    const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    if (html?.[1]) {
      const value = cleanHeading(html[1].replace(/<[^>]+>/g, " "))
      if (value) return Option.some(value)
    }

    const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
    if (atx?.[1]) {
      const value = cleanHeading(atx[1])
      if (value) return Option.some(value)
    }

    const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
    if (setext?.[1]) {
      const value = cleanHeading(setext[1])
      if (value) return Option.some(value)
    }

    const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
    if (strong?.[1]) {
      const value = cleanHeading(strong[1])
      if (value) return Option.some(value)
    }
    return Option.none()
  }

  function cleanHeading(value: string) {
    return value
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~]+/g, "")
      .trim()
  }

  /**
   * Reads `data.message` of an assistant error as text. MessageOutputLengthError
   * types its data as unknown, so the message is read through guards.
   */
  function errorDataMessage(data: unknown) {
    const message = Predicate.hasProperty(data, "message") ? data.message : ""
    if (Predicate.isString(message)) return message
    if (Predicate.isNumber(message) || Predicate.isBoolean(message) || Predicate.isBigInt(message))
      return String(message)
    return ""
  }

  function unwrapErrorMessage(message: string) {
    const text = message.replace(/^Error:\s*/, "").trim()

    // A JSON string that holds JSON text is decoded a second time.
    const read = (value: string) =>
      Option.flatMap(decodeJson(value), (first) =>
        Predicate.isString(first) ? decodeJson(first.trim()) : Option.some(first),
      )

    const json = read(text).pipe(
      Option.orElse(() => {
        const start = text.indexOf("{")
        const end = text.lastIndexOf("}")
        return start !== -1 && end > start ? read(text.slice(start, end + 1)) : Option.none()
      }),
      Option.filter(record),
    )

    if (Option.isNone(json)) return message
    const body = json.value

    if (record(body.error)) {
      const err = body.error
      const type = Predicate.isString(err.type) ? err.type : ""
      const msg = Predicate.isString(err.message) ? err.message : ""
      if (type && msg) return `${type}: ${msg}`
      if (msg) return msg
      if (type) return type
      if (Predicate.isString(err.code) && err.code) return err.code
    }

    if (Predicate.isString(body.message) && body.message) return body.message

    if (Predicate.isString(body.error) && body.error) return body.error

    return message
  }

  function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }
}

export namespace MessageComment {
  export type MessageComment = {
    path: string
    comment: string
    selection?: {
      startLine: number
      endLine: number
    }
  }

  export const fromPart = (part: Part): MessageComment | undefined => {
    if (part.type !== "text" || !part.synthetic) return
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return
    return {
      path: next.path,
      comment: next.comment,
      ...(next.selection
        ? {
            selection: {
              startLine: next.selection.startLine,
              endLine: next.selection.endLine,
            },
          }
        : {}),
    }
  }
}
