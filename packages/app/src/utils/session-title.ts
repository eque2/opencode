import { DateTime } from "effect"

const pattern = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

interface Info {
  readonly title?: string
  readonly parentID?: string
  readonly time: {
    readonly created: number
  }
}

export function withTimestampedFallback(info: Info) {
  return (
    info.title ??
    `${info.parentID ? "Child" : "New"} session - ${DateTime.formatIso(DateTime.makeUnsafe(info.time.created))}`
  )
}

export function sessionTitle(title?: string) {
  if (!title) return title
  const match = title.match(pattern)
  return match?.[1] ?? title
}
