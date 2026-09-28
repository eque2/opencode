import { base64Encode } from "@opencode-ai/core/util/encode"
import { Array as Arr, MutableHashMap, MutableHashSet, Option } from "effect"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  return autoAccept[key] ?? autoAccept[sessionID]
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

// The session and its ancestors, nearest first. A parent cycle ends the walk.
function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = MutableHashMap.fromIterable(
    session.flatMap((item) => (item.parentID ? [[item.id, item.parentID] as const] : [])),
  )
  const seen = MutableHashSet.make(sessionID)
  let ids: ReadonlyArray<string> = [sessionID]
  let parentID = MutableHashMap.get(parent, sessionID)

  while (Option.isSome(parentID) && !MutableHashSet.has(seen, parentID.value)) {
    MutableHashSet.add(seen, parentID.value)
    ids = Arr.append(ids, parentID.value)
    parentID = MutableHashMap.get(parent, parentID.value)
  }

  return ids
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
) {
  const value = sessionAutoAccept(autoAccept, session, permission, directory)
  if (value !== undefined) return value
  return directory ? isDirectoryAutoAccepting(autoAccept, directory) : false
}

export function sessionAutoAccept(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
) {
  return sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
}
