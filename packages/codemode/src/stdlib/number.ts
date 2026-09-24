export const numberMethods = new Set(["toFixed", "toPrecision", "toExponential", "toString"])

export const numberConstants = new Set(["MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER", "MAX_VALUE", "MIN_VALUE", "EPSILON"])

export const numberStatics = new Set(["isInteger", "isFinite", "isNaN", "isSafeInteger", "parseInt", "parseFloat"])

export const invokeNumberMethod = (
  value: number,
  name: string,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, InterpreterRuntimeError | ToolRuntimeError> => {
  // An omitted argument passes through as undefined, exactly as the host method takes it.
  const optNum = (index: number): Effect.Effect<number | undefined, InterpreterRuntimeError> => {
    const arg = args[index]
    return arg === undefined || typeof arg === "number"
      ? Effect.succeed(arg)
      : Effect.fail(new InterpreterRuntimeError(`Number.${name} expects a number argument.`, node))
  }
  // A digit count out of the host range throws a RangeError from the host method; Effect.sync
  // keeps that a defect with its native name, as when the method ran inline.
  let result: Effect.Effect<unknown, InterpreterRuntimeError>
  switch (name) {
    case "toFixed":
      result = Effect.flatMap(optNum(0), (digits) => Effect.sync(() => value.toFixed(digits)))
      break
    case "toExponential":
      result = Effect.flatMap(optNum(0), (digits) => Effect.sync(() => value.toExponential(digits)))
      break
    case "toPrecision":
      result = Effect.flatMap(optNum(0), (digits) =>
        Effect.sync(() => (digits === undefined ? value.toString() : value.toPrecision(digits))),
      )
      break
    case "toString":
      result = Effect.flatMap(optNum(0), (radix) =>
        radix !== undefined && (radix < 2 || radix > 36)
          ? Effect.fail(new InterpreterRuntimeError("Number.toString radix must be between 2 and 36.", node))
          : Effect.succeed(value.toString(radix)),
      )
      break
    default:
      return Effect.fail(new InterpreterRuntimeError(`Number method '${name}' is not available in CodeMode.`, node))
  }
  return Effect.flatMap(result, (computed) => Effect.fromResult(boundedData(computed, `Number.${name} result`)))
}

export const invokeNumberStatic = (
  name: string,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, InterpreterRuntimeError> => {
  const value = args[0]
  switch (name) {
    case "isInteger":
      return Effect.succeed(Number.isInteger(value))
    case "isFinite":
      return Effect.succeed(Number.isFinite(value))
    case "isNaN":
      return Effect.succeed(Number.isNaN(value))
    case "isSafeInteger":
      return Effect.succeed(Number.isSafeInteger(value))
    case "parseInt": {
      const radix = args[1]
      if (radix !== undefined && typeof radix !== "number") {
        return Effect.fail(new InterpreterRuntimeError("Number.parseInt expects a numeric radix.", node))
      }
      return Effect.succeed(parseInt(coerceToString(value), radix))
    }
    case "parseFloat":
      return Effect.succeed(parseFloat(coerceToString(value)))
    default:
      return Effect.fail(new InterpreterRuntimeError(`Number.${name} is not available in CodeMode.`, node))
  }
}
import { Effect } from "effect"
import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js"
import type { ToolRuntimeError } from "../tool-runtime.js"
import { boundedData, coerceToString } from "./value.js"
