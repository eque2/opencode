import { DateTime, Option } from "effect"

export function titlecase(str: string) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

// The text that Date gives for an invalid time value; an epoch value that DateTime.make rejects prints it.
const invalidDate = "Invalid Date"

// The fields that Date.prototype.toLocaleDateString() formats when it gets no options.
const localDateParts: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric" }

export function time(input: number): string {
  return Option.match(DateTime.make(input), {
    onNone: () => invalidDate,
    onSome: (date) => DateTime.formatLocal(date, { timeStyle: "short" }),
  })
}

export function datetime(input: number): string {
  const localTime = time(input)
  const localDate = Option.match(DateTime.make(input), {
    onNone: () => invalidDate,
    onSome: (date) => DateTime.formatLocal(date, localDateParts),
  })
  return `${localTime} · ${localDate}`
}

export function todayTimeOrDateTime(input: number): string {
  const isToday = Option.exists(DateTime.make(input), (date) => sameLocalDay(date, DateTime.nowUnsafe()))

  if (isToday) {
    return time(input)
  } else {
    return datetime(input)
  }
}

function sameLocalDay(left: DateTime.DateTime, right: DateTime.DateTime) {
  const zone = DateTime.zoneMakeLocal()
  const a = DateTime.toParts(DateTime.setZone(left, zone))
  const b = DateTime.toParts(DateTime.setZone(right, zone))
  return a.year === b.year && a.month === b.month && a.day === b.day
}

export function number(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}

export function duration(input: number) {
  if (input < 1000) {
    return `${input}ms`
  }
  if (input < 60000) {
    return `${(input / 1000).toFixed(1)}s`
  }
  if (input < 3600000) {
    const minutes = Math.floor(input / 60000)
    const seconds = Math.floor((input % 60000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  if (input < 86400000) {
    const hours = Math.floor(input / 3600000)
    const minutes = Math.floor((input % 3600000) / 60000)
    return `${hours}h ${minutes}m`
  }
  const days = Math.floor(input / 86400000)
  const hours = Math.floor((input % 86400000) / 3600000)
  return `${days}d ${hours}h`
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str
  return str.slice(0, len - 1) + "…"
}

export function truncateLeft(str: string, len: number): string {
  if (str.length <= len) return str
  return "…" + str.slice(-(len - 1))
}

export function truncateMiddle(str: string, maxLength: number = 35): string {
  if (str.length <= maxLength) return str

  const ellipsis = "…"
  const keepStart = Math.ceil((maxLength - ellipsis.length) / 2)
  const keepEnd = Math.floor((maxLength - ellipsis.length) / 2)

  return str.slice(0, keepStart) + ellipsis + str.slice(-keepEnd)
}

export function pluralize(count: number, singular: string, plural: string): string {
  const template = count === 1 ? singular : plural
  return template.replace("{}", count.toString())
}

export * as Locale from "./locale"
