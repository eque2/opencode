export const stringMethods = HashSet.make(
  "toLowerCase",
  "toUpperCase",
  "trim",
  "trimStart",
  "trimEnd",
  "trimLeft",
  "trimRight",
  "split",
  "slice",
  "substring",
  "substr",
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "lastIndexOf",
  "replace",
  "replaceAll",
  "repeat",
  "padStart",
  "padEnd",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "at",
  "concat",
  "toString",
  "match",
  "matchAll",
  "search",
  "localeCompare",
  "normalize",
)

export const stringStatics = HashSet.make("fromCharCode", "fromCodePoint")

export const invokeStringStatic = (
  name: string,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, InterpreterRuntimeError> => {
  if (!args.every(Predicate.isNumber)) {
    return Effect.fail(new InterpreterRuntimeError(`String.${name} expects number arguments.`, node))
  }
  const codes = args
  switch (name) {
    case "fromCharCode":
      return Effect.succeed(String.fromCharCode(...codes))
    // An invalid code point throws a RangeError from the host method; Effect.sync keeps that a
    // defect with its native name, as when the method ran inline.
    case "fromCodePoint":
      return Effect.sync(() => String.fromCodePoint(...codes))
    default:
      return Effect.fail(new InterpreterRuntimeError(`String.${name} is not available in CodeMode.`, node))
  }
}
import { Effect, HashSet, Predicate } from "effect"
import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js"
