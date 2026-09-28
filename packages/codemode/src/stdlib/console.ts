import { HashSet } from "effect"

export const consoleMethods = HashSet.make("log", "info", "debug", "warn", "error", "dir", "table")

/** Console formatting recursion ceiling; deeper values render as "...". */
export const MAX_CONSOLE_DEPTH = 32
