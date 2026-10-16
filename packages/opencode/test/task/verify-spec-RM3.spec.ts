import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "path"
import { TaskEvents } from "@/task/core/events"
import * as EngineModule from "@/task/engine-xstate"
import * as AlphabetModule from "@/task/engine-xstate/alphabet"
import * as MachineModule from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, observed } from "./lib/machine"

// Scenario RM3 (spec task-harness-feedback, spine AD-6, D1; task T1.6): the per-unit machines and the fold code that
// joined them are gone.
//
//   Given the engine module after the change
//   When its exports and definitions are inspected
//   Then no obligation, task, scenario or run machine exists beside the generated machine
//   And no stepTask, stepRun, cancel, staleAlone or follows code exists
//   And XStateEngine keeps its name and its initial and apply members over an opaque snapshot
//
// The engine module is `src/task/engine-xstate/` (index.ts, machine.ts, alphabet.ts) and its fold entry
// `core/events.ts` `fold`. The test reads the modules' runtime exports and their source with comments removed. The
// names come from the module before the change (git b517ebb3f3^, `engine-xstate/index.ts`): it defined
// `obligationMachine`, `taskMachine`, `scenarioMachine` and `runMachine` with `setup(...).createMachine`, and the fold
// code `stepObligation`, `stepTask`, `stepScenario`, `stepRun`, `runSnapshot`, `cancel`, `staleAlone` and `follows`.

const it = testEffect(NodeServices.layer)

const SRC = path.resolve(import.meta.dir, "../../src")
const ENGINE_DIR = path.join(SRC, "task/engine-xstate")
const EVENTS = path.join(SRC, "task/core/events.ts")

const OLD_MACHINES = ["obligationMachine", "taskMachine", "scenarioMachine", "runMachine"]
const OLD_FOLD = ["stepTask", "stepRun", "cancel", "staleAlone", "follows"]
const OLD_HELPERS = ["stepObligation", "stepScenario", "runSnapshot"]

// Source text with every comment replaced by spaces; strings, template literals and code stay as they are.
const withoutComments = (source: string) => {
  let out = ""
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index)
      const stop = end < 0 ? source.length : end
      out += " ".repeat(stop - index)
      index = stop
      continue
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2)
      const stop = end < 0 ? source.length : end + 2
      out += source.slice(index, stop).replace(/[^\n]/g, " ")
      index = stop
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      let at = index + 1
      while (at < source.length && source[at] !== char) at += source[at] === "\\" ? 2 : 1
      out += source.slice(index, at + 1)
      index = at + 1
      continue
    }
    out += char
    index += 1
  }
  return out
}

const filesUnder = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return filesUnder(full)
    return /\.(ts|tsx)$/.test(name) ? [full] : []
  })

const code = (file: string) => withoutComments(readFileSync(file, "utf8"))

// Every place a name is an identifier in code: `<file>:<line> <name>`.
const tokens = (files: ReadonlyArray<string>, names: ReadonlyArray<string>) =>
  files.flatMap((file) =>
    code(file)
      .split("\n")
      .flatMap((line, at) =>
        names
          .filter((name) => new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(line))
          .map((name) => `${path.relative(SRC, file)}:${at + 1} ${name}`),
      ),
  )

// Every machine construction in a source text: a `createMachine(` call or a `setup(` call, by line number.
const constructionsIn = (text: string) =>
  withoutComments(text)
    .split("\n")
    .flatMap((line, at) => (/(?<![\w$])(createMachine|setup)\s*\(/.test(line) ? [at + 1] : []))

const constructions = (files: ReadonlyArray<string>) =>
  files.flatMap((file) =>
    constructionsIn(readFileSync(file, "utf8")).map((line) => `${path.relative(SRC, file)}:${line}`),
  )

// A built xstate machine, read structurally.
const isMachine = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  "root" in value &&
  "getInitialSnapshot" in value &&
  typeof value.getInitialSnapshot === "function"

const engineFiles = () => [...filesUnder(ENGINE_DIR), EVENTS]

it.live("[RM3] the engine module's exports hold no obligation, task, scenario or run machine", () =>
  Effect.gen(function* () {
    const modules = { index: EngineModule, machine: MachineModule, alphabet: AlphabetModule, events: TaskEvents }
    for (const [name, module] of Object.entries(modules)) {
      const exported = Object.keys(module)
      expect(exported.length).toBeGreaterThan(0)
      for (const old of [...OLD_MACHINES, ...OLD_FOLD, ...OLD_HELPERS])
        expect({ module: name, old, exported: exported.includes(old) }).toEqual({ module: name, old, exported: false })
      // No exported value is a machine: a machine exists only as the result of `machine(plan)`.
      const machines = Object.entries(module)
        .filter(([, value]) => isMachine(value))
        .map(([key]) => key)
      expect({ module: name, machines }).toEqual({ module: name, machines: [] })
    }
    // The generated machine is the one machine: what `machine(plan)` returns, the one the engine's snapshots belong to.
    const plan = yield* loadPlan("release-notes.spec")
    const machine = MachineModule.machine(plan)
    expect(isMachine(machine)).toBe(true)
    expect(EngineModule.initial(plan).machine).toBe(machine)
    // Its snapshot holds no child actor: no per-unit machine runs under it, before or after the observed facts.
    expect(Object.keys(EngineModule.initial(plan).children)).toEqual([])
    const folded = TaskEvents.fold(EngineModule.XStateEngine, plan, observed(plan))
    expect(folded.machine).toBe(machine)
    expect(Object.keys(folded.children)).toEqual([])
  }),
)

it.live("[RM3] no obligation, task, scenario or run machine is defined beside the generated machine", () =>
  Effect.gen(function* () {
    const files = engineFiles()
    expect(files.map((file) => path.relative(SRC, file)).toSorted()).toEqual(
      [
        "task/core/events.ts",
        "task/engine-xstate/alphabet.ts",
        "task/engine-xstate/index.ts",
        "task/engine-xstate/machine.ts",
      ].toSorted(),
    )
    // The engine module builds one machine: `createMachine` in `fromConfig`, which `machine(plan)` calls. No `setup`.
    const built = constructions(files)
    expect(built).toHaveLength(1)
    const machineSource = code(path.join(ENGINE_DIR, "machine.ts"))
    const [where] = built
    const line = Number(where?.split(":")[1])
    expect(machineSource.split("\n")[line - 1]).toContain("createMachine(check(plan, built)")
    expect(machineSource).toMatch(
      /export const fromConfig = \(plan: Plan, built: RunConfig\) =>\s*\n\s*createMachine\(/,
    )
    expect(machineSource).toMatch(/const made = fromConfig\(plan, config\(plan\)\)/)
    // None of the four machine names is an identifier anywhere in the engine module or the rest of `src`.
    expect(tokens(files, OLD_MACHINES)).toEqual([])
    expect(tokens(filesUnder(SRC), OLD_MACHINES)).toEqual([])
  }),
)

it.live("[RM3] no stepTask, stepRun, cancel, staleAlone or follows code exists", () =>
  Effect.gen(function* () {
    // In the engine module, none of the fold code's names is an identifier, nor are its other step helpers.
    expect(tokens(engineFiles(), [...OLD_FOLD, ...OLD_HELPERS])).toEqual([])
    // Outside it, `stepTask`, `stepRun`, `staleAlone`, `follows` and the step helpers are not identifiers anywhere in
    // `src` either. (`cancel` stays a name of the supervisors' and the sessions' job cancel, which is not fold code.)
    expect(tokens(filesUnder(SRC), ["stepTask", "stepRun", "staleAlone", "follows", ...OLD_HELPERS])).toEqual([])

    // Control: the scan finds each name in the shape the old module wrote it, and ignores it in comments and in
    // longer names.
    const sample = [
      "export const obligationMachine = setup({",
      "}).createMachine({",
      "const follows = {",
      "const stepTask = (plan: Plan, state: State, id: string, event: TaskEvent) =>",
      "const cancel = (plan: Plan, state: State, fact: FactOf<'run.cancelled'>) =>",
      "  staleAlone(state, obligation, fact)",
      "// stepRun is gone; the run follows active.onDone",
      "/* stepRun */ const cancelled = runMachine2",
    ].join("\n")
    const scan = (names: ReadonlyArray<string>) =>
      withoutComments(sample)
        .split("\n")
        .flatMap((line, at) =>
          names
            .filter((name) => new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(line))
            .map((name) => `${at + 1} ${name}`),
        )
    expect(scan([...OLD_MACHINES, ...OLD_FOLD])).toEqual([
      "1 obligationMachine",
      "3 follows",
      "4 stepTask",
      "5 cancel",
      "6 staleAlone",
    ])
    expect(constructionsIn(sample)).toEqual([1, 2])
  }),
)

it.live("[RM3] XStateEngine keeps its name and its initial and apply members over an opaque snapshot", () =>
  Effect.gen(function* () {
    const engine = EngineModule.XStateEngine
    expect(Object.keys(engine).toSorted()).toEqual(["apply", "initial", "name"])
    expect(engine.name).toBe("xstate")
    expect(engine.initial).toBe(EngineModule.initial)
    expect(engine.apply).toBe(EngineModule.apply)
    expect(engine.initial.length).toBe(1)
    expect(engine.apply.length).toBe(3)
    expect(EngineModule.TaskEngineXState.XStateEngine).toBe(engine)

    // The members are typed over the machine's snapshot, never over the `State` shape.
    const index = code(path.join(ENGINE_DIR, "index.ts"))
    expect(index).toMatch(/readonly name: "xstate"/)
    expect(index).toMatch(/readonly initial: \(plan: Plan\) => RunSnapshot/)
    expect(index).toMatch(/readonly apply: \(plan: Plan, snapshot: RunSnapshot, fact: Fact\) => RunSnapshot/)
    expect(code(path.join(ENGINE_DIR, "machine.ts"))).toMatch(/export type RunSnapshot = SnapshotFrom<RunMachine>/)
    // No function of the engine takes a `State`: `view` only gives one.
    expect(index).not.toMatch(/\(\s*[\w$]+\s*:\s*State\b/)
    expect(index).not.toMatch(/,\s*[\w$]+\s*:\s*State\b/)
    expect(index).toMatch(/export const view = \(snapshot: RunSnapshot\): State =>/)

    // At run time: `initial` gives the machine's snapshot, not a `State`; `apply` takes and gives that snapshot; the
    // callers read it only through the selectors and `view`.
    const plan = yield* loadPlan("release-notes.spec")
    const first = engine.initial(plan)
    for (const key of ["run", "tasks", "obligations", "scenarios", "history"]) expect(key in first).toBe(false)
    expect(first.machine).toBe(MachineModule.machine(plan))
    const f = facts()
    const started = engine.apply(plan, first, f.runStarted())
    expect(started.machine).toBe(first.machine)
    expect(EngineModule.view(started).run.state).toBe("running")
    expect(EngineModule.unitState(started, "T1.1")).toBe("waiting")
    expect(EngineModule.tags(started, "T1.1")).toEqual(["waiting"])
    expect(EngineModule.ended(started)).toBe(false)
    // The stored-fact fold of the command goes through these two members only.
    const folded = TaskEvents.fold(engine, plan, observed(plan))
    expect(EngineModule.view(folded).tasks["T1.5"]?.state).toBe("blocked")
    expect(code(EVENTS)).toMatch(
      /facts\.reduce\(\(snapshot, fact\) => engine\.apply\(plan, snapshot, fact\), engine\.initial\(plan\)\)/,
    )
  }),
)
