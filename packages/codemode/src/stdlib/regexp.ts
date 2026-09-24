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
      `String.${method} expects a regular expression (a /pattern/flags literal or new RegExp(...)) or a string pattern, not ${Predicate.isNull(arg) ? "null" : typeof arg}.`,
      node,
    ),
  )
}

// Named groups copy into a prototype-free object; a blocked group name is dropped.
const safeGroups = (groups: Record<string, string>): SafeObject => {
  const copied = makeSafeObject()
  for (const [key, group] of Object.entries(groups)) {
    if (!isBlockedMember(key)) copied[key] = group
  }
  return copied
}

// A match array keeps its index/groups own properties, as String.match and RegExp.exec give them.
export const matchToValue = (match: RegExpMatchArray): Array<unknown> =>
  Object.assign(
    Array.from(match, (group): unknown => group),
    match.index === undefined ? {} : { index: match.index },
    match.groups ? { groups: safeGroups(match.groups) } : {},
  )

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
        // No match: exec's own null result is the program-visible value.
        return Predicate.isNull(matched) ? matched : matchToValue(matched)
      })
    case "toString":
      return Effect.succeed(coerceToString(value))
    default:
      return Effect.fail(new InterpreterRuntimeError(`RegExp method '${name}' is not available in CodeMode.`, node))
  }
}
import { Effect, HashSet, Predicate } from "effect"
import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js"
import { isBlockedMember, makeSafeObject, type SafeObject } from "../tool-runtime.js"
import { SandboxRegExp } from "../values.js"
import { coerceToString } from "./value.js"
