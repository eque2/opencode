export const dateMethods = new Set([
  "getTime",
  "valueOf",
  "toISOString",
  "toJSON",
  "toString",
  "getFullYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "getMilliseconds",
  "getUTCFullYear",
  "getUTCMonth",
  "getUTCDate",
  "getUTCDay",
  "getUTCHours",
  "getUTCMinutes",
  "getUTCSeconds",
  "getUTCMilliseconds",
  "getTimezoneOffset",
])

export const dateStatics = new Set(["now", "parse", "UTC"])

export const invokeDateStatic = (
  name: string,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<number, InterpreterRuntimeError> => {
  switch (name) {
    case "now":
      return Effect.sync(() => Date.now())
    case "parse":
      return Effect.succeed(Date.parse(coerceToString(args[0])))
    case "UTC":
      return Effect.succeed(Date.UTC(...(args.map((arg) => coerceToNumber(arg)) as Parameters<typeof Date.UTC>)))
    default:
      return Effect.fail(new InterpreterRuntimeError(`Date.${name} is not available in CodeMode.`, node))
  }
}

export const invokeDateMethod = (
  value: SandboxDate,
  name: string,
  node: AstNode,
): Effect.Effect<unknown, InterpreterRuntimeError> => {
  const hosted = new Date(value.time)
  switch (name) {
    case "getTime":
    case "valueOf":
      return Effect.succeed(value.time)
    case "toISOString":
      if (!Number.isFinite(value.time)) return Effect.fail(new InterpreterRuntimeError("Invalid time value.", node))
      return Effect.succeed(hosted.toISOString())
    case "toJSON":
      return Effect.succeed(Number.isFinite(value.time) ? hosted.toISOString() : null)
    case "toString":
      return Effect.succeed(coerceToString(value))
    case "getFullYear":
      return Effect.succeed(hosted.getFullYear())
    case "getMonth":
      return Effect.succeed(hosted.getMonth())
    case "getDate":
      return Effect.succeed(hosted.getDate())
    case "getDay":
      return Effect.succeed(hosted.getDay())
    case "getHours":
      return Effect.succeed(hosted.getHours())
    case "getMinutes":
      return Effect.succeed(hosted.getMinutes())
    case "getSeconds":
      return Effect.succeed(hosted.getSeconds())
    case "getMilliseconds":
      return Effect.succeed(hosted.getMilliseconds())
    case "getUTCFullYear":
      return Effect.succeed(hosted.getUTCFullYear())
    case "getUTCMonth":
      return Effect.succeed(hosted.getUTCMonth())
    case "getUTCDate":
      return Effect.succeed(hosted.getUTCDate())
    case "getUTCDay":
      return Effect.succeed(hosted.getUTCDay())
    case "getUTCHours":
      return Effect.succeed(hosted.getUTCHours())
    case "getUTCMinutes":
      return Effect.succeed(hosted.getUTCMinutes())
    case "getUTCSeconds":
      return Effect.succeed(hosted.getUTCSeconds())
    case "getUTCMilliseconds":
      return Effect.succeed(hosted.getUTCMilliseconds())
    case "getTimezoneOffset":
      return Effect.succeed(hosted.getTimezoneOffset())
    default:
      return Effect.fail(new InterpreterRuntimeError(`Date method '${name}' is not available in CodeMode.`, node))
  }
}
import { Effect } from "effect"
import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js"
import { SandboxDate } from "../values.js"
import { coerceToNumber, coerceToString } from "./value.js"
