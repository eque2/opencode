import { Effect, Option, Predicate, Result, Schema, SchemaAST, SchemaIssue } from "effect"
import { BlendSchema } from "./schema"

// One file of a blend spec: YAML front matter between `---` lines, then a markdown body. Everything here is pure
// except the YAML parse, which throws on bad input and so runs inside `Effect.try`.

// The front matter as parsed YAML, or the R3 problems that stopped the parse, plus the body. A file without a
// front matter block is all body.
export interface FrontMatter {
  readonly yaml: Result.Result<unknown, ReadonlyArray<string>>
  readonly body: string
}

export class YamlError extends Schema.TaggedError<YamlError>()("BlendYamlError", {
  message: Schema.String,
}) {}

const FENCE = /^---\s*$/

export const frontMatter = Effect.fnUntraced(function* (text: string): Effect.fn.Return<FrontMatter> {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  if (!FENCE.test(lines[0] ?? "")) {
    return { yaml: Result.fail(["does not start with a `---` front matter block"]), body: lines.join("\n") }
  }
  const end = lines.findIndex((line, index) => index > 0 && FENCE.test(line))
  if (end < 0) return { yaml: Result.fail(["the front matter block has no closing `---` line"]), body: "" }
  const source = lines.slice(1, end)
  const body = lines.slice(end + 1).join("\n")
  // The front matter starts on line 2 of the file.
  const duplicates = duplicateKeys(source, 2)
  if (duplicates.length > 0) return { yaml: Result.fail(duplicates), body }
  const parsed = yield* Effect.result(
    Effect.try({
      try: () => Bun.YAML.parse(source.join("\n")),
      catch: (cause) => new YamlError({ message: Predicate.isError(cause) ? cause.message : String(cause) }),
    }),
  )
  if (Result.isFailure(parsed)) return { yaml: Result.fail([`YAML: ${parsed.failure.message}`]), body }
  // An empty front matter block parses to null: it declares nothing.
  return { yaml: Result.succeed(parsed.success ?? {}), body }
})

// Decodes parsed front matter against one of the four schemas. Each schema issue becomes one R3 problem that
// names the path inside the front matter, for example `touches/0/change`. The messages are the ones the reference
// checker's JSON Schema validator (Python `jsonschema`) writes, for the value types the four schemas accept:
// strings, integers, booleans, null, lists and mappings with string keys. Some Python reprs cannot be rebuilt from
// the JS values the YAML parse gives: a float (`1.0`, `inf`, `nan`) and a mapping key that is not a string. A
// whole-number float prints as an integer, so a message that quotes such a value can differ from the checker's.
export const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  yaml: unknown,
): Result.Result<S["Type"], ReadonlyArray<string>> =>
  Result.mapError(Schema.decodeUnknownResult(schema)(yaml, BlendSchema.parseOptions), (error) =>
    formatIssues(error.issue),
  )

// One problem, or one excess key of the object at `path`. jsonschema names all the excess keys of an object in a
// single message, so they are merged after the walk.
type Entry =
  | { readonly kind: "problem"; readonly path: string; readonly message: string }
  | { readonly kind: "excess"; readonly path: string; readonly key: string }

const formatIssues = (issue: SchemaIssue.Issue): ReadonlyArray<string> => {
  const all = entries(issue, [])
  const excessAt = (path: string) =>
    all.flatMap((entry) => (entry.kind === "excess" && entry.path === path ? [entry.key] : []))
  return all.flatMap((entry, index) => {
    if (entry.kind === "problem") return [`${at(entry.path)}: ${entry.message}`]
    // The object's first excess key carries the message for all of them, which jsonschema sorts.
    if (all.findIndex((other) => other.kind === "excess" && other.path === entry.path) !== index) return []
    const keys = excessAt(entry.path).toSorted()
    const listed = `${keys.map(repr).join(", ")} ${keys.length === 1 ? "was" : "were"} unexpected`
    return [`${at(entry.path)}: Additional properties are not allowed (${listed})`]
  })
}

const at = (path: string) => (path === "" ? "(root)" : path)

const problem = (path: ReadonlyArray<PropertyKey>, message: string): Entry => ({
  kind: "problem",
  path: path.map(String).join("/"),
  message,
})

const entries = (issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey>): ReadonlyArray<Entry> => {
  switch (issue._tag) {
    case "Pointer":
      return entries(issue.issue, [...path, ...issue.path])
    case "Encoding":
      return entries(issue.issue, path)
    case "Composite":
      return issue.issues.flatMap((inner) => entries(inner, path))
    case "AnyOf":
      return [problem(path, unionMessage(issue))]
    case "InvalidType":
      return orStandard(typeMessage(issue), issue, path)
    case "Filter":
      return orStandard(checkMessage(issue), issue, path)
    // jsonschema reports a missing key (`required`) on the object, not at the key.
    case "MissingKey":
      return [problem(path.slice(0, -1), `${repr(String(path.at(-1)))} is a required property`)]
    case "UnexpectedKey":
      return unexpectedKey(issue, path)
    default:
      return orStandard(Option.none(), issue, path)
  }
}

const standard = SchemaIssue.makeFormatterStandardSchemaV1()

// An issue the four schemas do not produce keeps Effect's own message.
const orStandard = (
  message: Option.Option<string>,
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>,
): ReadonlyArray<Entry> =>
  Option.isSome(message)
    ? [problem(path, message.value)]
    : standard(issue).issues.map((entry) =>
        problem(
          [...path, ...(entry.path ?? []).map((segment) => String(Predicate.isObject(segment) ? segment.key : segment))],
          entry.message,
        ),
      )

// A union of literals is a JSON Schema `enum`. A union whose members are all one JSON type is that `type` with an
// `anyOf` of checks (the scenario-or-ref id). The checks ignore a value of another type, so jsonschema reports
// `type` alone. Effect marks that value: no member accepts its type, so the issue holds no inner issues. Any other
// union is a `oneOf` or an `anyOf`.
const unionMessage = (issue: SchemaIssue.AnyOf) => {
  const literals = issue.ast.types.filter(SchemaAST.isLiteral)
  if (literals.length === issue.ast.types.length) {
    return `${repr(issue.input)} is not one of [${literals.map((member) => repr(member.literal)).join(", ")}]`
  }
  const types = issue.ast.types.map((member) => JSON_TYPES[member._tag])
  const [type] = types
  if (issue.issues.length === 0 && Predicate.isString(type) && types.every((item) => item === type)) {
    return `${repr(issue.input)} is not of type ${repr(type)}`
  }
  return `${repr(issue.input)} is not valid under any of the given schemas`
}

const JSON_TYPES: Partial<Record<SchemaAST.AST["_tag"], string>> = {
  Objects: "object",
  Arrays: "array",
  String: "string",
  Number: "number",
  Boolean: "boolean",
  Null: "null",
}

const INT = "effect/schema/isInt"

// A single literal is a JSON Schema `const`. An `Int` is a number that carries the integer check.
const typeMessage = (issue: SchemaIssue.InvalidType) => {
  if (SchemaAST.isLiteral(issue.ast)) return Option.some(`${repr(issue.ast.literal)} was expected`)
  const integer = (issue.ast.checks ?? []).some((check) => check.annotations?.representation?.id === INT)
  const type = integer ? "integer" : JSON_TYPES[issue.ast._tag]
  return Option.map(Option.fromNullishOr(type), (name) => `${repr(issue.input)} is not of type ${repr(name)}`)
}

// A failed check, in the words of the JSON Schema keyword it mirrors.
const checkMessage = (issue: SchemaIssue.Filter) => {
  const value = repr(issue.input)
  const source = issue.filter.annotations?.pattern
  if (Predicate.isString(source)) return Option.some(`${value} does not match ${repr(source)}`)
  const representation = issue.filter.annotations?.representation
  const payload = representation?.payload
  const limits: Record<string, unknown> = Predicate.isObject(payload) ? Object.fromEntries(Object.entries(payload)) : {}
  switch (representation?.id) {
    case "effect/schema/isMinLength":
      return Option.some(`${value} ${limits.minLength === 1 ? "should be non-empty" : "is too short"}`)
    case "effect/schema/isMinProperties":
      return Option.some(`${value} ${limits.minProperties === 1 ? "should be non-empty" : "does not have enough properties"}`)
    case "effect/schema/isUnique":
      return Option.some(`${value} has non-unique elements`)
    case "effect/schema/isGreaterThanOrEqualTo":
      return Option.some(`${value} is less than the minimum of ${repr(limits.minimum)}`)
    case INT:
      return Option.some(`${value} is not of type 'integer'`)
  }
  return Option.none<string>()
}

// A key the object does not declare. In a record it is a key that fails the record's key pattern, which jsonschema
// reports as `propertyNames` on the record. In a struct it is an excess key (`additionalProperties`).
const unexpectedKey = (issue: SchemaIssue.UnexpectedKey, path: ReadonlyArray<PropertyKey>): ReadonlyArray<Entry> => {
  const key = String(path.at(-1))
  const parent = path.slice(0, -1)
  const keyPattern = (SchemaAST.isObjects(issue.ast) ? issue.ast.indexSignatures : [])
    .flatMap((signature) => signature.parameter.checks ?? [])
    .map((check) => check.annotations?.pattern)
    .find(Predicate.isString)
  if (keyPattern !== undefined) return [problem(parent, `${repr(key)} does not match ${repr(keyPattern)}`)]
  return [{ kind: "excess", path: parent.map(String).join("/"), key }]
}

// Python's `repr` of a parsed YAML value, as jsonschema puts it in its messages. A number prints as JS writes it:
// right for an integer, but a whole-number float such as `1.0` prints as `1` (see `decode`).
const repr = (value: unknown): string => {
  if (Predicate.isString(value)) return reprString(value)
  if (Predicate.isBoolean(value)) return value ? "True" : "False"
  if (Predicate.isNullish(value)) return "None"
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`
  if (Predicate.isObject(value)) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${reprString(key)}: ${repr(item)}`)
      .join(", ")}}`
  }
  return Predicate.isNumber(value) || Predicate.isBigInt(value) ? value.toString() : ""
}

const ESCAPES: Partial<Record<string, string>> = { "\\": "\\\\", "\t": "\\t", "\n": "\\n", "\r": "\\r" }

// Python quotes with `'` unless the text holds a `'` and no `"`. It escapes the quote, the backslash and every
// character it does not print (controls, format characters, separators other than the space).
const reprString = (text: string) => {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'"
  const body = Array.from(text, (char) => {
    if (char === quote) return `\\${char}`
    const escaped = ESCAPES[char]
    if (escaped !== undefined) return escaped
    if (char === " " || !/[\p{C}\p{Z}]/u.test(char)) return char
    const code = char.codePointAt(0) ?? 0
    const hex = code.toString(16)
    if (code <= 0xff) return `\\x${hex.padStart(2, "0")}`
    if (code <= 0xffff) return `\\u${hex.padStart(4, "0")}`
    return `\\U${hex.padStart(8, "0")}`
  }).join("")
  return `${quote}${body}${quote}`
}

interface Frame {
  readonly indent: number
  readonly keys: ReadonlyArray<string>
}

interface Scan {
  readonly frames: ReadonlyArray<Frame>
  // While a block scalar (`|` or `>`) is open: the column its text is indented past. Those lines are text.
  readonly scalar: Option.Option<number>
  // While a quoted scalar runs over several lines: its quote character. Those lines are text.
  readonly quote: Option.Option<string>
  readonly problems: ReadonlyArray<string>
}

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#[\]{},:-][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/
const BLOCK_SCALAR = /^[|>][1-9+-]{0,2}\s*(#.*)?$/

// Bun.YAML keeps the last of two equal keys silently, and the format refuses duplicate keys (R3). This scan finds
// them in block mappings: it tracks one key list for each open mapping, by indent, and opens a fresh mapping for
// each sequence item. It skips the text of block scalars and of quoted scalars that run over several lines.
// ponytail: flow mappings are not scanned, so `{a: 1, a: 2}` is accepted with the last value. The upgrade path is
// a YAML parser that refuses duplicate keys itself, which would replace this scan.
export const duplicateKeys = (lines: ReadonlyArray<string>, firstLine: number): ReadonlyArray<string> =>
  lines.reduce<Scan>((scan, line, index) => step(scan, line, firstLine + index), {
    frames: [],
    scalar: Option.none(),
    quote: Option.none(),
    problems: [],
  }).problems

const indentOf = (line: string) => line.length - line.trimStart().length

const step = (scan: Scan, line: string, number: number): Scan => {
  if (Option.isSome(scan.quote)) {
    return closesQuote(line, scan.quote.value) ? { ...scan, quote: Option.none() } : scan
  }
  const trimmed = line.trim()
  const indent = indentOf(line)
  if (Option.isSome(scan.scalar) && (trimmed === "" || indent > scan.scalar.value)) return scan
  const open = { ...scan, scalar: Option.none<number>() }
  if (trimmed === "" || trimmed.startsWith("#")) return open
  const item = sequenceItem(line.slice(indent), indent)
  const frames = Option.match(item, {
    onNone: () => open.frames,
    onSome: (start) => [
      ...open.frames.filter((frame) => frame.indent < start.indent),
      { indent: start.indent, keys: [] },
    ],
  })
  const column = Option.match(item, { onNone: () => indent, onSome: (start) => start.indent })
  const rest = Option.match(item, { onNone: () => line.slice(indent), onSome: (start) => start.rest })
  const match = KEY.exec(rest)
  if (!match) {
    // A value on its own line: a sequence item such as `- |` opens a block scalar indented past its dash, and a
    // quote that does not close on this line opens a multi-line quoted scalar.
    const scalar = Option.filter(
      Option.map(item, (start) => start.dash),
      () => BLOCK_SCALAR.test(rest.trim()),
    )
    return { ...open, frames, scalar, quote: opensQuote(rest) }
  }
  const key = unquote(match[1])
  const value = (match[2] ?? "").trim()
  const kept = frames.filter((frame) => frame.indent <= column)
  const top = kept.at(-1)
  const scalar = BLOCK_SCALAR.test(value) ? Option.some(column) : Option.none<number>()
  const quote = opensQuote(value)
  if (top && top.indent === column) {
    const problems = top.keys.includes(key)
      ? [...open.problems, `YAML line ${number}: duplicate key '${key}'`]
      : open.problems
    return { frames: [...kept.slice(0, -1), { indent: column, keys: [...top.keys, key] }], scalar, quote, problems }
  }
  return { frames: [...kept, { indent: column, keys: [key] }], scalar, quote, problems: open.problems }
}

// `- key: value` opens a mapping whose keys sit at the column after the dash. Nested items (`- - a`) go deeper.
// `dash` is the column of the innermost dash.
const sequenceItem = (text: string, indent: number): Option.Option<{ indent: number; dash: number; rest: string }> => {
  const dash = /^-(\s+|$)/.exec(text)
  if (!dash) return Option.none()
  const start = indent + dash[0].length
  const rest = text.slice(dash[0].length)
  return Option.some(Option.getOrElse(sequenceItem(rest, start), () => ({ indent: start, dash: indent, rest })))
}

// The quote character of a quoted scalar that starts in `value` and does not close on the same line.
const opensQuote = (value: string): Option.Option<string> => {
  const text = value.trim()
  const quote = text.charAt(0)
  if (quote !== '"' && quote !== "'") return Option.none()
  return closesQuote(text.slice(1), quote) ? Option.none() : Option.some(quote)
}

// True when `text`, read from inside a quoted scalar, holds its closing quote. In a double-quoted scalar `\"` is an
// escaped quote; in a single-quoted scalar `''` is.
const closesQuote = (text: string, quote: string) =>
  (quote === '"' ? /^(?:[^"\\]|\\.)*"/ : /^(?:[^']|'')*'(?!')/).test(text)

const unquote = (key: string) => {
  if (key.startsWith('"') && key.endsWith('"')) return key.slice(1, -1)
  if (key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1).replaceAll("''", "'")
  return key
}

// The H1 that opens a `SPEC.md` or `TASK.md` body.
export const title = (body: string): Option.Option<string> => {
  const first = body.split("\n").find((line) => line.trim() !== "")
  const match = /^#\s+(\S.*)$/.exec(first ?? "")
  return match ? Option.some(match[1].trim()) : Option.none()
}

// The text of a `## <name>` section, up to the next H1 or H2. None when the heading is absent. A `#` line inside
// a code fence is code, not a heading.
export const section = (body: string, name: string): Option.Option<string> => {
  const lines = body.split("\n")
  const inFence = fenced(lines)
  const start = lines.findIndex((line, index) => !inFence[index] && /^##\s+(.+?)\s*$/.exec(line)?.[1] === name)
  if (start < 0) return Option.none()
  const end = lines.findIndex((line, index) => index > start && !inFence[index] && /^#{1,2}\s/.test(line))
  return Option.some(
    lines
      .slice(start + 1, end < 0 ? lines.length : end)
      .join("\n")
      .trim(),
  )
}

const FENCE_MARKER = /^\s*(`{3,}|~{3,})/

interface Fences {
  // The marker of the open code fence.
  readonly open: Option.Option<string>
  readonly flags: ReadonlyArray<boolean>
}

// For each line, whether it belongs to a code fence (its marker lines included). A fence closes on a marker of the
// same character that is at least as long as the one that opened it.
const fenced = (lines: ReadonlyArray<string>): ReadonlyArray<boolean> =>
  lines.reduce<Fences>(
    (state, line) => {
      const marker = FENCE_MARKER.exec(line)?.[1] ?? ""
      if (Option.isNone(state.open)) {
        return { open: marker === "" ? Option.none() : Option.some(marker), flags: [...state.flags, marker !== ""] }
      }
      const opening = state.open.value
      const closes = marker !== "" && marker[0] === opening[0] && marker.length >= opening.length
      return { open: closes ? Option.none() : state.open, flags: [...state.flags, true] }
    },
    { open: Option.none(), flags: [] },
  ).flags

export interface Gherkin {
  readonly title: string
  readonly tags: ReadonlyArray<string>
  readonly steps: ReadonlyArray<string>
}

// A scenario body is exactly one gherkin block: tag lines, one `Scenario:` line that starts with the file's id,
// then the steps. Fails with the R4 problems.
export const gherkin = (body: string, id: string): Result.Result<Gherkin, ReadonlyArray<string>> => {
  const lines = body.trim().split("\n")
  const inner = lines.slice(1, -1)
  const fenced =
    lines.length >= 2 &&
    lines[0].trim() === "```gherkin" &&
    lines.at(-1)?.trim() === "```" &&
    !inner.some((line) => line.trimStart().startsWith("```"))
  if (!fenced) return Result.fail(["body is not exactly one ```gherkin block"])
  const scenarioLines = inner.flatMap((line, index) => (/^\s*Scenario:/.test(line) ? [index] : []))
  if (scenarioLines.length !== 1) {
    return Result.fail([
      scenarioLines.length === 0
        ? "the gherkin block has no `Scenario:` line"
        : "the gherkin block has more than one `Scenario:` line",
    ])
  }
  const at = scenarioLines[0]
  const head = inner.slice(0, at).filter((line) => line.trim() !== "")
  const rest = inner[at].trim().replace(/^Scenario:\s*/, "")
  const named = rest.split(/\s+/)[0] ?? ""
  const name = rest.slice(named.length).trim()
  const steps = inner
    .slice(at + 1)
    .map((line) => line.trim())
    .filter((line) => line !== "")
  const problems = [
    // A tag line holds tags only: every token is `@` and a name.
    ...(head.every((line) =>
      line
        .trim()
        .split(/\s+/)
        .every((token) => /^@\S+$/.test(token)),
    )
      ? []
      : ["a line before the `Scenario:` line is not a tag line"]),
    ...(named === id ? [] : [`the Scenario line names ${named === "" ? "no id" : named}, the file is ${id}`]),
    ...(name === "" ? ["the Scenario line has no title"] : []),
    ...(steps.length > 0 ? [] : ["the scenario has no steps"]),
  ]
  if (problems.length > 0) return Result.fail(problems)
  return Result.succeed({ title: name, tags: head.flatMap((line) => line.trim().split(/\s+/)), steps })
}

// A task-list checkbox (`- [ ]`, `* [x]`, `1. [X]`) outside a code fence: state, which R11 keeps out of the files.
export const hasCheckbox = (body: string) => {
  const lines = body.split("\n")
  const inFence = fenced(lines)
  return lines.some((line, index) => !inFence[index] && /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\](?:\s|$)/.test(line))
}

export * as BlendDocument from "./document"
