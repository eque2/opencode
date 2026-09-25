import { MutableHashMap, MutableHashSet, Option } from "effect"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"

function sessionTreeRequest<T>(
  session: Session[],
  request: Record<string, T[] | undefined>,
  sessionID?: string,
  include: (item: T) => boolean = () => true,
) {
  if (!sessionID) return

  const map = session.reduce((acc, item) => {
    if (!item.parentID) return acc
    const list = MutableHashMap.get(acc, item.parentID)
    if (Option.isSome(list)) list.value.push(item.id)
    if (Option.isNone(list)) MutableHashMap.set(acc, item.parentID, [item.id])
    return acc
  }, MutableHashMap.empty<string, string[]>())

  const seen = MutableHashSet.make(sessionID)
  const ids = [sessionID]
  for (const id of ids) {
    const list = MutableHashMap.get(map, id)
    if (Option.isNone(list)) continue
    for (const child of list.value) {
      if (MutableHashSet.has(seen, child)) continue
      MutableHashSet.add(seen, child)
      ids.push(child)
    }
  }

  const id = ids.find((id) => request[id]?.some(include))
  if (!id) return
  return request[id]?.find(include)
}

export function sessionPermissionRequest(
  session: Session[],
  request: Record<string, PermissionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: PermissionRequest) => boolean,
) {
  return sessionTreeRequest(session, request, sessionID, include)
}

export function sessionQuestionRequest(
  session: Session[],
  request: Record<string, QuestionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: QuestionRequest) => boolean,
) {
  return sessionTreeRequest(session, request, sessionID, include)
}
