import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Duration, Effect } from "effect"
import { readFileSync } from "node:fs"
import path from "path"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { delegate } from "./lib/delegate"
import { facts, loadPlan, observed, trustLeaf } from "./lib/machine"

// Scenario RM4 (spec task-harness-feedback, owner ruling 2, spine AD-6; task T1.7): every old engine test is
// ported, re-baselined or retired with its reason.
//
//   Given the engine test file after the rewrite
//   When its header list is read
//   Then every test of the old file appears once as ported, re-baselined or retired
//   And each re-baselined test names the decision or owner ruling that changed it
//   And each retired test names the guard that replaces it
//   And every listed test runs as a fact sequence through initial, apply and the selectors
//
// The old file is `packages/opencode/test/task/engine-xstate.test.ts` before the change: git b517ebb3f3^ (before T1.6
// replaced the engine). Its 29 tests, 27 under `XStateEngine` and 2 under "the base of an unfinished run", are listed
// below in file order, as `git show b517ebb3f3^:packages/opencode/test/task/engine-xstate.test.ts` gives them (the
// same 29 titles stand at 403a06028c^, the commit before the rewrite). The header list and the test bodies are read
// from the new file; the listed tests are then run through the project's `delegate` helper (a nested `bun test`).

const it = testEffect(NodeServices.layer)

const FILE = path.resolve(import.meta.dir, "engine-xstate.test.ts")
const RELATIVE = "./test/task/engine-xstate.test.ts"
const PACKAGE = path.resolve(import.meta.dir, "../..")

const OLD: ReadonlyArray<readonly [string, string]> = [
  ["1", "is named xstate"],
  ["2", "the initial state: tasks waiting, obligations pending, scenarios waiting"],
  ["3", "the happy leaf path: waiting, building, proving, verifying, trusted with attempts 1"],
  ["4", "a failed proof returns the task to the builder with the failed ids and reasons"],
  ["5", "the proof's own reason (a structural failure) is part of the task reason"],
  ["6", "budget exhaustion at the budget ends the task and the run"],
  ["7", "a rejection reopens only the rejected id; the others stay trusted"],
  ["8", "a verifier round that leaves an obligation unjudged also returns the task"],
  ["9", "a rejection at the budget exhausts it"],
  ["10", "a stall keeps the task building with its attempts and records the reason"],
  ["11", "a repetition returns the task to the builder with attempts + 1, and exhausts the budget"],
  ["12", "needs_human ends an active task and the run"],
  ["13", "task.failed fails the task and the run"],
  ["14", "cancel moves every building, proving or verifying task to cancelled, and the run"],
  ["15", "a stale obligation reopens its trusted task; a later round trusts it again"],
  ["16", "a failed result reopens a trusted obligation with its reason; a needs-judge result leaves it trusted"],
  ["17", "a parent is reviewed once: trusted with attempts 1, or failed and never rebuilt"],
  ["18", "scenarios: proved passed then verified; a failed proof or a rejection ends the scenario"],
  ["19", "run facts: started, resumed, outside trust and the end"],
  ["20", "a fact that matches no row changes nothing and adds no history"],
  ["21", "facts after the run ended change nothing"],
  ["22", "apply is pure: it never changes the state it receives"],
  ["23", "a parent's stale review obligation reopens it once; the new review trusts it (attempts 1) or fails it"],
  ["24", "task.failed fails a waiting leaf, a waiting parent and a verifying leaf, and the run with it"],
  [
    "25",
    "obligation.stale on an obligation that is neither passed nor trusted changes nothing, its trusted task included",
  ],
  ["26", "obligation.stale moves an obligation whose task the state does not hold"],
  ["27", "a unit in a state its lifecycle does not name takes no fact, and no such state makes apply throw"],
  ["B1", "is the branch its run.started recorded, until the run ends"],
  ["B2", "is unknown for a run stored before the base was recorded"],
]

// The describe block of B1 and B2 in the old file: the header names them with it, as `<describe>: <title>`.
const BASE = "the base of an unfinished run"
const listed = (id: string, title: string) => (id.startsWith("B") ? `${BASE}: ${title}` : title)

const CLASSES = ["ported", "re-baselined", "retired"] as const
type Class = (typeof CLASSES)[number]

interface Entry {
  readonly id: string
  readonly title: string
  readonly kind: Class
  readonly reason: string
}

const source = () => readFileSync(FILE, "utf8")

// The header list: the comment lines before the first statement after the imports, read as entries
// `<id> "<old title>" — <class><reason>`; an entry's continuation lines are joined to it with one space.
const headerOf = (text: string): ReadonlyArray<Entry> => {
  const lines = text.split("\n")
  const end = lines.findIndex((line) => line.startsWith("const "))
  const comments = lines
    .slice(0, end)
    .filter((line) => line.startsWith("//"))
    .map((line) => line.replace(/^\/\/\s?/, ""))
  const starts = comments.flatMap((line, index) => (/^\s*(\d+|B\d+) "/.test(line) ? [index] : []))
  return starts.map((start, at) => {
    const stop = starts[at + 1] ?? comments.findIndex((line, index) => index > start && line.trim() === "")
    const joined = comments
      .slice(start, stop < 0 ? comments.length : stop)
      .map((line) => line.trim())
      .join(" ")
    const match = /^(\d+|B\d+) "(.+?)" — (ported|re-baselined|retired)(.*)$/.exec(joined)
    if (match === null) throw new Error(`a header entry does not parse: ${joined}`)
    const [, id = "", title = "", kind = "ported", reason = ""] = match
    const known = CLASSES.find((name) => name === kind)
    if (known === undefined) throw new Error(`entry ${id}: unknown class ${kind}`)
    return { id, title, kind: known, reason: reason.trim() }
  })
}

// Each test of the new file: its title and its body (up to the next test, `describe` or the describe's end).
const testsOf = (text: string) => {
  const lines = text.split("\n")
  const starts = lines.flatMap((line, index) => {
    const match = /^\s*(?:test|it\.live|it\.effect)\(\s*"([^"]+)"/.exec(line)
    return match === null ? [] : [{ index, title: match[1] ?? "" }]
  })
  return starts.map(({ index, title }, at) => {
    const next = starts[at + 1]?.index ?? lines.length
    const close = lines.findIndex((line, row) => row > index && row < next && /^(describe\(|\}\))/.test(line))
    return { title, body: lines.slice(index, close < 0 ? next : close).join("\n") }
  })
}

const testFor = (text: string, id: string) => {
  const found = testsOf(text).filter((test) => test.title.startsWith(`${id} `))
  if (found.length !== 1) throw new Error(`test ${id}: ${found.length} tests start with its id`)
  const [test] = found
  if (test === undefined) throw new Error(`test ${id}: none`)
  return test
}

// The decision or ruling names a reason gives in its leading parenthesis: D<n>, AD-<n>, owner ruling <n>, or a
// prepare-goal default the spec numbers ("default 4", spec.md "Prepare-goal defaults").
const namesIn = (text: string) => {
  const head = /^\(([^)]*)\)/.exec(text.trim())?.[1] ?? ""
  return [...head.matchAll(/\b(D\d{1,2}|AD-\d{1,2}|owner ruling \d|default \d)\b/g)].map((match) => match[1] ?? "")
}
const KNOWN = (name: string) =>
  /^D([1-9]|1\d|2[0-7])$/.test(name) ||
  /^AD-([1-9]|1\d|20)$/.test(name) ||
  /^owner ruling [1-6]$/.test(name) ||
  /^default [4-6]$/.test(name)

it.live("[RM4] every test of the old file appears once in the header list as ported, re-baselined or retired", () =>
  Effect.gen(function* () {
    const header = headerOf(source())
    expect(header.map((entry) => entry.id)).toEqual(OLD.map(([id]) => id))
    for (const [id, title] of OLD) {
      const entries = header.filter((entry) => entry.title === listed(id, title))
      expect({ id, entries: entries.map((entry) => entry.id) }).toEqual({ id, entries: [id] })
    }
    expect(new Set(header.map((entry) => entry.title)).size).toBe(OLD.length)
    for (const entry of header) expect(CLASSES).toContain(entry.kind)
    // The spec's classification (tasks.md T1.7): the stop-at-once tests and the waiting-on-cancel test are
    // re-baselined, the three hand-built State tests are retired.
    const ids = (kind: Class) => header.filter((entry) => entry.kind === kind).map((entry) => entry.id)
    for (const id of ["6", "9", "11", "12", "13", "14", "17", "21", "23", "24"])
      expect(ids("re-baselined")).toContain(id)
    expect(ids("retired")).toEqual(["25", "26", "27"])
    expect(ids("ported").length + ids("re-baselined").length + ids("retired").length).toBe(29)
    // Every entry has its test in the new file, titled with its id and its class.
    const text = source()
    for (const entry of header) expect(testFor(text, entry.id).title.startsWith(`${entry.id} ${entry.kind}`)).toBe(true)
    // A ported test keeps its old title after the class (22 says "snapshot" where the State is gone).
    for (const entry of header.filter((each) => each.kind === "ported")) {
      const title = testFor(text, entry.id).title.slice(`${entry.id} ported: `.length)
      const old = OLD.find(([id]) => id === entry.id)?.[1]
      expect(title.replace("the snapshot it receives", "the state it receives")).toBe(old ?? "no old title")
    }
  }),
)

it.live("[RM4] each re-baselined test names the decision or owner ruling that changed it", () =>
  Effect.gen(function* () {
    const text = source()
    const rebaselined = headerOf(text).filter((entry) => entry.kind === "re-baselined")
    expect(rebaselined.length).toBeGreaterThanOrEqual(10)
    for (const entry of rebaselined) {
      // The header names the decisions, then says what changed.
      const names = namesIn(entry.reason)
      expect({ id: entry.id, named: names.length > 0 }).toEqual({ id: entry.id, named: true })
      for (const name of names)
        expect({ id: entry.id, name, known: KNOWN(name) }).toEqual({ id: entry.id, name, known: true })
      const said = entry.reason.replace(/\b(D\d{1,2}|AD-\d{1,2}|owner ruling \d|default \d)\b/g, "")
      expect({ id: entry.id, says: said.replace(/[():,;\s]/g, "").length > 10 }).toEqual({ id: entry.id, says: true })
      // The new test's title names the same decisions (tasks.md T1.7: each names D3 or default 4 in its title).
      const title = testFor(text, entry.id).title
      expect(title.startsWith(`${entry.id} re-baselined (`)).toBe(true)
      for (const name of names)
        expect({ id: entry.id, name, inTitle: title.includes(name) }).toEqual({
          id: entry.id,
          name,
          inTitle: true,
        })
    }
    // The stop-at-once tests name D3; the waiting-on-cancel test names default 4.
    for (const id of ["6", "9", "11", "12", "13", "21", "24"])
      expect(namesIn(rebaselined.find((entry) => entry.id === id)?.reason ?? "")).toContain("D3")
    expect(namesIn(rebaselined.find((entry) => entry.id === "14")?.reason ?? "")).toContain("default 4")
    // Control: the name reader takes only the leading parenthesis, and refuses a name no input defines.
    expect(namesIn("(D3, AD-4: run.ended is a stop)")).toEqual(["D3", "AD-4"])
    expect(namesIn("the run waits (D3)")).toEqual([])
    expect(KNOWN("D28")).toBe(false)
    expect(KNOWN("owner ruling 9")).toBe(false)
  }),
)

it.live("[RM4] each retired test names the guard that replaces it, and that guard holds", () =>
  Effect.gen(function* () {
    const text = source()
    const retired = headerOf(text).filter((entry) => entry.kind === "retired")
    const guards = retired.map((entry) => {
      // Why its input cannot be built any more, then `Replaced by "<guard>"`.
      const match = /^:\s*(.+?)\s+Replaced by "([^"]+)"/.exec(entry.reason)
      if (match === null) throw new Error(`retired ${entry.id} names no replacing guard: ${entry.reason}`)
      const [, why = "", guard = ""] = match
      expect(why.length).toBeGreaterThan(10)
      expect(testFor(text, entry.id).title.startsWith(`${entry.id} retired, replaced by: ${guard}`)).toBe(true)
      return [entry.id, guard] as const
    })
    expect(guards).toEqual([
      ["25", "a fact that moves nothing returns the identical snapshot"],
      ["26", "an unknown id returns the identical snapshot"],
      ["27", "a foreign snapshot dies"],
    ])

    // Each named guard holds on the real engine and the release-notes plan.
    const engine = TaskEngineXState
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    const running = [f.runStarted(), ...trustLeaf(plan, f, "T1.1")].reduce(
      (snapshot, fact) => engine.apply(plan, snapshot, fact),
      engine.initial(plan),
    )
    expect(engine.apply(plan, running, f.ready("T1.2"))).toBe(running)
    for (const fact of [f.stale("T7.c1"), f.started("T7"), f.scenarioProved("S99", "passed")])
      expect(engine.apply(plan, running, fact)).toBe(running)
    const other = yield* loadPlan("example-cascade.spec")
    expect(() => engine.apply(plan, engine.initial(other), f.runStarted())).toThrow(/another plan/)
  }),
)

it.live(
  "[RM4] every listed test runs as a fact sequence through initial, apply and the selectors",
  () =>
    Effect.gen(function* () {
      const text = source()
      const engine = TaskEngineXState

      // The file reaches the engine only through its API: no machine module, no port import, no hand-built State.
      const imports = text.split("\n").filter((line) => line.startsWith("import "))
      expect(imports.some((line) => line.includes("@/task/engine-xstate/machine"))).toBe(false)
      expect(imports.some((line) => line.includes("@jambudipa/xstate-effect"))).toBe(false)
      expect(imports.some((line) => line.includes('from "@/task/engine-xstate"'))).toBe(true)
      // Its fold helpers fold facts from `initial` through `apply`; its obligation reader is `view`; its history
      // reader reads the log that `view` gives as `history`.
      expect(text).toMatch(
        /const fold = \(list: ReadonlyArray<Fact>, from: RunSnapshot = engine\.initial\(plan\)\) =>\s*\n\s*list\.reduce\(\(snapshot, fact\) => engine\.apply\(plan, snapshot, fact\), from\)/,
      )
      expect(text).toMatch(
        /const foldOf = \(other: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine\.initial\(other\)\) =>\s*\n\s*list\.reduce\(\(snapshot, fact\) => engine\.apply\(other, snapshot, fact\), from\)/,
      )
      expect(text).toMatch(
        /const obligationStates = \(snapshot: RunSnapshot, task: string\) =>[\s\S]{0,80}engine\.view\(snapshot\)/,
      )
      expect(text).toMatch(
        /const entriesOf = \(snapshot: RunSnapshot, unit: string\) => snapshot\.context\.log\.filter/,
      )
      const plan = yield* loadPlan("release-notes.spec")
      const folded = observed(plan).reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), engine.initial(plan))
      expect(engine.view(folded).history).toBe(folded.context.log)

      // Each listed test: no machine internal and no hand-built snapshot or State; its snapshots come from a fold of
      // facts through `initial` and `apply` (the helpers above, or the command's slice fold for B1 and B2); it reads
      // them through `view`, a selector, or the identity or defect of `apply`'s result. Its other reads are only the
      // history (`context.log`, the `view` history), a phase tag (`hasTag`) and, for the purity test, the context.
      const FORBIDDEN = [
        /\bTaskMachine\b/,
        /(?<![\w.])transition\(/,
        /\binitialTransition\(/,
        /\bcreateMachine\(/,
        /\bcreateActor\(/,
        /\bgetPersistedSnapshot\b/,
        /\bas (RunSnapshot|State)\b/,
        /:\s*State\b/,
        /\.context\.(units|moves|stop|warning)\b/,
        /\.value\b/,
      ]
      const FOLDS = /(?<![\w.])fold\(|\bfoldOf\(|engine\.apply\(|engine\.initial\(|\bbaseOf\(/
      const READS =
        /engine\.(view|unitState|tags|waitingOn|blockedBy|ended)\(|\bobligationStates\(|engine\.apply\(|\bbaseOf\(/
      const DIRECT = [
        ["history", /\.context\.log\b|\bentriesOf\(/],
        ["phase tag", /\.hasTag\(/],
        ["context", /\.context\b(?!\.log)/],
      ] as const
      const direct: Record<string, Array<string>> = {}
      for (const [id] of OLD) {
        const { title, body } = testFor(text, id)
        for (const pattern of FORBIDDEN)
          expect({ id, pattern: String(pattern), found: pattern.test(body) }).toEqual({
            id,
            pattern: String(pattern),
            found: false,
          })
        for (const [name, pattern] of DIRECT) if (pattern.test(body)) (direct[name] ??= []).push(id)
        if (id === "1") {
          // The name test reads no run state: it reads the engine's name, as the old test did.
          expect(body).toContain('expect(engine.XStateEngine.name).toBe("xstate")')
          continue
        }
        expect({ id, title, folds: FOLDS.test(body) }).toEqual({ id, title, folds: true })
        expect({ id, title, reads: READS.test(body) }).toEqual({ id, title, reads: true })
      }
      // Only the purity test reads the context as a whole (to show `apply` leaves it unchanged).
      expect(direct.context ?? []).toEqual(["22"])
      // B1 and B2 fold through the command's slice reader, which folds with this engine's `initial` and `apply`.
      const command = readFileSync(path.resolve(PACKAGE, "src/task/core/command.ts"), "utf8")
      expect(command).toMatch(/TaskEvents\.fold\(TaskEngineXState\.XStateEngine, plan, facts\)/)
      expect(text).toMatch(
        /const baseOf = \(facts: ReadonlyArray<Fact>\) =>\s*\n\s*TaskCommand\.unfinishedBase\(Effect\.runSync\(TaskCommand\.sliceOf\(plan, facts, plan\.specPath\)\)\)/,
      )

      // And they run: the 29 listed tests, run by a nested `bun test` of the file, all pass.
      const report = yield* delegate(
        PACKAGE,
        RELATIVE,
        "^(XStateEngine|the base of an unfinished run) ",
        Duration.seconds(110),
      )
      for (const [id] of OLD) {
        const { title } = testFor(text, id)
        expect({ id, passed: report.passed.filter((full) => full.endsWith(` > ${title}`)).length }).toEqual({
          id,
          passed: 1,
        })
      }
      expect(report.passed).toHaveLength(OLD.length)
    }),
  150_000,
)
