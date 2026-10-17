import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Layer, Option } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { loadPlan } from "./lib/machine"
import { git, jobsOf, refusalOf, runTaskInputs, seed, SPEC } from "./lib/command"

// Scenario VF22 (spec task-harness-feedback, T1.2, T3.2): a spec with no task is refused at the start.
//
//   Given a spec folder that holds only SPEC.md, or only outside preconditions and scenarios
//   When /task runs on it
//   Then it reads "Refused <path>. No work started." and the one plain line "the spec holds no task"
//   And the generator refuses a plan with no task region
//
// Each spec folder is committed in a git instance and loads clean through the real `Blend.load`. `/task` is the real
// `TaskCommand.run` with the real harness root, loader and event store; the ops only record the reply, and the job
// registry only records a start. The generator is the real `TaskMachine.machine`, given the plan `TaskCommand.plan`
// builds from each loaded spec.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const LINE = "the spec holds no task"

// The `outside` block of the release-notes SPEC.md front matter: T8 and T9.
const OUTSIDE = /^outside:\n(?: {2}.*\n)+/m

const SCENARIO = [
  "---",
  "needs: [T8]",
  'category: "Core Business Outcomes"',
  "---",
  "",
  "```gherkin",
  "Scenario: S1 The package is on the registry",
  "  Given the release pipeline ran",
  "  When a user installs the package",
  "  Then the install succeeds",
  "```",
  "",
].join("\n")

// The spec folders with no task, each built from the release-notes SPEC.md.
interface Case {
  readonly name: string
  readonly spec: string
  readonly outside: ReadonlyArray<string>
  readonly scenarios: ReadonlyArray<string>
  /** The SPEC.md text from the release-notes one. */
  readonly text: (spec: string) => string
  readonly files: ReadonlyArray<readonly [string, string]>
}

const CASES: ReadonlyArray<Case> = [
  {
    name: "only SPEC.md, with no outside precondition",
    spec: "specs/bare.spec",
    outside: [],
    scenarios: [],
    text: (spec) => spec.replace(OUTSIDE, ""),
    files: [],
  },
  {
    name: "only SPEC.md with its outside preconditions T8 and T9",
    spec: "specs/outside-only.spec",
    outside: ["T8", "T9"],
    scenarios: [],
    text: (spec) => spec,
    files: [],
  },
  {
    name: "only outside preconditions and a scenario that needs T8",
    spec: "specs/outside-and-scenario.spec",
    outside: ["T8", "T9"],
    scenarios: ["S1"],
    text: (spec) => spec,
    files: [["acceptance/S1.md", SCENARIO]],
  },
]

const textOf = (inputs: ReadonlyArray<{ readonly parts: ReadonlyArray<{ readonly text: string }> }>) =>
  inputs.map((input) => input.parts.map((part) => part.text).join("\n"))

// The spec folder of a case, committed in the instance's repository, and its load.
const build = (item: Case) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* seed(SPEC)
    const folder = path.join(directory, item.spec)
    yield* fs.makeDirectory(folder, { recursive: true })
    yield* fs.writeFileString(
      path.join(folder, "SPEC.md"),
      item.text(yield* fs.readFileString(path.join(directory, SPEC, "SPEC.md"))),
    )
    for (const [file, text] of item.files) {
      yield* fs.makeDirectory(path.dirname(path.join(folder, file)), { recursive: true })
      yield* fs.writeFileString(path.join(folder, file), text)
    }
    yield* git(directory, "add", "-A")
    yield* git(directory, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "no task")
    const loaded = yield* Blend.load(folder)
    return { directory, loaded }
  })

for (const item of CASES) {
  it.instance(
    `[VF22] a spec folder with ${item.name}: /task reads "Refused <path>. No work started." and the one plain line "${LINE}"`,
    () =>
      Effect.gen(function* () {
        const { directory, loaded } = yield* build(item)

        // Given: the folder loads with no failure, and its spec holds no task.
        expect(loaded.failures).toEqual([])
        expect(loaded.spec?.tasks).toEqual([])
        expect(Object.keys(loaded.spec?.outside ?? {}).toSorted()).toEqual([...item.outside])
        expect(loaded.spec?.scenarios.map((scenario) => scenario.id)).toEqual([...item.scenarios])
        const worktrees = yield* git(directory, "worktree", "list", "--porcelain")

        // When /task runs on it.
        const harness = yield* TaskHarness.make
        const jobs = jobsOf()
        const inputs = yield* runTaskInputs(harness, item.spec, jobs)

        // Then: one session message with no model turn, the plain header and the one plain line, with no count and
        // no hint.
        expect(inputs).toHaveLength(1)
        expect(inputs[0]?.noReply).toBe(true)
        expect(textOf(inputs)).toEqual([`Refused ${item.spec}. No work started.\n${LINE}`])

        // Refused at the start: no job, no lease, no fact, no worktree; the status file holds the one line.
        expect(jobs.starts).toEqual([])
        expect(yield* harness.live(directory)).toEqual(Option.none())
        const db = yield* Database.Service
        expect(yield* TaskEvents.read(db.db, TaskEvents.runID(directory, item.spec))).toEqual([])
        expect(yield* git(directory, "worktree", "list", "--porcelain")).toBe(worktrees)
        expect(yield* refusalOf(directory)).toMatchObject({
          state: "refused",
          spec: item.spec,
          path: item.spec,
          reason: LINE,
        })
      }),
    { git: true },
  )

  it.instance(
    `[VF22] the generator refuses the plan of a spec with ${item.name}: it has no task region`,
    () =>
      Effect.gen(function* () {
        const { loaded } = yield* build(item)
        const spec = loaded.spec
        expect(spec).toBeDefined()
        if (!spec) return
        const plan = TaskCommand.plan({ spec, specPath: item.spec, path: item.spec, root: Option.none() })
        expect(plan.tasks).toEqual([])
        expect(plan.scenarios.map((scenario) => scenario.id)).toEqual([...item.scenarios])

        // The generator dies with a defect that names the spec, before any machine exists.
        const id = path.basename(item.spec, ".spec")
        expect(spec.id).toBe(id)
        expect(() => TaskMachine.machine(plan)).toThrow(`${id}: the plan has no task, so a run of it could never end`)
      }),
    { git: true },
  )
}

it.instance("[VF22] control: the generator builds the machine of the release-notes plan, which holds tasks", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    expect(plan.tasks.length).toBeGreaterThan(0)
    expect(() => TaskMachine.machine(plan)).not.toThrow()
  }),
)
