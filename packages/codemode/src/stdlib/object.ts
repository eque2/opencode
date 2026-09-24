import { Effect, HashSet, Result } from "effect"
import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js"
import { isBlockedMember, type ToolRuntimeError } from "../tool-runtime.js"
import { isSandboxValue, SandboxMap, SandboxURLSearchParams } from "../values.js"
import { boundedData, coerceToString } from "./value.js"

export const objectStatics = HashSet.make("keys", "values", "entries", "hasOwn", "assign", "fromEntries")

type ObjectResult<A> = Result.Result<A, InterpreterRuntimeError | ToolRuntimeError>

export const invokeObjectMethod = (
  name: string,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, InterpreterRuntimeError | ToolRuntimeError> =>
  Effect.fromResult(objectMethod(name, args, node))

// The helpers are synchronous: each step returns at its first failure.
const objectMethod = (name: string, args: Array<unknown>, node: AstNode): ObjectResult<unknown> => {
  if (!HashSet.has(objectStatics, name)) {
    return Result.fail(new InterpreterRuntimeError(`Object.${name} is not available in CodeMode.`, node))
  }
  const requireObject = (): ObjectResult<Record<string, unknown>> =>
    Result.flatMap(boundedData(args[0], `Object.${name} input`), (value) => {
      if (isSandboxValue(value)) return Result.succeed({})
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return Result.fail(new InterpreterRuntimeError(`Object.${name} expects a data object.`, node))
      }
      return Result.succeed(value as Record<string, unknown>)
    })
  // Copies entries into `out` in order; a blocked key stops the copy.
  const assignEntries = (
    out: Record<string, unknown>,
    entries: Iterable<readonly [string, unknown]>,
  ): ObjectResult<Record<string, unknown>> => {
    for (const [key, item] of entries) {
      if (isBlockedMember(key)) {
        return Result.fail(new InterpreterRuntimeError(`Property '${key}' is not available in CodeMode.`, node))
      }
      out[key] = item
    }
    return Result.succeed(out)
  }
  switch (name) {
    case "keys":
      return Result.flatMap(boundedData(args[0], "Object.keys input"), (value) => {
        if (isSandboxValue(value)) return Result.succeed([])
        if (Array.isArray(value)) return Result.succeed(Object.keys(value))
        if (value === null || typeof value !== "object") {
          return Result.fail(new InterpreterRuntimeError("Object.keys expects a data object or array.", node))
        }
        return Result.succeed(Object.keys(value))
      })
    case "values":
      return Result.map(requireObject(), (value) => Object.values(value))
    case "entries":
      return Result.map(requireObject(), (value) => Object.entries(value).map(([key, item]) => [key, item]))
    case "hasOwn":
      return Result.map(requireObject(), (value) => Object.hasOwn(value, String(args[1])))
    case "assign": {
      const out: Record<string, unknown> = Object.create(null)
      for (const source of args) {
        if (source === null || source === undefined) continue
        const copied = boundedData(source, "Object.assign input")
        if (Result.isFailure(copied)) return copied
        const value = copied.success
        if (isSandboxValue(value)) continue
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          return Result.fail(new InterpreterRuntimeError("Object.assign expects data objects.", node))
        }
        const assigned = assignEntries(out, Object.entries(value))
        if (Result.isFailure(assigned)) return assigned
      }
      return Result.succeed(out)
    }
    case "fromEntries": {
      if (args[0] instanceof SandboxMap) {
        const out: Record<string, unknown> = Object.create(null)
        return assignEntries(
          out,
          Array.from(args[0].map.entries(), ([key, item]): readonly [string, unknown] => [coerceToString(key), item]),
        )
      }
      if (args[0] instanceof SandboxURLSearchParams) {
        const out: Record<string, unknown> = Object.create(null)
        return assignEntries(out, args[0].params.entries())
      }
      const input = boundedData(args[0], "Object.fromEntries input")
      if (Result.isFailure(input)) return input
      const pairs = input.success
      if (!Array.isArray(pairs)) {
        return Result.fail(
          new InterpreterRuntimeError("Object.fromEntries expects an array of [key, value] pairs.", node),
        )
      }
      const out: Record<string, unknown> = Object.create(null)
      for (const pair of pairs) {
        if (!Array.isArray(pair)) {
          return Result.fail(new InterpreterRuntimeError("Object.fromEntries expects [key, value] pairs.", node))
        }
        const assigned = assignEntries(out, [[String(pair[0]), pair[1]]])
        if (Result.isFailure(assigned)) return assigned
      }
      return Result.succeed(out)
    }
  }
  return Result.fail(new InterpreterRuntimeError(`Object.${name} is not available in CodeMode.`, node))
}
