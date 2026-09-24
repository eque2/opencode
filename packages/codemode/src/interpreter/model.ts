import { Data, Effect, type MutableHashMap, Option, Predicate } from "effect"
import type { SafeObject } from "../tool-runtime.js"
import type { SandboxURL } from "../values.js"

export type SourcePosition = {
  line: number
  column: number
}

export type SourceLocation = {
  start: SourcePosition
  end: SourcePosition
}

export type AstNode = {
  type: string
  loc?: SourceLocation
  [key: string]: unknown
}

export type ProgramNode = AstNode & {
  type: "Program"
  body: Array<AstNode>
}

export type Binding = {
  mutable: boolean
  value: unknown
  initialized?: boolean
}

export type StatementResult =
  | { kind: "none" }
  | { kind: "value"; value: unknown }
  | { kind: "return"; value: unknown }
  | { kind: "break" }
  | { kind: "continue" }

// The URL properties a program may read (stdlib/url.ts `urlProperties`) and write
// (`urlWritableProperties`: all but the read-only `origin`).
export type UrlPropertyName =
  | "href"
  | "origin"
  | "protocol"
  | "username"
  | "password"
  | "host"
  | "hostname"
  | "port"
  | "pathname"
  | "search"
  | "hash"

export type WritableUrlPropertyName = Exclude<UrlPropertyName, "origin">

// A resolved data field: an array slot or property, a data object property, or a URL component.
export type MemberReference =
  | { readonly kind: "array"; readonly target: Array<unknown>; readonly key: string | number }
  | { readonly kind: "object"; readonly target: SafeObject; readonly key: string | number }
  | { readonly kind: "url"; readonly target: SandboxURL; readonly key: UrlPropertyName }

// One lexical scope, keyed by binding name. It is mutable in place: closures capture scope
// objects by reference, so a later declaration or assignment must be visible to every capture.
export type Scope = MutableHashMap.MutableHashMap<string, Binding>

export class CodeModeFunction {
  constructor(
    readonly parameters: ReadonlyArray<AstNode>,
    readonly body: AstNode,
    readonly capturedScopes: ReadonlyArray<Scope>,
  ) {}
}

export class IntrinsicReference {
  constructor(
    readonly receiver: unknown,
    readonly name: string,
  ) {}
}

export class ComputedValue {
  constructor(readonly value: unknown) {}
}

// The sandbox `Promise` global: an opaque tagged value (never plain data), so data checkpoints
// reject it exactly like the other runtime references.
export class PromiseNamespace extends Data.TaggedClass("PromiseNamespace") {}

export const promiseNamespace: PromiseNamespace = new PromiseNamespace()

export type PromiseMethodName = "all" | "allSettled" | "race" | "resolve" | "reject"

export class PromiseMethodReference {
  constructor(readonly name: PromiseMethodName) {}
}

export type GlobalNamespaceName =
  | "Object"
  | "Math"
  | "JSON"
  | "Array"
  | "console"
  | "Date"
  | "RegExp"
  | "Map"
  | "Set"
  | "URL"
  | "URLSearchParams"

export class GlobalNamespace {
  constructor(readonly name: GlobalNamespaceName) {}
}

export class GlobalMethodReference {
  constructor(
    readonly namespace: GlobalNamespaceName | "Number" | "String",
    readonly name: string,
  ) {}
}

export class CoercionFunction {
  constructor(readonly name: "Number" | "String" | "Boolean" | "parseInt" | "parseFloat") {}
}

export class UriFunction {
  constructor(readonly name: "encodeURI" | "encodeURIComponent" | "decodeURI" | "decodeURIComponent") {}
}

export class ProgramThrow {
  constructor(readonly value: unknown) {}
}

export class ErrorConstructorReference {
  constructor(readonly name: string) {}
}

export type DiagnosticKind =
  | "ParseError"
  | "UnsupportedSyntax"
  | "UnknownTool"
  | "InvalidToolInput"
  | "InvalidToolOutput"
  | "InvalidDataValue"
  | "ToolCallLimitExceeded"
  | "TimeoutExceeded"
  | "ToolFailure"
  | "ExecutionFailure"

export const OptionalShortCircuit: unique symbol = Symbol("codemode.optional-short-circuit")

export const supportedSyntaxMessage =
  "Supported orchestration syntax: tools.* calls (they return promises - resolve them with await), data literals, destructuring, optional chaining, template literals, conditionals, switch, loops (incl. for...of and for...in over object/array/tools keys), arrow functions, spread, try/catch, array methods (map/filter/find/findIndex/some/every/reduce/flatMap/forEach/sort/slice/concat/indexOf/lastIndexOf/at/flat/reverse/includes/join), string methods (incl. match/matchAll/replace/split with regular expressions), Date/RegExp/Map/Set/URL/URLSearchParams, URI encoding helpers, Object/Math/JSON helpers, captured console.log/warn/error/dir/table, and Promise.all/allSettled/race/resolve/reject over arrays mixing promises and plain values for parallel tool calls (promise chaining with .then/.catch is not supported - use await with try/catch)."

export class InterpreterRuntimeError extends Data.TaggedError("InterpreterRuntimeError")<{
  readonly message: string
  readonly node?: AstNode
  readonly kind: DiagnosticKind
  readonly suggestions?: ReadonlyArray<string>
}> {
  // The program-visible error type (Error, TypeError, ...) a catch block observes; see `as`.
  errorName: string = "Error"

  // Positional form kept for the stdlib call sites: `new InterpreterRuntimeError(message, node)`.
  constructor(
    message: string,
    node?: AstNode,
    kind: DiagnosticKind = "ExecutionFailure",
    suggestions?: ReadonlyArray<string>,
  ) {
    super({ message, kind, ...(node ? { node } : {}), ...(suggestions ? { suggestions } : {}) })
  }

  as(errorName: string): this {
    this.errorName = errorName
    return this
  }
}

export const unsupportedSyntax = (kind: string, node: AstNode): InterpreterRuntimeError =>
  new InterpreterRuntimeError(
    `Syntax '${kind}' is not supported in CodeMode. ${supportedSyntaxMessage}`,
    node,
    "UnsupportedSyntax",
    [supportedSyntaxMessage],
  )

export const isRecord = (value: unknown): value is Record<string, unknown> => Predicate.isObjectOrArray(value)

export const isAstNode = (value: unknown): value is AstNode => isRecord(value) && typeof value.type === "string"

export const asNode = (value: unknown, context: string): Effect.Effect<AstNode, InterpreterRuntimeError> =>
  isAstNode(value)
    ? Effect.succeed(value)
    : Effect.fail(new InterpreterRuntimeError(`Invalid AST node while reading ${context}.`))

export const getArray = (node: AstNode, key: string): Effect.Effect<Array<unknown>, InterpreterRuntimeError> => {
  const value = node[key]
  return Array.isArray(value)
    ? Effect.succeed(value)
    : Effect.fail(new InterpreterRuntimeError(`Expected '${key}' to be an array.`, node))
}

export const getString = (node: AstNode, key: string): Effect.Effect<string, InterpreterRuntimeError> => {
  const value = node[key]
  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new InterpreterRuntimeError(`Expected '${key}' to be a string.`, node))
}

export const getBoolean = (node: AstNode, key: string): Effect.Effect<boolean, InterpreterRuntimeError> => {
  const value = node[key]
  return typeof value === "boolean"
    ? Effect.succeed(value)
    : Effect.fail(new InterpreterRuntimeError(`Expected '${key}' to be a boolean.`, node))
}

// An absent child (a missing key, or null as acorn writes it) is Option.none.
export const getOptionalNode = (
  node: AstNode,
  key: string,
): Effect.Effect<Option.Option<AstNode>, InterpreterRuntimeError> => {
  const value = node[key]
  return Predicate.isNullish(value) ? Effect.succeedNone : Effect.asSome(asNode(value, key))
}

export const getNode = (node: AstNode, key: string): Effect.Effect<AstNode, InterpreterRuntimeError> =>
  asNode(node[key], key)

export const sourceLocation = (node: AstNode): { readonly line: number; readonly column: number } => ({
  line: Math.max(1, (node.loc?.start.line ?? 2) - 1),
  column: Math.max(1, (node.loc?.start.column ?? 4) - 3),
})

export const formatLocation = (node?: AstNode): string => {
  if (!node?.loc) return ""
  const location = sourceLocation(node)
  return ` (line ${location.line}, col ${location.column})`
}
