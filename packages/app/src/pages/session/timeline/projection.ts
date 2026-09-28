import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { Array as Arr, HashMap, Option } from "effect"
import { createMemo, type Accessor } from "solid-js"
import { reuseTimelineRows } from "./row-reconciliation"
import { Timeline, TimelineRow } from "./rows"

export { reuseTimelineRows } from "./row-reconciliation"

export function createTimelineProjection(input: {
  messages: Accessor<Message[]>
  userMessages: Accessor<UserMessage[]>
  sessionMessages: Accessor<SessionMessageInfo[]>
  parts: (messageID: string) => Part[]
  status: Accessor<SessionStatus>
  showReasoningSummaries: Accessor<boolean>
  inlineComments: Accessor<boolean>
}) {
  const messageByID = createMemo(() =>
    HashMap.fromIterable(input.messages().map((message) => [message.id, message] as const)),
  )
  // groupBy keeps the input order inside each group, so each parent lists its replies oldest first.
  const assistantMessagesByParent = createMemo(() =>
    HashMap.fromIterable(
      Object.entries(
        Arr.groupBy(
          input.messages().filter((message): message is AssistantMessage => message.role === "assistant"),
          (message) => message.parentID,
        ),
      ),
    ),
  )
  const projection = createMemo(() =>
    Timeline.constructSessionMessageRows(
      input.sessionMessages(),
      (messageID) => Option.getOrUndefined(HashMap.get(messageByID(), messageID)),
      input.parts,
      input.showReasoningSummaries(),
      input.status().type,
      input.inlineComments(),
      input.userMessages(),
    ),
  )
  const activeMessageID = createMemo(() => projection().activeMessageID)
  const rows = createMemo((previous: TimelineRow.TimelineRow[] | undefined) =>
    reuseTimelineRows(previous, projection().rows),
  )
  const rowByKey = createMemo(() => HashMap.fromIterable(rows().map((row) => [TimelineRow.key(row), row] as const)))
  // The first row of each user message wins.
  const messageRowIndex = createMemo(() =>
    HashMap.mutate(HashMap.empty<string, number>(), (result) =>
      rows().forEach((row, index) => {
        if (!("userMessageID" in row) || HashMap.has(result, row.userMessageID)) return
        HashMap.set(result, row.userMessageID, index)
      }),
    ),
  )
  // fromIterable keeps the last entry for a repeated key, so the last row of each user message wins.
  const messageLastRowIndex = createMemo(() =>
    HashMap.fromIterable(
      rows().flatMap((row, index) => ("userMessageID" in row ? [[row.userMessageID, index] as const] : [])),
    ),
  )
  const lastAssistantGroupKey = createMemo(() =>
    HashMap.fromIterable(
      rows().flatMap((row) => (row._tag === "AssistantPart" ? [[row.userMessageID, row.group.key] as const] : [])),
    ),
  )

  return {
    activeMessageID,
    assistantMessagesByParent,
    lastAssistantGroupKey,
    messageByID,
    messageRowIndex,
    messageLastRowIndex,
    rowByKey,
    rows,
  }
}
