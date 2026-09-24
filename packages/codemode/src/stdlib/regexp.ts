export const regexpMethods = HashSet.make("test", "exec", "toString")

const regexpPropertyNames = [
  "source",
  "flags",
  "lastIndex",
  "global",
  "ignoreCase",
  "multiline",
  "sticky",
  "unicode",
  "dotAll",
] as const

/** A RegExp property a program may read; the name indexes the host regex with a precise type. */
export type RegExpPropertyName = (typeof regexpPropertyNames)[number]

export const regexpProperties = HashSet.make(...regexpPropertyNames)

export const isRegExpProperty = (key: string): key is RegExpPropertyName => HashSet.has(regexpProperties, key)

export const regexFailureReason = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Invalid regular expression:\s*/i, "")

export const escapeRegexHint =
  'To match special characters like ( ) [ ] { } + * ? . literally, escape them with a backslash (e.g. "\\\\(") or test for them with String.includes instead.'

// An invalid string pattern makes the RegExp constructor throw; the catch keeps its reason.
export const toHostRegex = (
  arg: unknown,
  method: string,
  node: AstNode,
  extraFlags = "",
): Effect.Effect<RegExp, InterpreterRuntimeError> => {
  if (arg instanceof SandboxRegExp) return Effect.succeed(arg.regex)
  if (typeof arg === "string") {
    return Effect.try({
      try: () => new RegExp(arg, extraFlags),
      catch: (error) =>
        new InterpreterRuntimeError(
          `String.${method} received the string ${JSON.stringify(arg)}, which is not a valid regular expression pattern (${regexFailureReason(error)}). ${escapeRegexHint}`,
          node,
        ).as("SyntaxError"),
    })
  }
  return Effect.fail(
    new InterpreterRuntimeError(
      `String.${method} expects a regular expression (a /pattern/flags literal or new RegExp(...)) or a string pattern, not ${arg === null ? "null" : typeof arg}.`,
      node,
    ),
  )
}

export const matchToValue = (match: RegExpMatchArray): Array<unknown> => {
  const result: Array<unknown> = Array.from(match, (group) => group)
  if (match.index !== undefined) (result as Record<string, unknown> & Array<unknown>).index = match.index
  if (match.groups) {
    const groups = makeSafeObject()
    for (const [key, group] of Object.entries(match.groups)) {
      if (!isBlockedMember(key)) groups[key] = group
    }
    ;(result as Record<string, unknown> & Array<unknown>).groups = groups
  }
  return result
}

// test and exec advance lastIndex on a global or sticky regex, so they run when the call runs.
export const invokeRegExpMethod = (
  value: SandboxRegExp,
  name: string,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, InterpreterRuntimeError> => {
  switch (name) {
    case "test":
      return Effect.sync(() => value.regex.test(coerceToString(args[0])))
    case "exec":
      return Effect.sync(() => {
        const matched = value.regex.exec(coerceToString(args[0]))
        return matched === null ? null : matchToValue(matched)
      })
    case "toString":
      return Effect.succeed(coerceToString(value))
    default:
      return Effect.fail(new InterpreterRuntimeError(`RegExp method '${name}' is not available in CodeMode.`, node))
  }
}
import { Effect, HashSet } from "effect"
import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js"
import { isBlockedMember, makeSafeObject } from "../tool-runtime.js"
import { SandboxRegExp } from "../values.js"
import { coerceToString } from "./value.js"
