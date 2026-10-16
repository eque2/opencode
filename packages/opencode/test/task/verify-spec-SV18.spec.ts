import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Duration, Effect, FileSystem } from "effect"
import nodeFs from "fs"
import path from "path"
import { Junit } from "@/task/proof/junit"
import { ProofProcess } from "@/task/proof/process"
import { testEffect } from "../lib/effect"

// Scenario SV18 (spec task-harness-feedback, D9, AD-16, AD-17; tasks T2.1, T2.13, T4.13): the state audit fails on
// state held outside xstate.
//
//   Given a source tree with one planted Ref, MutableHashMap, SynchronizedRef, FiberMap, setInterval, polled loop,
//     module-level mutable let or list of lifecycle states
//   When the audit runs
//   Then it fails and names the file and the identifier
//   And in the task-ui it also fails on a planted Effect.sleep or Schedule
//   And on the real tree it passes with only allowlist entries, each with its written reason
//
// The audit is the D9 audit itself, `test/task/state-audit.test.ts`: it scans every `.ts`/`.tsx` file under
// `packages/opencode/src/task/` and `packages/tui/src/task-ui/` from the repository root it finds beside it, and its test
// "passes on the current tree with the allowlist" fails on a finding that no allowlist entry covers, on an entry with
// no reason and on an entry that matches nothing. It exports nothing, so this test runs it as it is: for each planted
// construct, the two audited trees and the audit file are copied byte for byte into a scoped temporary tree (with this
// tree's node_modules linked in), one planted file is added, and the copied audit runs in a nested `bun test`. The
// failure must name the planted file and the identifier, and nothing else. Controls: the same copy with no plant
// passes, and an Effect.sleep or a Schedule planted in the harness tree (outside the task-ui) passes. On the real tree,
// the audit file runs in place and passes; a copy in which one allowlist entry's reason is blank fails and names it.

const it = testEffect(NodeServices.layer)

const ROOT = path.resolve(import.meta.dir, "../../../..")
const AUDIT = "packages/opencode/test/task/state-audit.test.ts"
const TREES = ["packages/opencode/src/task", "packages/tui/src/task-ui"]
const PASSES = "passes on the current tree with the allowlist"
const HARNESS_FILE = "packages/opencode/src/task/core/planted.ts"
const UI_FILE = "packages/tui/src/task-ui/planted.ts"

interface Plant {
  readonly construct: string
  readonly file: string
  readonly text: string
  /** The identifier the audit must name; none for a control that must pass. */
  readonly identifier?: string
}

// One construct each, as a harness source file would hold it.
const HARNESS: ReadonlyArray<Plant> = [
  {
    construct: "Ref",
    file: HARNESS_FILE,
    identifier: "attempts",
    text: [
      'import { Effect, Ref } from "effect"',
      "",
      "export const counter = Effect.gen(function* () {",
      "  const attempts = yield* Ref.make(0)",
      "  return attempts",
      "})",
    ].join("\n"),
  },
  {
    construct: "MutableHashMap",
    file: HARNESS_FILE,
    identifier: "owners",
    text: [
      'import { MutableHashMap } from "effect"',
      "",
      "export const owners = MutableHashMap.empty<string, string>()",
    ].join("\n"),
  },
  {
    construct: "SynchronizedRef",
    file: HARNESS_FILE,
    identifier: "phase",
    text: [
      'import { Effect, SynchronizedRef } from "effect"',
      "",
      "export const make = Effect.gen(function* () {",
      '  const phase = yield* SynchronizedRef.make("building")',
      "  return phase",
      "})",
    ].join("\n"),
  },
  {
    construct: "FiberMap",
    file: HARNESS_FILE,
    identifier: "workers",
    text: [
      'import { Effect, FiberMap } from "effect"',
      "",
      "export const make = Effect.gen(function* () {",
      "  const workers = yield* FiberMap.make<string>()",
      "  return workers",
      "})",
    ].join("\n"),
  },
  {
    construct: "setInterval",
    file: HARNESS_FILE,
    identifier: "heartbeat",
    text: "export const heartbeat = setInterval(() => undefined, 5_000)",
  },
  {
    construct: "polled loop",
    file: HARNESS_FILE,
    identifier: "untilDone",
    text: [
      'import { Effect } from "effect"',
      "",
      "export const untilDone = (done: Effect.Effect<boolean>) =>",
      "  Effect.gen(function* () {",
      '    while (!(yield* done)) yield* Effect.sleep("1 second")',
      "  })",
    ].join("\n"),
  },
  {
    construct: "module-level mutable let",
    file: HARNESS_FILE,
    identifier: "nudges",
    text: ["export let nudges = 0", "", "export const nudge = () => {", "  nudges += 1", "}"].join("\n"),
  },
  {
    construct: "list of lifecycle states",
    file: HARNESS_FILE,
    identifier: "LIVE",
    text: [
      'export const LIVE = ["building", "proving", "verifying"]',
      "",
      "export const isLive = (state: string) => LIVE.includes(state)",
    ].join("\n"),
  },
]

const UI: ReadonlyArray<Plant> = [
  {
    construct: "Effect.sleep in the task-ui",
    file: UI_FILE,
    identifier: "pause",
    text: ['import { Effect } from "effect"', "", 'export const pause = Effect.sleep("1 second")'].join("\n"),
  },
  {
    construct: "Schedule in the task-ui",
    file: UI_FILE,
    identifier: "every",
    text: ['import { Schedule } from "effect"', "", "export const every = Schedule.recurs(3)"].join("\n"),
  },
]

// The same Effect.sleep and Schedule outside the task-ui: the task-ui rule does not apply there.
const OUTSIDE_UI: ReadonlyArray<Plant> = [
  { ...UI[0], construct: "Effect.sleep outside the task-ui", file: HARNESS_FILE, identifier: undefined },
  { ...UI[1], construct: "Schedule outside the task-ui", file: HARNESS_FILE, identifier: undefined },
]

/** How one audit run ended: its exit code, its output, and the status of the audit's "passes" test. */
interface Outcome {
  readonly exitCode: number
  readonly output: string
  readonly status: string
  /** Every finding the failure lists, as `file:line identifier (rule)`. */
  readonly findings: ReadonlyArray<{ readonly file: string; readonly identifier: string; readonly rule: string }>
  /** Every allowlist key the failure lists as `file identifier`. */
  readonly keys: ReadonlyArray<string>
}

const FINDING = /"(packages\/[^":]+):(\d+) (\S+) \(([^)]+)\)"/g
const KEY = /"(packages\/\S+\.tsx?) (\S+)"/g

// Runs the audit file at `cwd/<relative>` with `bun test -t PASSES`, and reads its JUnit report and output.
const runAudit = Effect.fnUntraced(function* (cwd: string, file: string) {
  const fs = yield* FileSystem.FileSystem
  const report = path.join(yield* fs.makeTempDirectoryScoped(), "junit.xml")
  const result = yield* ProofProcess.run(
    process.execPath,
    ["test", "--timeout", "30000", file, "-t", PASSES, "--reporter=junit", `--reporter-outfile=${report}`],
    { cwd, timeout: Duration.seconds(100), cancelDeadline: Duration.seconds(5) },
  )
  expect(result.timedOut).toBe(false)
  const cases = Junit.parse(yield* fs.readFileString(report).pipe(Effect.orElseSucceed(() => "")))
  const output = `${result.stdout}\n${result.stderr}`
  return {
    exitCode: result.exitCode,
    output,
    status: cases.find((test) => test.name === PASSES)?.status ?? "missing",
    findings: [...output.matchAll(FINDING)].map((match) => ({
      file: match[1] ?? "",
      identifier: match[3] ?? "",
      rule: match[4] ?? "",
    })),
    keys: [...output.matchAll(KEY)].map((match) => `${match[1]} ${match[2]}`),
  } satisfies Outcome
})

// A copy of the audited trees and the audit file in a scoped temporary tree, with `edit` applied to the audit text and
// `plant` added; then the copied audit's run.
const auditCopy = Effect.fnUntraced(function* (plant?: Plant, edit: (audit: string) => string = (text) => text) {
  const fs = yield* FileSystem.FileSystem
  const tree = yield* fs.makeTempDirectoryScoped()
  for (const folder of TREES) nodeFs.cpSync(path.join(ROOT, folder), path.join(tree, folder), { recursive: true })
  nodeFs.mkdirSync(path.join(tree, path.dirname(AUDIT)), { recursive: true })
  nodeFs.writeFileSync(path.join(tree, AUDIT), edit(nodeFs.readFileSync(path.join(ROOT, AUDIT), "utf8")))
  nodeFs.symlinkSync(path.join(ROOT, "node_modules"), path.join(tree, "node_modules"))
  if (plant !== undefined) {
    expect(nodeFs.existsSync(path.join(tree, plant.file))).toBe(false)
    nodeFs.writeFileSync(path.join(tree, plant.file), `${plant.text}\n`)
  }
  return yield* runAudit(path.join(tree, "packages/opencode"), `./${path.relative("packages/opencode", AUDIT)}`)
})

// The audit failed, and its failure names the planted file and identifier and no other finding.
const expectNamed = (plant: Plant, outcome: Outcome) => {
  expect({ construct: plant.construct, exitCode: outcome.exitCode === 0, status: outcome.status }).toEqual({
    construct: plant.construct,
    exitCode: false,
    status: "failed",
  })
  expect({ construct: plant.construct, named: outcome.findings.map((item) => [item.file, item.identifier]) }).toEqual({
    construct: plant.construct,
    named: expect.arrayContaining([[plant.file, plant.identifier]]),
  })
  expect({ construct: plant.construct, others: outcome.findings.filter((item) => item.file !== plant.file) }).toEqual({
    construct: plant.construct,
    others: [],
  })
}

const expectPassed = (construct: string, outcome: Outcome) =>
  expect({ construct, exitCode: outcome.exitCode, status: outcome.status, findings: outcome.findings }).toEqual({
    construct,
    exitCode: 0,
    status: "passed",
    findings: [],
  })

it.live(
  "[SV18] the audit fails on a planted Ref, MutableHashMap, SynchronizedRef, FiberMap, setInterval, polled loop, module-level let or list of states, and names the file and the identifier",
  () =>
    Effect.gen(function* () {
      // The control: the copied tree with no plant passes, so a failure below comes from the plant alone.
      expectPassed("no plant", yield* auditCopy())
      // Given a source tree with one planted construct, when the audit runs, then it fails and names it.
      const outcomes = yield* Effect.forEach(HARNESS, (plant) => auditCopy(plant), { concurrency: 4 })
      for (const [index, plant] of HARNESS.entries()) expectNamed(plant, outcomes[index])
      // The rules that named each construct.
      const rules = outcomes.map((outcome, index) => [
        HARNESS[index].construct,
        outcome.findings.filter((item) => item.file === HARNESS_FILE).map((item) => item.rule),
      ])
      expect(Object.fromEntries(rules)).toMatchObject({
        Ref: ["Ref.make"],
        MutableHashMap: ["MutableHashMap.empty"],
        SynchronizedRef: ["SynchronizedRef.make"],
        FiberMap: expect.arrayContaining(["FiberMap"]),
        setInterval: ["setInterval"],
        "polled loop": ["sleep in a loop"],
        "module-level mutable let": ["module-level let"],
      })
    }),
  150_000,
)

it.live(
  "[SV18] in the task-ui the audit also fails on a planted Effect.sleep or Schedule, and names the file and the identifier; outside the task-ui the same code passes",
  () =>
    Effect.gen(function* () {
      const outcomes = yield* Effect.forEach(UI, (plant) => auditCopy(plant), { concurrency: 2 })
      for (const [index, plant] of UI.entries()) expectNamed(plant, outcomes[index])
      expect(outcomes.map((outcome) => outcome.findings.map((item) => item.rule))).toEqual([
        ["Effect.sleep"],
        ["Schedule.recurs"],
      ])
      const controls = yield* Effect.forEach(OUTSIDE_UI, (plant) => auditCopy(plant), { concurrency: 2 })
      for (const [index, plant] of OUTSIDE_UI.entries()) expectPassed(plant.construct, controls[index])
    }),
  150_000,
)

it.live(
  "[SV18] on the real tree the audit passes with only allowlist entries, and an entry without its written reason fails",
  () =>
    Effect.gen(function* () {
      // The audit file in place, over the real trees.
      expectPassed("the real tree", yield* runAudit(path.join(ROOT, path.dirname(AUDIT)), "./state-audit.test.ts"))
      // The same audit with the reason of the DISPLAY entry blanked fails and names the entry: a pass means every
      // entry carries its written reason.
      const blank = yield* auditCopy(undefined, (text) => {
        const reason =
          '"The state-to-glyph, tone and Gantt block lookup: presentation only; every classification reads the tags."'
        expect(text.includes(reason)).toBe(true)
        return text.replace(reason, '" "')
      })
      expect({ exitCode: blank.exitCode === 0, status: blank.status, findings: blank.findings }).toEqual({
        exitCode: false,
        status: "failed",
        findings: [],
      })
      expect(blank.keys).toEqual(["packages/tui/src/task-ui/store.ts DISPLAY"])
    }),
  150_000,
)
