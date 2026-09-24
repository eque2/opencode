export const errorConstructors = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
])

export const valueConstructors = new Set(["Date", "RegExp", "Map", "Set", "URL", "URLSearchParams"])

export const compoundOperators = new Set(["+=", "-=", "*=", "/=", "%=", "**=", "&=", "|=", "^=", "<<=", ">>=", ">>>="])

const ErrorBrand: unique symbol = Symbol("codemode.error")

export const createErrorValue = (name: string, message: string): SafeObject => {
  const value = Object.assign(Object.create(null) as SafeObject, { name, message })
  Object.defineProperty(value, ErrorBrand, { value: name })
  return value
}

export const errorBrandName = (value: unknown): string | undefined =>
  value !== null && typeof value === "object"
    ? ((value as Record<PropertyKey, unknown>)[ErrorBrand] as string | undefined)
    : undefined

export const boundedData = (value: unknown, label: string): Result.Result<unknown, ToolRuntimeError> =>
  copyIn(value, label, true)

export const coerceToString = (value: unknown): string => {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (value instanceof SandboxDate)
    return Number.isFinite(value.time) ? new Date(value.time).toISOString() : "Invalid Date"
  if (value instanceof SandboxRegExp) return `/${value.regex.source}/${value.regex.flags}`
  if (value instanceof SandboxMap) return "[object Map]"
  if (value instanceof SandboxSet) return "[object Set]"
  if (value instanceof SandboxURL) return value.url.href
  if (value instanceof SandboxURLSearchParams) return value.params.toString()
  if (typeof value === "object") {
    return Array.isArray(value)
      ? value.map((item) => (item === null || item === undefined ? "" : coerceToString(item))).join(",")
      : "[object Object]"
  }
  return String(value)
}

export const coerceToNumber = (value: unknown): number => {
  if (value instanceof SandboxDate) return value.time
  if (isSandboxValue(value)) return Number.NaN
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Number.NaN : Number(value)
}

export const invokeCoercion = (
  ref: CoercionFunction,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, InterpreterRuntimeError | ToolRuntimeError> => {
  const raw = args[0]
  if (isSandboxValue(raw)) {
    if (ref.name === "Boolean") return Effect.succeed(true)
    if (ref.name === "Number") return Effect.succeed(coerceToNumber(raw))
    if (ref.name === "String") return Effect.succeed(coerceToString(raw))
    if (ref.name === "parseInt") return Effect.succeed(parseInt(coerceToString(raw)))
    return Effect.succeed(parseFloat(coerceToString(raw)))
  }
  return Effect.flatMap(
    Effect.fromResult(boundedData(args[0], `${ref.name} input`)),
    (value): Effect.Effect<unknown, InterpreterRuntimeError> => {
      if (ref.name === "Number") return Effect.succeed(coerceToNumber(value))
      if (ref.name === "Boolean") return Effect.succeed(Boolean(value))
      if (ref.name === "parseInt") {
        const radix = args[1]
        if (radix !== undefined && typeof radix !== "number") {
          return Effect.fail(new InterpreterRuntimeError("parseInt expects a numeric radix.", node))
        }
        return Effect.succeed(parseInt(coerceToString(value), radix))
      }
      if (ref.name === "parseFloat") return Effect.succeed(parseFloat(coerceToString(value)))
      return Effect.succeed(coerceToString(value))
    },
  )
}
import { Effect, type Result } from "effect"
import { type AstNode, CoercionFunction, InterpreterRuntimeError } from "../interpreter/model.js"
import { copyIn, type SafeObject, type ToolRuntimeError } from "../tool-runtime.js"
import {
  isSandboxValue,
  SandboxDate,
  SandboxMap,
  SandboxRegExp,
  SandboxSet,
  SandboxURL,
  SandboxURLSearchParams,
} from "../values.js"
