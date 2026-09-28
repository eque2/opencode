import { Array as Arr, Option, Order } from "effect"

export function match(str: string, pattern: string) {
  if (str) str = str.replaceAll("\\", "/")
  if (pattern) pattern = pattern.replaceAll("\\", "/")
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape special regex chars
    .replace(/\*/g, ".*") // * becomes .*
    .replace(/\?/g, ".") // ? becomes .

  // If pattern ends with " *" (space + wildcard), make the trailing part optional
  // This allows "ls *" to match both "ls" and "ls -la"
  if (escaped.endsWith(" .*")) {
    escaped = escaped.slice(0, -3) + "( .*)?"
  }

  const flags = process.platform === "win32" ? "si" : "s"
  return new RegExp("^" + escaped + "$", flags).test(str)
}

// Shorter patterns sort first, so the last match is the most specific pattern.
const byPattern = Order.combine(
  Order.mapInput(Order.Number, ([key]: [string, unknown]) => key.length),
  Order.mapInput(Order.String, ([key]: [string, unknown]) => key),
)

function sortedEntries<T>(patterns: Record<string, T>) {
  return Arr.sort(Object.entries(patterns), byPattern)
}

// The public result is `T | undefined`: callers and tests read a missing rule as undefined.
export function all<T>(input: string, patterns: Record<string, T>): T | undefined {
  return Arr.findLast(sortedEntries(patterns), ([pattern]) => match(input, pattern)).pipe(
    Option.map(([, value]) => value),
    Option.getOrUndefined,
  )
}

export function allStructured<T>(input: { head: string; tail: string[] }, patterns: Record<string, T>): T | undefined {
  return Arr.findLast(sortedEntries(patterns), ([pattern]) => {
    const parts = pattern.split(/\s+/)
    if (!match(input.head, parts[0])) return false
    return parts.length === 1 || matchSequence(input.tail, parts.slice(1))
  }).pipe(
    Option.map(([, value]) => value),
    Option.getOrUndefined,
  )
}

function matchSequence(items: string[], patterns: string[]): boolean {
  if (patterns.length === 0) return true
  const [pattern, ...rest] = patterns
  if (pattern === "*") return matchSequence(items, rest)
  for (let i = 0; i < items.length; i++) {
    if (match(items[i], pattern) && matchSequence(items.slice(i + 1), rest)) {
      return true
    }
  }
  return false
}

export * as Wildcard from "./wildcard"
