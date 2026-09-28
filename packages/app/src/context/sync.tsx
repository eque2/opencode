import { Binary } from "@opencode-ai/core/util/binary"
import { createMemo } from "solid-js"
import { useServerSync } from "./server-sync"
import { useSDK } from "./sdk"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { messageKey } from "@/utils/session-message"
import { MutableHashMap, Option } from "effect"

function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

type OptimisticStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

type OptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

type OptimisticItem = {
  message: Message
  parts: Part[]
}

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

const hasParts = (current: Option.Option<Part[]>, want: Part[]) =>
  Option.match(current, {
    onNone: () => want.length === 0,
    onSome: (parts) => want.every((part) => Binary.search(parts, part.id, (item) => item.id).found),
  })

const mergeParts = (current: Option.Option<Part[]>, want: Part[]) => {
  if (Option.isNone(current)) return sortParts(want)
  const parts = current.value
  const next = [...parts]
  let changed = false
  for (const part of want) {
    const result = Binary.search(next, part.id, (item) => item.id)
    if (result.found) continue
    next.splice(result.index, 0, part)
    changed = true
  }
  if (!changed) return parts
  return next
}

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = MutableHashMap.fromIterable(
    page.part.map((item): readonly [string, Part[]] => [item.id, sortParts(item.part)]),
  )
  const confirmed: string[] = []

  for (const item of items) {
    const result = Binary.search(session, messageKey(item.message), messageKey)
    const found = result.found
    if (!found) session.splice(result.index, 0, item.message)

    const current = MutableHashMap.get(part, item.message.id)
    if (found && hasParts(current, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    MutableHashMap.set(part, item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part].sort((a, b) => cmp(a[0], b[0])).map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, messageKey(input.message), messageKey)
    draft.message[input.sessionID] = messages.toSpliced(result.index, 0, input.message)
  } else {
    draft.message[input.sessionID] = [input.message]
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const index = messages.findIndex((message) => message.id === input.messageID)
    if (index >= 0) draft.message[input.sessionID] = messages.toSpliced(index, 1)
  }
  delete draft.part[input.messageID]
}

export const useSync = () => {
  const serverSync = useServerSync()
  const sdk = useSDK()

  return createMemo(() => serverSync().ensureDirSyncContext(sdk().directory))
}

export type DirectorySync = ReturnType<ReturnType<typeof useSync>>
