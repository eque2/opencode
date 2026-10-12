import { Effect, Option, Predicate, Result, Schema, SchemaIssue } from "effect"
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
// names the path inside the front matter, for example `touches/0/change`.
export const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  yaml: unknown,
): Result.Result<S["Type"], ReadonlyArray<string>> =>
  Result.mapError(Schema.decodeUnknownResult(schema)(yaml, BlendSchema.parseOptions), (error) =>
    formatIssues(error.issue),
  )

const standard = SchemaIssue.makeFormatterStandardSchemaV1()

const formatIssues = (issue: SchemaIssue.Issue) =>
  standard(issue).issues.map((entry) => {
    const at = (entry.path ?? [])
      .map((segment) => String(Predicate.isObject(segment) ? segment.key : segment))
      .join("/")
    return `${at === "" ? "(root)" : at}: ${entry.message}`
  })

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
const sequenceItem = (
  text: string,
  indent: number,
): Option.Option<{ indent: number; dash: number; rest: string }> => {
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

// The text of a `## <name>` section, up to the next H1 or H2. None when the heading is absent.
export const section = (body: string, name: string): Option.Option<string> => {
  const lines = body.split("\n")
  const start = lines.findIndex((line) => /^##\s+(.+?)\s*$/.exec(line)?.[1] === name)
  if (start < 0) return Option.none()
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line))
  return Option.some((end < 0 ? rest : rest.slice(0, end)).join("\n").trim())
}

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
    ...(head.every((line) => line.trim().startsWith("@"))
      ? []
      : ["a line before the `Scenario:` line is not a tag line"]),
    ...(named === id ? [] : [`the Scenario line names ${named === "" ? "no id" : named}, the file is ${id}`]),
    ...(name === "" ? ["the Scenario line has no title"] : []),
    ...(steps.length > 0 ? [] : ["the scenario has no steps"]),
  ]
  if (problems.length > 0) return Result.fail(problems)
  return Result.succeed({ title: name, tags: head.flatMap((line) => line.trim().split(/\s+/)), steps })
}

// A task-list checkbox (`- [ ]`, `* [x]`, `1. [X]`): state, which R11 keeps out of the files.
export const hasCheckbox = (body: string) => /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\](?:\s|$)/m.test(body)

export * as BlendDocument from "./document"
