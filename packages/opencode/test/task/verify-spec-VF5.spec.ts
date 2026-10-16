import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import path from "path"
import { createActor, SimulatedClock } from "@jambudipa/xstate-effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import { TaskCommand } from "@/task/core/command"
import { RunSupervisor } from "@/task/core/supervise/run"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { eventually, runOf, settle, storedFacts } from "./lib/supervise"

// Scenario VF5 (spec task-harness-feedback, D12, AD-12, AD-14, SD-15): a valid reload clears the run warning.
//
//   Given a run whose warning shows two failures
//   When the spec validates again
//   Then spec.checked is recorded with no failures and the warning goes
//   And a valid reload that adds or removes an obligation id of the plan counts as a failure and the run keeps the old text
//   And a reload with the same failures as the current warning records nothing
//
// The run is the real run supervisor (`RunSupervisor.machine`, no actor replaced) started as a root actor on a
// SimulatedClock, so each stale check is one step of its 1 s cadence and the test counts checks exactly. Its run
// actor is a real Recorder over the real event store, with the real status writer (`writes: true`) writing
// status.json in the run's directory. The spec is a temp copy of release-notes.spec whose root tasks T1.1 and T1.2 are
// after the outside precondition T9, so no task becomes ready and no unit supervisor or session work starts. The stale
// check is the real worker: it loads the copy from disk. The expected lines come from the loader and from the SD-15
// texts of tasks.md T3.3.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const T11_TASK = "T1-release-notes.task/T1.1-commit-parser.task/TASK.md"
const T12_TASK = "T1-release-notes.task/T1.2-version-bump.task/TASK.md"
const T13_VERIFY = "T1-release-notes.task/T1.3-markdown-render.task/VERIFY.md"
const FORMAT = path.resolve(import.meta.dir, "../../../../task-formats/blend")

const decodeStatus = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))

const lineOf = (failure: { readonly rule: string; readonly path: string; readonly message: string }) =>
  `${failure.rule} ${failure.path}: ${failure.message}`

// Two R3 faults in T1.3's VERIFY.md: c1 and c3 get an unknown category.
const breakTwo = (text: string) =>
  text
    .replace("  c1:\n    category: happy-path\n", "  c1:\n    category: nonsense\n")
    .replace("  c3:\n    category: invalid-input\n", "  c3:\n    category: nonsense\n")
// One of the two faults fixed: only c3 keeps the unknown category.
const breakOne = (text: string) =>
  text.replace("  c3:\n    category: invalid-input\n", "  c3:\n    category: nonsense\n")
// A new text for T1.3.c1: a reload the run took would carry it.
const changeText = (text: string) =>
  text.replace('    text: "The output follows', '    text: "Changed. The output follows')
// A valid new obligation T1.3.c9.
const addC9 = (text: string) =>
  text.replace(
    "ensures:\n",
    'ensures:\n  c9:\n    category: boundary\n    text: "An added obligation."\n    covers: [S4]\n',
  )
// T1.3.c4 removed (no other key names it).
const removeC4 = (text: string) => text.replace(/^ {2}c4:\n(?: {4}.*\n)+/m, "")

// A live run of a copy of release-notes.spec in a temp directory, whose stale check reads the copy.
const liveRun = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  const specDir = path.join(directory, "release-notes.spec")
  yield* fs.copy(path.join(FORMAT, "release-notes.spec"), specDir)
  const file = (name: string) => path.join(specDir, name)
  const edit = (name: string, change: (text: string) => string) =>
    Effect.gen(function* () {
      const before = yield* fs.readFileString(file(name))
      const after = change(before)
      expect(after).not.toBe(before)
      yield* fs.writeFileString(file(name), after)
    })
  yield* edit(T11_TASK, (text) => text.replace("---\n", "---\nafter: [T9]\n"))
  yield* edit(T12_TASK, (text) => text.replace("---\n", "---\nafter: [T9]\n"))
  const original = yield* fs.readFileString(file(T13_VERIFY))
  const loaded = yield* Blend.load(specDir)
  expect(loaded.failures).toEqual([])
  const spec = loaded.spec
  if (spec === undefined) return yield* Effect.die(new Error("the copy did not load"))
  const plan = TaskCommand.plan({
    spec,
    specPath: "release-notes.spec",
    path: "release-notes.spec",
    root: Option.none(),
  })

  const setup = yield* runOf({ plan, directory, stored: [], writes: true })
  const clock = new SimulatedClock()
  const actor = yield* createActor(RunSupervisor.machine, {
    input: {
      run: { ...setup.run, specDir },
      events: setup.events,
      resumed: false,
      path: plan.path,
      trusts: Effect.succeed([]),
      externals: [],
      release: Effect.void,
      writer: setup.recorder.writer,
    },
    clock,
  })
  yield* actor.start
  yield* eventually(
    Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches("running")),
    "the run supervisor is running",
  )
  yield* eventually(
    Effect.map(storedFacts(setup.id), (facts) => facts.some((fact) => fact.type === "run.started")),
    "run.started",
  )

  // One stale check: the 1 s cadence fires, the check runs, and the cadence is back in `waiting`.
  const check = Effect.gen(function* () {
    yield* settle
    yield* clock.increment(1_000)
    yield* eventually(
      Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches({ running: { staleCadence: "checking" } })),
      "the stale check starts",
    )
    yield* eventually(
      Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches({ running: { staleCadence: "waiting" } })),
      "the stale check ends",
    )
    yield* settle
  })
  // The spec.checked facts the run stored, each as its failure lines.
  const checked = Effect.map(storedFacts(setup.id), (facts) =>
    facts.flatMap((fact) => (fact.type === "spec.checked" ? [fact.failures.map(lineOf)] : [])),
  )
  // The loader's lines for the copy as it is now.
  const lines = Effect.map(Blend.load(specDir), (result) => result.failures.map(lineOf))
  // The run actor's warning, as the engine's view gives it.
  const warning = Effect.map(
    setup.recorder.actor.getSnapshot,
    (snapshot) => TaskEngineXState.view(snapshot).run.warning,
  )
  // The status file, once the writer has written what `ready` accepts.
  const statusWhen = (ready: (status: TaskStatus.Status) => boolean, what: string) =>
    Effect.gen(function* () {
      // The harness's own status-file path for the run's directory.
      const file = TaskStatus.file(yield* Path.Path, directory)
      const read = Effect.gen(function* () {
        if (!(yield* fs.exists(file))) return Option.none<TaskStatus.Status>()
        return Option.some(decodeStatus(yield* fs.readFileString(file)))
      })
      for (let tries = 0; tries < 1500; tries++) {
        const status = yield* read
        if (Option.isSome(status) && ready(status.value)) return status.value
        yield* Effect.sleep(10)
      }
      return yield* Effect.die(new Error(`never: ${what}`))
    })
  // The run history entries of spec.checked, from the run actor.
  const entries = Effect.map(setup.recorder.actor.getSnapshot, (snapshot) =>
    snapshot.context.log
      .filter((entry) => entry.unit === "run" && (entry.reason ?? "").startsWith("spec.checked"))
      .map((entry) => entry.reason),
  )
  const supervisorText = (id: string) =>
    Effect.map(actor.getSnapshot, (snapshot) => snapshot.context.spec.obligations.find((item) => item.id === id)?.text)
  const supervisorIds = Effect.map(actor.getSnapshot, (snapshot) =>
    snapshot.context.spec.obligations.map((item) => item.id),
  )
  return {
    setup,
    actor,
    edit,
    restore: edit(T13_VERIFY, () => original),
    check,
    checked,
    lines,
    warning,
    statusWhen,
    entries,
    supervisorText,
    supervisorIds,
  }
})

// Given: a run whose warning shows two failures.
const warnedRun = Effect.gen(function* () {
  const run = yield* liveRun
  yield* run.edit(T13_VERIFY, breakTwo)
  const two = yield* run.lines
  expect(two).toHaveLength(2)
  yield* run.check
  expect(yield* run.checked).toEqual([two])
  expect(yield* run.warning).toBe(two.join("\n"))
  const status = yield* run.statusWhen((status) => status.run.warning !== undefined, "the warning in status.json")
  expect(status.run.warning?.split("\n")).toEqual(two)
  return { ...run, two }
})

it.live(
  "[VF5] a run whose warning shows two failures: when the spec validates again, spec.checked is recorded with no failures and the warning goes",
  () =>
    Effect.gen(function* () {
      const run = yield* warnedRun

      // When the spec validates again.
      yield* run.restore
      expect(yield* run.lines).toEqual([])
      yield* run.check

      // Then spec.checked is recorded with no failures.
      expect(yield* run.checked).toEqual([run.two, []])
      const facts = yield* storedFacts(run.setup.id)
      expect(facts.filter((fact) => fact.type === "spec.checked").at(-1)).toMatchObject({ failures: [] })
      // And the warning goes: from the run actor's view, from status.json; the history names both checks.
      expect(yield* run.warning).toBeUndefined()
      const status = yield* run.statusWhen((status) => status.run.warning === undefined, "status.json with no warning")
      expect(status.run).not.toHaveProperty("warning")
      expect(yield* run.entries).toEqual(["spec.checked: 2 failures", "spec.checked: no failures"])
      expect(status.history.filter((entry) => entry.unit === "run").map((entry) => entry.reason)).toContain(
        "spec.checked: no failures",
      )
      // The run goes on: it has not ended.
      expect((yield* run.actor.getSnapshot).matches("running")).toBe(true)
    }),
)

it.live("[VF5] a reload with the same failures as the current warning records nothing; a changed list does", () =>
  Effect.gen(function* () {
    const run = yield* warnedRun

    // The same two failures, three more checks: nothing more is recorded, and the warning stays.
    yield* run.check
    yield* run.check
    yield* run.check
    expect(yield* run.checked).toEqual([run.two])
    expect(yield* run.entries).toEqual(["spec.checked: 2 failures"])
    expect(yield* run.warning).toBe(run.two.join("\n"))

    // Control: one fault fixed changes the list, and the next check records it.
    yield* run.restore
    yield* run.edit(T13_VERIFY, breakOne)
    const one = yield* run.lines
    expect(one).toHaveLength(1)
    yield* run.check
    expect(yield* run.checked).toEqual([run.two, one])

    // A valid spec after a valid check: no warning to clear, so nothing is recorded.
    yield* run.restore
    yield* run.check
    expect(yield* run.checked).toEqual([run.two, one, []])
    yield* run.check
    yield* run.check
    expect(yield* run.checked).toEqual([run.two, one, []])
  }),
)

it.live(
  "[VF5] a valid reload that adds or removes an obligation id of the plan counts as a failure, and the run keeps the old text",
  () =>
    Effect.gen(function* () {
      const run = yield* warnedRun
      const oldText = yield* run.supervisorText("T1.3.c1")
      expect(oldText).toStartWith("The output follows")
      const oldIds = yield* run.supervisorIds
      const folder = "T1-release-notes.task/T1.3-markdown-render.task"

      // A valid reload that adds T1.3.c9 and changes c1's text.
      yield* run.restore
      yield* run.edit(T13_VERIFY, (text) => changeText(addC9(text)))
      expect(yield* run.lines).toEqual([])
      yield* run.check
      const added = `R3 ${folder}/VERIFY.md: obligation T1.3.c9 is not in the loaded plan; the run keeps the plan it loaded`
      expect(yield* run.checked).toEqual([run.two, [added]])
      expect(yield* run.warning).toBe(added)
      expect(yield* run.supervisorText("T1.3.c1")).toBe(oldText)
      expect(yield* run.supervisorIds).toEqual(oldIds)

      // A valid reload that removes T1.3.c4 and changes c1's text.
      yield* run.restore
      yield* run.edit(T13_VERIFY, (text) => changeText(removeC4(text)))
      expect(yield* run.lines).toEqual([])
      yield* run.check
      const removed = `R3 ${folder}/VERIFY.md: obligation T1.3.c4 of the loaded plan is missing; the run keeps the plan it loaded`
      expect(yield* run.checked).toEqual([run.two, [added], [removed]])
      expect(yield* run.warning).toBe(removed)
      expect(yield* run.supervisorText("T1.3.c1")).toBe(oldText)
      expect(yield* run.supervisorIds).toEqual(oldIds)
      expect(oldIds).toContain("T1.3.c4")

      // The id change is a failure like any other: the same one again records nothing, and the run takes no new text.
      yield* run.check
      expect(yield* run.checked).toEqual([run.two, [added], [removed]])
      const facts = yield* storedFacts(run.setup.id)
      expect(facts.filter((fact) => fact.type === "obligation.stale")).toEqual([])
      const status = yield* run.statusWhen((status) => status.run.warning === removed, "the id-change warning")
      expect(status.run.warning).toBe(removed)
    }),
)
