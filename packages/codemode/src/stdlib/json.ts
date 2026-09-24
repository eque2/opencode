import { Effect, Result, Schema } from "effect"
import {
  type AstNode,
  CodeModeFunction,
  InterpreterRuntimeError,
  supportedSyntaxMessage,
} from "../interpreter/model.js"
import { copyIn, copyOut, type ToolRuntimeError } from "../tool-runtime.js"

export const jsonStatics = new Set(["stringify", "parse"])

// JSON text decodes without asserting a shape: copyIn validates the parsed value next.
const decodeJsonText = Schema.decodeResult(Schema.fromJsonString(Schema.Unknown))

export const invokeJsonMethod = (
  name: string,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, InterpreterRuntimeError | ToolRuntimeError> => {
  if (!jsonStatics.has(name)) {
    return Effect.fail(new InterpreterRuntimeError(`JSON.${name} is not available in CodeMode.`, node))
  }
  switch (name) {
    case "stringify": {
      const replacer = args[1]
      if (Array.isArray(replacer) || replacer instanceof CodeModeFunction) {
        return Effect.fail(
          new InterpreterRuntimeError(
            "JSON.stringify replacers are not supported in CodeMode.",
            node,
            "UnsupportedSyntax",
            [supportedSyntaxMessage],
          ),
        )
      }
      const space = args[2]
      const indent = typeof space === "number" || typeof space === "string" ? space : undefined
      return Effect.map(Effect.fromResult(copyIn(args[0], "JSON.stringify value")), (value) =>
        JSON.stringify(copyOut(value), null, indent),
      )
    }
    case "parse": {
      const text = args[0]
      if (typeof text !== "string") {
        return Effect.fail(new InterpreterRuntimeError("JSON.parse expects a string.", node))
      }
      // Invalid text and a parsed value that is not plain data are both a SyntaxError.
      return Effect.fromResult(
        Result.mapError(
          Result.flatMap(decodeJsonText(text), (parsed) => copyIn(parsed, "JSON.parse result")),
          (error) =>
            new InterpreterRuntimeError(`JSON.parse received invalid JSON: ${error.message}`, node).as("SyntaxError"),
        ),
      )
    }
  }
  return Effect.fail(new InterpreterRuntimeError(`JSON.${name} is not available in CodeMode.`, node))
}
