import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Duration, Effect, FileSystem, Schema } from "effect"
import nodeFs from "fs"
import path from "path"
import ts from "typescript"
import { Junit } from "@/task/proof/junit"
import { ProofProcess } from "@/task/proof/process"
import { testEffect } from "../lib/effect"

// Scenario SV19 (spec task-harness-feedback, D9, AD-17; tasks T2.13, T4.13): the allowlist holds exactly its final
// entries.
//
//   Given the end of phase 2 and the end of the goal
//   When the audit's allowlist is compared with the spine's final allowlist
//   Then at the end of phase 2 the entries for the harness source equal the final entries for that tree
//   And at the end of the goal the whole allowlist equals the final allowlist and no interim entry remains
//
// The end of phase 2 is commit 67f6d91e53 ("Record the phase-2 gate and complete T2.14", the last commit of phase 2;
// the audit file is the same from T2.13's 2bbc9799ad to there). The end of the goal is the current tree. The audit is
// the D9 audit, `test/task/state-audit.test.ts`, which exports nothing: for each point in time, the audited trees and
// the audit file are copied into a scoped temporary tree (`git archive` of the commit, or the current files), one test
// is appended to the copied audit that prints its `ALLOWLIST` and its findings over that tree, and the copy runs in a
// nested `bun test` together with its own "passes on the current tree with the allowlist". The audit code is not
// changed or re-implemented; the appended test only reads its values.
//
// The spine's final allowlist is read from the AD-17 table of architecture/ARCHITECTURE-SPINE.md at run time: each
// row's identifiers (backticked, outside parentheses) and its file. Two rows need a reading, stated here:
// - "`FactSchema` literal members (`run.ended` state, verdict, result status)": the literal members live in FactSchema
//   and in the module-level schemas of events.ts that FactSchema's initializer references and that hold a literal
//   list of two or more members (read from that tree's events.ts with the TypeScript parser: Verdict, Result_). The
//   audit names the declaration that holds a list, so each of these is one entry.
// - "`mergeRetry`, only if the audit's polled-loop rule matches `Schedule`": expected only when the audit finds a
//   construct in that file.

const it = testEffect(NodeServices.layer)

const ROOT = path.resolve(import.meta.dir, "../../../..")
const AUDIT = "packages/opencode/test/task/state-audit.test.ts"
const TREES = ["packages/opencode/src/task", "packages/tui/src/task-ui"]
const HARNESS = "packages/opencode/src/task/"
const UI = "packages/tui/src/task-ui/"
const EVENTS = "packages/opencode/src/task/core/events.ts"
const SPINE = "_bmad-output/goals/task-harness-feedback.goal/architecture/ARCHITECTURE-SPINE.md"
/** The last commit of phase 2. */
const PHASE2 = "67f6d91e53b6e6d5438e27553adf688b25b2bd67"
const PASSES = "passes on the current tree with the allowlist"
const DUMP_TITLE = "SV19 dump of the allowlist and the findings"
const DUMP_MARK = "SV19-DUMP "

// Appended to the copied audit: it reads the audit's own ALLOWLIST, files and scan, and prints them.
const DUMP = `
test(${JSON.stringify(DUMP_TITLE)}, () => {
  const findings = files().flatMap((file) => scan(file, fs.readFileSync(path.join(ROOT, file), "utf8")))
  console.log(${JSON.stringify(DUMP_MARK)} + JSON.stringify({ allowlist: ALLOWLIST, findings }))
})
`

const Dump = Schema.Struct({
  allowlist: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      identifier: Schema.String,
      reason: Schema.String,
      until: Schema.optionalKey(Schema.String),
    }),
  ),
  findings: Schema.Array(
    Schema.Struct({ file: Schema.String, identifier: Schema.String, rule: Schema.String, line: Schema.Number }),
  ),
})
const decodeDump = Schema.decodeUnknownSync(Schema.fromJsonString(Dump))

const key = (item: { readonly file: string; readonly identifier: string }) => `${item.file} ${item.identifier}`
const sorted = (list: ReadonlyArray<string>) => [...new Set(list)].toSorted()

interface Row {
  readonly identifiers: ReadonlyArray<string>
  readonly file: string
  readonly reason: string
  /** "only if ...": the entry is expected only when its condition holds. */
  readonly conditional: boolean
  /** "literal members": the row covers the literal lists of the named schema. */
  readonly literalMembers: boolean
}

/** The rows of the spine's AD-17 table. */
const spineRows = (text: string): ReadonlyArray<Row> => {
  const start = text.indexOf("### AD-17")
  const section = text.slice(start, text.indexOf("### AD-18", start))
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const [, cell = "", fileCell = "", reason = ""] = line.split("|").map((part) => part.trim())
      // The identifier cell without its parenthesised notes (nested ones included).
      let bare = cell
      for (let before = ""; before !== bare; ) {
        before = bare
        bare = bare.replace(/\([^()]*\)/g, "")
      }
      const [named = "", condition] = bare.split(/,?\s*only if\s*/)
      return {
        identifiers: [...named.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""),
        file: [...fileCell.matchAll(/`(packages\/[^`]+)`/g)].map((match) => match[1] ?? "")[0] ?? "",
        reason,
        conditional: condition !== undefined,
        literalMembers: named.includes("literal members"),
      }
    })
}

/**
 * The module-level schemas of events.ts that FactSchema's initializer references and that hold a `Literals` list of two
 * or more strings, with their members.
 */
const factLiteralSchemas = (text: string) => {
  const source = ts.createSourceFile("events.ts", text, ts.ScriptTarget.Latest, true)
  const declarations = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .flatMap((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.initializer
        ? [{ name: declaration.name.text, init: declaration.initializer }]
        : [],
    )
  const members = (node: ts.Node): ReadonlyArray<string> => {
    const own =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "Literals" &&
      node.arguments[0] !== undefined &&
      ts.isArrayLiteralExpression(node.arguments[0])
        ? node.arguments[0].elements.filter(ts.isStringLiteral).map((element) => element.text)
        : []
    const inner: Array<string> = []
    ts.forEachChild(node, (child) => {
      inner.push(...members(child))
    })
    return [...(own.length >= 2 ? own : []), ...inner]
  }
  const fact = declarations.find((item) => item.name === "FactSchema")
  const referenced: Array<string> = []
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) referenced.push(node.text)
    ts.forEachChild(node, visit)
  }
  if (fact) visit(fact.init)
  return declarations
    .filter((item) => item.name !== "FactSchema" && referenced.includes(item.name))
    .map((item) => ({ name: item.name, members: members(item.init) }))
    .filter((item) => item.members.length >= 2)
}

/** The spine's final allowlist as keys, read for one tree: its events.ts, and the audit's findings in it. */
const finalKeys = (
  rows: ReadonlyArray<Row>,
  events: string,
  findings: ReadonlyArray<{ readonly file: string }>,
): ReadonlyArray<string> =>
  rows.flatMap((row) => {
    if (row.conditional && !findings.some((finding) => finding.file === row.file)) return []
    const identifiers = row.literalMembers
      ? [...row.identifiers, ...factLiteralSchemas(events).map((item) => item.name)]
      : row.identifiers
    return identifiers.map((identifier) => key({ file: row.file, identifier }))
  })

const git = (args: ReadonlyArray<string>, cwd = ROOT) =>
  ProofProcess.run("git", args, { cwd, timeout: Duration.seconds(60), cancelDeadline: Duration.seconds(5) })

/** A scoped copy of the audited trees and the audit file: from `commit`, or from the current tree. */
const copyOf = Effect.fnUntraced(function* (commit?: string) {
  const fs = yield* FileSystem.FileSystem
  const tree = yield* fs.makeTempDirectoryScoped()
  if (commit === undefined) {
    for (const item of [...TREES, AUDIT])
      nodeFs.cpSync(path.join(ROOT, item), path.join(tree, item), { recursive: true })
  } else {
    const tar = path.join(tree, "tree.tar")
    const archive = yield* git(["archive", "--format=tar", "-o", tar, commit, ...TREES, AUDIT])
    expect({ archive: archive.exitCode, stderr: archive.stderr }).toEqual({ archive: 0, stderr: "" })
    const untar = yield* ProofProcess.run("tar", ["-xf", tar, "-C", tree], {
      cwd: tree,
      timeout: Duration.seconds(60),
      cancelDeadline: Duration.seconds(5),
    })
    expect(untar.exitCode).toBe(0)
  }
  nodeFs.symlinkSync(path.join(ROOT, "node_modules"), path.join(tree, "node_modules"))
  return tree
})

/** Runs the copied audit's "passes" test and the appended dump; returns the pass status and the dump. */
const auditAt = Effect.fnUntraced(function* (commit?: string) {
  const fs = yield* FileSystem.FileSystem
  const tree = yield* copyOf(commit)
  const auditFile = path.join(tree, AUDIT)
  nodeFs.appendFileSync(auditFile, DUMP)
  const report = path.join(tree, "junit.xml")
  const result = yield* ProofProcess.run(
    process.execPath,
    [
      "test",
      "--timeout",
      "30000",
      `./${path.relative("packages/opencode", AUDIT)}`,
      "-t",
      `${PASSES}|${DUMP_TITLE}`,
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    { cwd: path.join(tree, "packages/opencode"), timeout: Duration.seconds(100), cancelDeadline: Duration.seconds(5) },
  )
  expect(result.timedOut).toBe(false)
  const cases = Junit.parse(yield* fs.readFileString(report).pipe(Effect.orElseSucceed(() => "")))
  const line = `${result.stdout}\n${result.stderr}`.split("\n").find((text) => text.startsWith(DUMP_MARK)) ?? ""
  expect(line).not.toBe("")
  return {
    exitCode: result.exitCode,
    passes: cases.find((test) => test.name === PASSES)?.status ?? "missing",
    dumped: cases.find((test) => test.name === DUMP_TITLE)?.status ?? "missing",
    dump: decodeDump(line.slice(DUMP_MARK.length)),
    events: nodeFs.readFileSync(path.join(tree, EVENTS), "utf8"),
  }
})

const spine = () => spineRows(nodeFs.readFileSync(path.join(ROOT, SPINE), "utf8"))

it.live(
  "[SV19] the spine's AD-17 table reads as the final allowlist: its rows, identifiers and files",
  () =>
    Effect.sync(() => {
      const rows = spine()
      // The table as the spine writes it: eight rows, the conditional mergeRetry row last.
      expect(rows.map((row) => [row.file, row.identifiers, row.conditional, row.literalMembers])).toEqual([
        ["packages/tui/src/task-ui/actor.ts", ["fromActor"], false, false],
        ["packages/tui/src/task-ui/store.ts", ["DISPLAY"], false, false],
        [
          "packages/opencode/src/task/core/status.ts",
          ["RunStateSchema", "TaskStateSchema", "ObligationStateSchema", "ScenarioStateSchema", "OutsideStateSchema"],
          false,
          false,
        ],
        ["packages/opencode/src/task/engine-xstate/machine.ts", ["DEAD", "CLASS"], false, false],
        ["packages/opencode/src/task/core/events.ts", ["FactSchema"], false, true],
        ["packages/opencode/src/task/proof/process.ts", ["appender"], false, false],
        ["packages/opencode/src/task/proof/process.ts", ["awaitGroupGone"], false, false],
        ["packages/opencode/src/task/core/workers.ts", ["mergeRetry"], true, false],
      ])
      for (const row of rows) expect(row.reason.length).toBeGreaterThan(20)
      // FactSchema's literal members outside its own initializer: the verdict and the result status.
      const schemas = factLiteralSchemas(nodeFs.readFileSync(path.join(ROOT, EVENTS), "utf8"))
      expect(schemas.map((item) => item.name)).toEqual(["Verdict", "Result_"])
      expect(schemas.flatMap((item) => item.members)).toEqual(
        expect.arrayContaining(["trusted", "rejected", "passed", "failed"]),
      )
    }),
  30_000,
)

it.live(
  "[SV19] at the end of phase 2 the audit passed, and its entries for the harness source equal the final entries for that tree",
  () =>
    Effect.gen(function* () {
      const rows = spine()
      const phase2 = yield* auditAt(PHASE2)
      // Given the end of phase 2: the audit of that commit passed on that commit's trees.
      expect({ exitCode: phase2.exitCode, passes: phase2.passes, dumped: phase2.dumped }).toEqual({
        exitCode: 0,
        passes: "passed",
        dumped: "passed",
      })
      const { allowlist, findings } = phase2.dump
      // When its allowlist is compared with the spine's final allowlist, then the entries for the harness source equal
      // the final entries for that tree.
      const harness = allowlist.filter((entry) => entry.file.startsWith(HARNESS))
      const final = finalKeys(rows, phase2.events, findings).filter((item) => item.startsWith(HARNESS))
      expect(sorted(harness.map(key))).toEqual(sorted(final))
      expect(harness.length).toBe(final.length)
      // None of them is interim, and each carries its reason.
      expect(harness.filter((entry) => entry.until !== undefined).map(key)).toEqual([])
      expect(harness.filter((entry) => entry.reason.trim() === "").map(key)).toEqual([])
      // The audit found nothing in the merge worker's file, so the conditional mergeRetry entry is not due.
      expect(findings.filter((finding) => finding.file.endsWith("core/workers.ts"))).toEqual([])
      // The rest of the phase-2 allowlist is the task-ui's interim entries, each naming the phase-4 task that removes it.
      const rest = allowlist.filter((entry) => !entry.file.startsWith(HARNESS))
      expect(rest.filter((entry) => !entry.file.startsWith(UI)).map(key)).toEqual([])
      expect(
        rest.filter((entry) => entry.until !== undefined).every((entry) => /^T4\.\d+$/.test(entry.until ?? "")),
      ).toBe(true)
      expect(rest.filter((entry) => entry.until !== undefined).length).toBeGreaterThan(0)
    }),
  150_000,
)

it.live(
  "[SV19] at the end of the goal the whole allowlist equals the spine's final allowlist and no interim entry remains",
  () =>
    Effect.gen(function* () {
      const rows = spine()
      const [now, phase2] = yield* Effect.all([auditAt(), auditAt(PHASE2)], { concurrency: 2 })
      // Given the end of the goal: the audit of the current tree passes on it.
      expect({ exitCode: now.exitCode, passes: now.passes, dumped: now.dumped }).toEqual({
        exitCode: 0,
        passes: "passed",
        dumped: "passed",
      })
      const { allowlist, findings } = now.dump
      // Then the whole allowlist equals the final allowlist.
      const final = finalKeys(rows, now.events, findings)
      expect(sorted(allowlist.map(key))).toEqual(sorted(final))
      expect(allowlist.length).toBe(final.length)
      // The audit finds exactly what the allowlist names: only allowlist entries, and no entry that matches nothing.
      expect(sorted(findings.map(key))).toEqual(sorted(allowlist.map(key)))
      // Each entry carries its written reason.
      expect(allowlist.filter((entry) => entry.reason.trim().length < 20).map(key)).toEqual([])
      // And no interim entry remains: none is marked interim, and none of phase 2's interim entries is left.
      expect(allowlist.filter((entry) => entry.until !== undefined).map(key)).toEqual([])
      const interim = phase2.dump.allowlist.filter((entry) => entry.until !== undefined).map(key)
      expect(interim.length).toBeGreaterThan(0)
      expect(allowlist.map(key).filter((item) => interim.includes(item))).toEqual([])
    }),
  150_000,
)
