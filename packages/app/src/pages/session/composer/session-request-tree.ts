import { Chunk, MutableHashMap, MutableHashSet, Option } from "effect"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"

function sessionTreeRequest<T>(
  session: Session[],
  request: Record<string, T[] | undefined>,
  sessionID?: string,
  include: (item: T) => boolean = () => true,
) {
  if (!sessionID) return

  const map = MutableHashMap.empty<string, Chunk.Chunk<string>>()
  const childrenOf = (id: string) => MutableHashMap.get(map, id).pipe(Option.getOrElse(() => Chunk.empty<string>()))
  for (const item of session) {
    if (!item.parentID) continue
    MutableHashMap.set(map, item.parentID, Chunk.append(childrenOf(item.parentID), item.id))
  }

  // Breadth-first order, one level at a time: the nearest session with a request wins.
  const seen = MutableHashSet.make(sessionID)
  let ids: Chunk.Chunk<string> = Chunk.of(sessionID)
  let level = ids
  while (Chunk.isNonEmpty(level)) {
    let next = Chunk.empty<string>()
    for (const id of level) {
      for (const child of childrenOf(id)) {
        if (MutableHashSet.has(seen, child)) continue
        MutableHashSet.add(seen, child)
        next = Chunk.append(next, child)
      }
    }
    ids = Chunk.appendAll(ids, next)
    level = next
  }

  const id = Chunk.findFirst(ids, (id) => request[id]?.some(include) ?? false)
  if (Option.isNone(id)) return
  return request[id.value]?.find(include)
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
