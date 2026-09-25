import { HashMap, MutableHashSet, Option } from "effect"
import { TimelineRow } from "./timeline-row"

type PriorContext = { index: number; row: TimelineRow.AssistantPart }

export function reuseTimelineRows(previous: TimelineRow.TimelineRow[] | undefined, rows: TimelineRow.TimelineRow[]) {
  if (!previous?.length) return rows
  const byKey = HashMap.fromIterable(previous.map((row) => [TimelineRow.key(row), row] as const))
  // fromIterable keeps the last entry for a repeated key, as Map.set did.
  const contextByPart = HashMap.fromIterable(
    previous.flatMap((row, index) =>
      row._tag !== "AssistantPart" || row.group.type !== "context"
        ? []
        : row.group.refs.map((ref) => [`${row.userMessageID}:${ref.partID}`, { index, row }] as const),
    ),
  )
  // The first new row that keeps a previous context key reserves it.
  const reserved = HashMap.mutate(HashMap.empty<string, number>(), (result) =>
    rows.forEach((row, index) => {
      if (row._tag !== "AssistantPart" || row.group.type !== "context") return
      const key = TimelineRow.key(row)
      if (HashMap.has(byKey, key) && !HashMap.has(result, key)) HashMap.set(result, key, index)
    }),
  )
  const claimed = MutableHashSet.empty<string>()
  const next = rows.map((input, index) => {
    const row = stabilizeContextKey(contextByPart, reserved, input, index, claimed)
    const existing = HashMap.get(byKey, TimelineRow.key(row))
    if (Option.isNone(existing)) return row
    return TimelineRow.equals(existing.value, row) ? existing.value : row
  })
  if (previous.length === next.length && previous.every((row, index) => row === next[index])) return previous
  return next
}

function stabilizeContextKey(
  contextByPart: HashMap.HashMap<string, PriorContext>,
  reserved: HashMap.HashMap<string, number>,
  row: TimelineRow.TimelineRow,
  rowIndex: number,
  claimed: MutableHashSet.MutableHashSet<string>,
) {
  if (row._tag !== "AssistantPart" || row.group.type !== "context") return row
  const existing = row.group.refs.reduce<PriorContext | undefined>((result, ref) => {
    const candidate = HashMap.get(contextByPart, `${row.userMessageID}:${ref.partID}`)
    if (Option.isNone(candidate)) return result
    const key = TimelineRow.key(candidate.value.row)
    if (MutableHashSet.has(claimed, key)) return result
    const owner = HashMap.get(reserved, key)
    if (Option.isSome(owner) && owner.value !== rowIndex) return result
    return !result || candidate.value.index < result.index ? candidate.value : result
  }, undefined)
  if (!existing) return row
  const key = TimelineRow.key(existing.row)
  MutableHashSet.add(claimed, key)
  if (row.group.key === existing.row.group.key) return row
  return new TimelineRow.AssistantPart({
    userMessageID: row.userMessageID,
    group: { ...row.group, key: existing.row.group.key },
    previousAssistantPart: row.previousAssistantPart,
  })
}
