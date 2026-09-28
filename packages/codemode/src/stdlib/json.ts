import { Effect, HashSet, Option, Predicate, Result, Schema } from "effect"
import {
  type AstNode,
  CodeModeFunction,
  InterpreterRuntimeError,
  supportedSyntaxMessage,
} from "../interpreter/model.js"
import { copyIn, copyOut, type ToolRuntimeError } from "../tool-runtime.js"

export const jsonStatics = HashSet.make("stringify", "parse")

// JSON text written into diagnostics, console output, and JSON.stringify goes through Schema codecs.
export const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

// JSON.stringify's space argument passes to the codec unchanged, so it indents the same way.
const encodeIndentedJsonText = (space: number | string) =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Json, { space }))

// JSON text decodes without asserting a shape: copyIn validates the parsed value next.
const decodeJsonText = Schema.decodeResult(Schema.fromJsonString(Schema.Unknown))

// The JSON value that JSON.stringify writes for copied-out sandbox data: undefined object
// members are omitted, undefined array slots (holes included) become null, and a bare
// undefined has no JSON form (None). Other non-JSON values also map to None, as JSON omits them.
export const toJsonValue = (value: unknown): Option.Option<Schema.Json> => {
  if (Predicate.isNull(value) || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return Option.some(value)
  }
  if (Array.isArray(value)) return Option.some(Array.from(value, (item) => Option.getOrNull(toJsonValue(item))))
  if (Predicate.isObject(value)) {
    return Option.some(
      Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) =>
          Option.toArray(Option.map(toJsonValue(item), (json): readonly [string, Schema.Json] => [key, json])),
        ),
      ),
    )
  }
  return Option.none()
}

export const invokeJsonMethod = (
  name: string,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, InterpreterRuntimeError | ToolRuntimeError> => {
  if (!HashSet.has(jsonStatics, name)) {
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
      // Only a number or string space indents, as in JSON.stringify.
      const encode =
        typeof space === "number" || typeof space === "string" ? encodeIndentedJsonText(space) : encodeJsonText
      // A value with no JSON form (a bare undefined) stringifies to undefined, as in JSON.stringify.
      return Effect.map(Effect.fromResult(copyIn(args[0], "JSON.stringify value")), (value) =>
        Option.getOrUndefined(Option.map(toJsonValue(copyOut(value)), encode)),
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
