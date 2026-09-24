export const mathConstants = new Set(["PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2", "SQRT1_2"])

export const mathMethods = new Set([
  "max",
  "min",
  "abs",
  "floor",
  "ceil",
  "round",
  "trunc",
  "sign",
  "sqrt",
  "cbrt",
  "pow",
  "hypot",
  "log",
  "log2",
  "log10",
  "exp",
])

export const invokeMathMethod = (
  name: string,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<number, InterpreterRuntimeError> => {
  if (!mathMethods.has(name)) {
    return Effect.fail(new InterpreterRuntimeError(`Math.${name} is not available in CodeMode.`, node))
  }
  if (!args.every(Predicate.isNumber)) {
    return Effect.fail(new InterpreterRuntimeError(`Math.${name} expects number arguments.`, node))
  }
  const nums = args
  const [a = Number.NaN, b = Number.NaN] = nums
  switch (name) {
    case "max":
      return Effect.succeed(Math.max(...nums))
    case "min":
      return Effect.succeed(Math.min(...nums))
    case "abs":
      return Effect.succeed(Math.abs(a))
    case "floor":
      return Effect.succeed(Math.floor(a))
    case "ceil":
      return Effect.succeed(Math.ceil(a))
    case "round":
      return Effect.succeed(Math.round(a))
    case "trunc":
      return Effect.succeed(Math.trunc(a))
    case "sign":
      return Effect.succeed(Math.sign(a))
    case "sqrt":
      return Effect.succeed(Math.sqrt(a))
    case "cbrt":
      return Effect.succeed(Math.cbrt(a))
    case "pow":
      return Effect.succeed(Math.pow(a, b))
    case "hypot":
      return Effect.succeed(Math.hypot(...nums))
    case "log":
      return Effect.succeed(Math.log(a))
    case "log2":
      return Effect.succeed(Math.log2(a))
    case "log10":
      return Effect.succeed(Math.log10(a))
    case "exp":
      return Effect.succeed(Math.exp(a))
  }
  return Effect.fail(new InterpreterRuntimeError(`Math.${name} is not available in CodeMode.`, node))
}
import { Effect, Predicate } from "effect"
import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js"
