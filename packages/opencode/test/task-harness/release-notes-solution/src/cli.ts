#!/usr/bin/env bun
import { readFileSync } from "node:fs"
import path from "node:path"
import { nextVersion } from "./bump"
import { parseCommit, type InvalidCommit, type ParsedCommit } from "./commit"
import { makeLinkify, parseLinkConfig, plainLinkify } from "./links"
import { renderNotes } from "./render"

const CONFIG_FILE = "release-notes.config.json"

const USAGE = `Usage: release-notes [--from <ref>] [--to <ref>] [--current <version>]

Prints Markdown release notes for the conventional commits in a git range, then the next version.

Options:
  --from <ref>          start of the range, excluded (default: the latest stable tag vX.Y.Z)
  --to <ref>            end of the range, included (default: HEAD)
  --current <version>   the current version (default: from the tag, else 0.0.0)
  -h, --help            print this help
Each option also takes the form --name=value.
`

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_BAD_ARGUMENTS = 2
const EXIT_NOT_A_REPOSITORY = 3
const EXIT_GIT_NOT_FOUND = 4

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

type Options = { from?: string; to?: string; current?: string }

const OPTION_KEYS = new Map<string, keyof Options>([
  ["--from", "from"],
  ["--to", "to"],
  ["--current", "current"],
])

type Arguments = { kind: "help" } | { kind: "run"; options: Options } | { kind: "error"; message: string }

function parseArguments(argv: string[]): Arguments {
  const options: Options = {}
  let index = 0
  while (index < argv.length) {
    const arg = argv[index++] ?? ""
    if (arg === "--help" || arg === "-h") return { kind: "help" }
    if (!arg.startsWith("-")) return { kind: "error", message: `unexpected argument "${arg}"` }
    const equals = arg.indexOf("=")
    const name = equals === -1 ? arg : arg.slice(0, equals)
    const key = OPTION_KEYS.get(name)
    if (key === undefined) return { kind: "error", message: `unknown option "${name}"` }
    const value = equals === -1 ? argv[index++] : arg.slice(equals + 1)
    if (value === undefined) return { kind: "error", message: `${name} needs a value` }
    if (value === "") return { kind: "error", message: `${name} needs a value that is not empty` }
    if (value.startsWith("-")) return { kind: "error", message: `the value of ${name} must not start with "-"` }
    options[key] = value
  }
  return { kind: "run", options }
}

type GitResult = { code: number; stdout: string; stderr: string }

function git(args: string[]): GitResult {
  const result = Bun.spawnSync(["git", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

function warn(message: string): void {
  process.stderr.write(`release-notes: warning: ${message}\n`)
}

function fail(message: string, code: number): number {
  process.stderr.write(`release-notes: ${message}\n`)
  return code
}

/** The latest tag shaped `v<digits>...` that is reachable from `ref` and is not a pre-release. */
function latestStableTag(ref: string): string | undefined {
  const result = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "--exclude", "*-*", ref])
  const tag = result.stdout.trim()
  return result.code === 0 && tag !== "" ? tag : undefined
}

function isTag(ref: string): boolean {
  return git(["show-ref", "--verify", "--quiet", `refs/tags/${ref}`]).code === 0
}

/** Issue links from `<top level>/release-notes.config.json`; plain keys when it is missing, unreadable or invalid. */
function loadLinkify(): (key: string) => string {
  const top = git(["rev-parse", "--show-toplevel"])
  if (top.code !== 0) return plainLinkify
  const file = path.join(top.stdout.trim(), CONFIG_FILE)
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (cause) {
    const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined
    if (code === "ENOENT") return plainLinkify
    warn(`cannot read ${CONFIG_FILE} (${String(code ?? cause)}), so issue keys stay plain text`)
    return plainLinkify
  }
  const config = parseLinkConfig(text)
  if ("error" in config) {
    warn(`${CONFIG_FILE} is invalid: ${config.error}, so issue keys stay plain text`)
    return plainLinkify
  }
  return makeLinkify(config)
}

function printNotes(
  commits: (ParsedCommit | InvalidCommit)[],
  next: string,
  bump: string,
  linkify: (key: string) => string,
): void {
  process.stdout.write(`${renderNotes(commits, { linkify })}\nNext version: ${next} (${bump})\n`)
}

function main(argv: string[]): number {
  // 1. Arguments.
  const parsed = parseArguments(argv)
  if (parsed.kind === "help") {
    process.stdout.write(USAGE)
    return EXIT_OK
  }
  if (parsed.kind === "error") {
    process.stderr.write(`release-notes: ${parsed.message}\n${USAGE}`)
    return EXIT_BAD_ARGUMENTS
  }
  const options = parsed.options

  // 2. Git must start.
  try {
    git(["--version"])
  } catch {
    return fail("git not found", EXIT_GIT_NOT_FOUND)
  }

  // 3. The folder must be inside a work tree.
  const inside = git(["rev-parse", "--is-inside-work-tree"])
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    const message =
      inside.stderr.trim() ||
      `not inside a git work tree (git rev-parse --is-inside-work-tree printed "${inside.stdout.trim()}")`
    return fail(message, EXIT_NOT_A_REPOSITORY)
  }

  // 4. Every explicit ref must name a commit.
  for (const ref of [options.from, options.to]) {
    if (ref === undefined) continue
    const found = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])
    if (found.code !== 0) return fail(`unknown ref "${ref}"`, EXIT_BAD_ARGUMENTS)
  }

  const explicitCurrent = options.current?.replace(/^v/, "")
  if (explicitCurrent !== undefined) {
    const checked = nextVersion(explicitCurrent, [])
    if ("error" in checked) return fail(checked.error, EXIT_BAD_ARGUMENTS)
  }

  const linkify = loadLinkify()

  // 5. A repository with no commits yet has no changes.
  const head = git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
  if (head.code !== 0 && options.from === undefined && options.to === undefined) {
    const current = explicitCurrent ?? "0.0.0"
    printNotes([], current, "none", linkify)
    return EXIT_OK
  }

  // 6. The range.
  const to = options.to ?? "HEAD"
  const start = options.from ?? latestStableTag(to)
  const range = start === undefined ? to : `${start}..${to}`

  // 7. The current version.
  let current = "0.0.0"
  if (explicitCurrent !== undefined) current = explicitCurrent
  else if (start !== undefined && STABLE_TAG.test(start) && (options.from === undefined || isTag(start)))
    current = start.slice(1)
  else if (options.from !== undefined) {
    const tag = latestStableTag(options.from)
    if (tag !== undefined && STABLE_TAG.test(tag)) current = tag.slice(1)
  }

  // 8. The commits, one NUL-terminated record each: the short hash, then the raw message.
  const log = git([
    "-c",
    "log.showSignature=false",
    "log",
    "-z",
    "--no-color",
    "--no-merges",
    "--format=%h%n%B",
    "--end-of-options",
    range,
  ])
  if (log.code !== 0) return fail(log.stderr.trim() || `git log failed for ${range}`, EXIT_FAILED)
  const commits = log.stdout
    .split("\0")
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const text = record.replace(/^\n+/, "")
      const newline = text.indexOf("\n")
      const hash = newline === -1 ? text : text.slice(0, newline)
      return parseCommit(hash.trim(), newline === -1 ? "" : text.slice(newline + 1))
    })

  // 9. The notes and the next version.
  const result = nextVersion(
    current,
    commits.filter((commit): commit is ParsedCommit => commit.valid),
  )
  if ("error" in result) return fail(result.error, EXIT_BAD_ARGUMENTS)
  if (git(["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true") {
    warn("the repository is a shallow clone, so the range can miss commits")
  }
  for (const commit of commits) {
    if (!commit.valid && /^BREAKING[ -]CHANGE: /m.test(commit.raw.replace(/\r\n/g, "\n"))) {
      warn(`commit ${commit.hash} has a BREAKING CHANGE footer but is not a conventional commit, so it does not count`)
    }
  }
  printNotes(commits, result.next, result.bump, linkify)
  return EXIT_OK
}

process.exitCode = main(process.argv.slice(2))
