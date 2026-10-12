import { Chunk, Option } from "effect"

// Reads the result of one `bun test` run: the JUnit report gives every test case and its status, and
// the console output gives the failure messages, which Bun's JUnit reporter leaves out.

/** One test case of the JUnit report. */
export interface TestCase {
  /** The test file, relative to the working tree. */
  readonly file: string
  /** The enclosing `describe` names, outermost first. */
  readonly path: ReadonlyArray<string>
  /** The test's own title, without the `describe` names. */
  readonly name: string
  readonly status: "passed" | "failed" | "skipped"
  /** The `type` of the failure element, for example `AssertionError` or `TimeoutError`. */
  readonly failureType: string
  /** The `message` attribute and the text of the failure element, when the report gives them. */
  readonly failureText: string
}

/** One failing test in the console output, with its error message. */
export interface ConsoleFailure {
  /** The test file of the enclosing file header; empty when the output has none. */
  readonly file: string
  /** The full title: the `describe` names and the test title, joined by " > ". */
  readonly title: string
  readonly message: string
}

/** The full title of a test case as Bun prints it in the console: `describe > … > title`. */
export const fullTitle = (test: TestCase) => [...test.path, test.name].join(" > ")

/** True when the test case failed because it ran past the per-test timeout. */
export const timedOut = (test: TestCase) =>
  test.status === "failed" && (test.failureType === "TimeoutError" || /timed out/i.test(test.failureText))

const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g
const NAMED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }

const decode = (text: string) =>
  text.replace(ENTITY, (_, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return NAMED[entity] ?? `&${entity};`
  })

const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const TAG = /<(\/?)([A-Za-z][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

const attributes = (text: string): Readonly<Record<string, string>> =>
  Object.fromEntries(Array.from(text.matchAll(ATTRIBUTE), (match) => [match[1], decode(match[2] ?? match[3] ?? "")]))

interface Open {
  readonly file: string
  readonly path: ReadonlyArray<string>
  readonly name: string
  readonly status: TestCase["status"]
  readonly failureType: string
  readonly failureText: string
  /** Where the text of an open failure element starts. */
  readonly textStart: Option.Option<number>
}

// Bun does not prefix the title with the describe names; strip them if a later version does.
const ownTitle = (name: string, path: ReadonlyArray<string>) => {
  const prefix = path.length > 0 ? `${path.join(" > ")} > ` : ""
  return prefix !== "" && name.startsWith(prefix) ? name.slice(prefix.length) : name
}

const joinText = (left: string, right: string) => [left, right.trim()].filter((part) => part !== "").join("\n")

/**
 * Parses a JUnit report from Bun's `--reporter=junit`. The outermost `testsuite` is the file; each
 * nested `testsuite` is a `describe` block. A test case with a `failure` or `error` element failed; one
 * with a `skipped` element (skip or todo) was skipped; every other one passed.
 */
export const parse = (xml: string): ReadonlyArray<TestCase> => {
  const source = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, text: string) => escapeText(text))
  let suites: ReadonlyArray<string> = []
  let open = Option.none<Open>()
  let found = Chunk.empty<TestCase>()
  const close = (current: Open) => {
    found = Chunk.append(found, {
      file: current.file,
      path: current.path,
      name: current.name,
      status: current.status,
      failureType: current.failureType,
      failureText: current.failureText,
    })
    open = Option.none()
  }
  for (const match of source.matchAll(TAG)) {
    const closing = match[1] === "/"
    const element = match[2]
    const attrs = attributes(match[3] ?? "")
    const selfClosing = match[4] === "/"
    const end = (match.index ?? 0) + match[0].length
    if (element === "testsuite") {
      if (closing) suites = suites.slice(0, -1)
      else if (!selfClosing) suites = [...suites, attrs.name ?? ""]
      continue
    }
    if (element === "testcase") {
      if (closing) {
        if (Option.isSome(open)) close(open.value)
        continue
      }
      const path = suites.slice(1)
      const current: Open = {
        file: attrs.file ?? suites[0] ?? "",
        path,
        name: ownTitle(attrs.name ?? "", path),
        status: "passed",
        failureType: "",
        failureText: "",
        textStart: Option.none(),
      }
      if (selfClosing) close(current)
      else open = Option.some(current)
      continue
    }
    if (Option.isNone(open)) continue
    const current = open.value
    if (element === "failure" || element === "error") {
      if (closing) {
        const text = Option.match(current.textStart, {
          onNone: () => "",
          onSome: (start) => decode(source.slice(start, match.index ?? start)),
        })
        open = Option.some({ ...current, failureText: joinText(current.failureText, text), textStart: Option.none() })
        continue
      }
      open = Option.some({
        ...current,
        status: "failed",
        failureType: current.failureType || (attrs.type ?? ""),
        failureText: joinText(current.failureText, attrs.message ?? ""),
        textStart: selfClosing ? Option.none() : Option.some(end),
      })
      continue
    }
    if (element === "skipped" && !closing && current.status !== "failed") {
      open = Option.some({ ...current, status: "skipped" })
    }
  }
  return Chunk.toReadonlyArray(found)
}

// The console output marks each test with `(pass)`, `(fail)`, `(skip)` or `(todo)` and its full title,
// and prints the error of a failing test just above its `(fail)` line.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
const MARKER = /^\((pass|fail|skip|todo)\) (.*?)(?: \[[0-9.]+m?s\])?\s*$/
const FILE_HEADER = /^(\S+\.[cm]?[jt]sx?):$/
const ERROR_LINE = /^\s*(?:error|[A-Za-z]*Error)\b[^:]*:/
const STACK_LINE = /^\s+at /
const messageLimit = 2000

// The error text in the lines above a `(fail)` line: from the first error line to the stack trace.
const errorText = (lines: ReadonlyArray<string>): string => {
  const first = lines.findIndex((line) => ERROR_LINE.test(line))
  if (first < 0) return ""
  const rest = lines.slice(first)
  const stack = rest.findIndex((line) => STACK_LINE.test(line))
  const text = (stack < 0 ? rest : rest.slice(0, stack))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text.length > messageLimit ? `${text.slice(0, messageLimit)}…` : text
}

/** Reads the failing tests and their error messages from Bun's console output. */
export const consoleFailures = (output: string): ReadonlyArray<ConsoleFailure> => {
  const lines = output.replace(ANSI, "").split(/\r?\n/)
  let file = ""
  let blockStart = 0
  let found = Chunk.empty<ConsoleFailure>()
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const header = FILE_HEADER.exec(line)
    if (header) {
      file = header[1]
      blockStart = index + 1
      continue
    }
    const marker = MARKER.exec(line)
    if (!marker) continue
    if (marker[1] === "fail") {
      found = Chunk.append(found, { file, title: marker[2], message: errorText(lines.slice(blockStart, index)) })
    }
    blockStart = index + 1
  }
  return Chunk.toReadonlyArray(found)
}

/** The console error message of a failed test case, when the output holds one. */
export const messageOf = (test: TestCase, failures: ReadonlyArray<ConsoleFailure>): Option.Option<string> => {
  const title = fullTitle(test)
  const match =
    failures.find((failure) => failure.title === title && failure.file === test.file) ??
    failures.find((failure) => failure.title === title && failure.file === "")
  return Option.fromNullishOr(match).pipe(
    Option.map((failure) => failure.message),
    Option.filter((message) => message !== ""),
  )
}

export * as Junit from "./junit"
