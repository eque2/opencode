const urlPropertyNames = [
  "href",
  "origin",
  "protocol",
  "username",
  "password",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
] as const

/** A URL property a program may read. */
export type UrlPropertyName = (typeof urlPropertyNames)[number]

/** A URL property a program may write: all but the read-only `origin`. */
export type WritableUrlPropertyName = Exclude<UrlPropertyName, "origin">

export const urlProperties = HashSet.make(...urlPropertyNames)

export const urlWritableProperties = HashSet.remove(urlProperties, "origin")

export const isUrlProperty = (key: string): key is UrlPropertyName => HashSet.has(urlProperties, key)

export const isWritableUrlProperty = (key: UrlPropertyName): key is WritableUrlPropertyName =>
  HashSet.has(urlWritableProperties, key)

export const urlMethods = HashSet.make("toString", "toJSON")
export const urlStatics = HashSet.make("canParse", "parse")
export const urlSearchParamsMethods = HashSet.make(
  "append",
  "delete",
  "get",
  "getAll",
  "has",
  "set",
  "sort",
  "forEach",
  "keys",
  "values",
  "entries",
  "toString",
)

export const uriArgument = (value: unknown, label: string): Effect.Effect<string, ToolRuntimeError> =>
  Effect.map(Effect.fromResult(boundedData(value, label)), coerceToString)

const uriCodecs: Record<UriFunction["name"], (value: string) => string> = {
  encodeURI,
  encodeURIComponent,
  decodeURI,
  decodeURIComponent,
}

// Malformed input makes the host codec throw a URIError; the catch keeps its message.
export const invokeUriFunction = (
  ref: UriFunction,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<string, InterpreterRuntimeError | ToolRuntimeError> =>
  Effect.flatMap(uriArgument(args[0], `${ref.name} input`), (value) =>
    Effect.try({
      try: () => uriCodecs[ref.name](value),
      catch: (error) =>
        new InterpreterRuntimeError(
          `${ref.name} received malformed URI data: ${error instanceof Error ? error.message : String(error)}`,
          node,
        ).as("URIError"),
    }),
  )

export const urlArgument = (value: unknown, label: string): Effect.Effect<string, ToolRuntimeError> =>
  value instanceof SandboxURL ? Effect.succeed(value.url.href) : uriArgument(value, label)

// `new URL` throws on an invalid input or base; the parse result is None then.
const parseUrl = Option.liftThrowable((input: string, base?: string) => new URL(input, base))

export const invokeURLStatic = (
  name: string,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, InterpreterRuntimeError | ToolRuntimeError> => {
  if (!HashSet.has(urlStatics, name)) {
    return Effect.fail(new InterpreterRuntimeError(`URL.${name} is not available in CodeMode.`, node))
  }
  if (args.length === 0) {
    return Effect.fail(new InterpreterRuntimeError(`URL.${name} requires a URL argument.`, node).as("TypeError"))
  }
  return Effect.flatMap(urlArgument(args[0], `URL.${name} input`), (input) =>
    Effect.map(
      Effect.transposeOption(
        Option.map(Option.fromUndefinedOr(args[1]), (base) => urlArgument(base, `URL.${name} base`)),
      ),
      (base) => {
        const url = parseUrl(input, Option.getOrUndefined(base))
        // URL.parse gives JS null for an invalid URL: Option.getOrNull is that value at the sandbox edge.
        return name === "canParse"
          ? Option.isSome(url)
          : Option.getOrNull(Option.map(url, (parsed) => new SandboxURL(parsed)))
      },
    ),
  )
}

export const invokeURLMethod = (
  value: SandboxURL,
  name: string,
  node: AstNode,
): Effect.Effect<string, InterpreterRuntimeError> => {
  if (name === "toString" || name === "toJSON") return Effect.succeed(value.url.href)
  return Effect.fail(new InterpreterRuntimeError(`URL method '${name}' is not available in CodeMode.`, node))
}
import { Effect, HashSet, Option } from "effect"
import { type AstNode, InterpreterRuntimeError, UriFunction } from "../interpreter/model.js"
import type { ToolRuntimeError } from "../tool-runtime.js"
import { SandboxURL } from "../values.js"
import { boundedData, coerceToString } from "./value.js"
