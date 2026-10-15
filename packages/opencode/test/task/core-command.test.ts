import { NodeServices } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, FileSystem, Layer, Logger, Option, Path } from "effect"
import path from "path"
import { assign, setup } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import type { BlendModel } from "@/task/blend/model"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact, Plan } from "@/task/core/model"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { exhaustLeaf, facts, fold, loadPlan, trustLeaf } from "./lib/machine"
import {
  backgroundOf,
  git,
  jobsOf,
  refusalOf,
  runTask,
  runTaskInputs,
  seed,
  SESSION,
  SPEC,
  statusFile,
} from "./lib/command"
import { TaskStatus } from "@/task/core/status"
import { boundary, eventually } from "./lib/supervise"

// `/task` (spine AD-8, AD-19, AD-6), through the harness of `./lib/command`: the event store, the database and the
// harness root are real.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))
const limits = TaskLimits.scripted

// A committed copy of the release-notes spec and one tracked source file in the instance's repository.
const seeded = seed(SPEC)

const BUSY =
  "Not started: the run of task-formats/blend/release-notes.spec is live in this directory (/task task-formats/blend/release-notes.spec). One run at a time: wait for it to end, or stop it in its own session with ctrl+x w, then esc twice."

describe("/task on a root checkout that cannot take a run", () => {
  it.instance(
    "refuses a tracked change and names it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* seeded
        yield* fs.writeFileString(path.join(directory, "app.ts"), "export const app = 2\n")

        const replies = yield* runTask(yield* TaskHarness.make)

        // A plain line with no rule: no count and no hint (VF19).
        expect(replies).toEqual([
          `Refused ${SPEC}. No work started.\nthe checkout has uncommitted changes or untracked files: app.ts`,
        ])
        expect(yield* refusalOf(directory)).toMatchObject({
          state: "refused",
          spec: SPEC,
          reason: "the checkout has uncommitted changes or untracked files: app.ts",
        })
      }),
    { git: true },
  )

  it.instance(
    "refuses a detached HEAD",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        yield* git(directory, "switch", "-q", "--detach", "HEAD")

        const replies = yield* runTask(yield* TaskHarness.make)

        expect(replies).toEqual([`Refused ${SPEC}. No work started.\nthe checkout is not on a branch (detached HEAD)`])
        expect(yield* refusalOf(directory)).toMatchObject({
          state: "refused",
          spec: SPEC,
          reason: "the checkout is not on a branch (detached HEAD)",
        })
      }),
    { git: true },
  )
})

// A file of the seeded spec, rewritten.
const edit = (directory: string, file: string, change: (text: string) => string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const target = path.join(directory, SPEC, file)
    yield* fs.writeFileString(target, change(yield* fs.readFileString(target)))
  })

const T11 = "T1-release-notes.task/T1.1-commit-parser.task/TASK.md"
const T12 = "T1-release-notes.task/T1.2-version-bump.task/TASK.md"
const T13 = "T1-release-notes.task/T1.3-markdown-render.task/TASK.md"

// The loader's own failure lines for a spec folder of the instance, in its order.
const loaderLines = (directory: string, spec: string = SPEC) =>
  Effect.map(Blend.load(path.join(directory, spec)), (result) =>
    result.failures.map((failure) => `${failure.rule} ${failure.path}: ${failure.message}`),
  )

const ruleOf = (line: string) => line.split(" ")[0]

// An R3 front-matter fault and nothing else: a second `refs` key.
const duplicateKey = (text: string) => text.replace("---\n", "---\nrefs: []\n")

const HINT = `Fix each line, then type /task ${SPEC} again.`

// The release-notes SPEC.md alone in a new spec folder: its `outside` lists T8 and T9, and it has no task folder.
const taskless = (directory: string, spec: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.join(directory, spec), { recursive: true })
    yield* fs.copyFile(path.join(directory, SPEC, "SPEC.md"), path.join(directory, spec, "SPEC.md"))
  })

describe('the refusal message (D10, EXPERIENCE "Refusal")', () => {
  it.instance(
    "lists every loader failure in loader order under a counted header, then the hint; run.reason holds the lines (VF1)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* seeded
        yield* fs.writeFileString(path.join(directory, SPEC, "notes.txt"), "a stray file\n")
        yield* edit(directory, T12, (text) => text.replace("# Compute the next version", "Compute the next version"))
        yield* edit(directory, T13, duplicateKey)
        // The loader orders its failures by rule, then by file.
        const lines = yield* loaderLines(directory)
        expect(lines.map(ruleOf)).toEqual(["R1", "R3", "R4"])

        const replies = yield* runTask(yield* TaskHarness.make)

        expect(replies).toEqual([[`Refused ${SPEC}: 3 failures. No work started.`, ...lines, HINT].join("\n")])
        expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC, reason: lines.join("\n") })
      }),
    { git: true },
  )

  it.instance(
    "reads 1 failure for one loader failure, with its line and the hint (VF19)",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        yield* edit(directory, T13, duplicateKey)
        const lines = yield* loaderLines(directory)
        expect(lines.map(ruleOf)).toEqual(["R3"])

        expect(yield* runTask(yield* TaskHarness.make)).toEqual([
          [`Refused ${SPEC}: 1 failure. No work started.`, lines[0], HINT].join("\n"),
        ])
        expect((yield* refusalOf(directory)).reason).toBe(lines[0])
      }),
    { git: true },
  )

  it.instance(
    "keeps the argument as the spec of a path outside any spec folder",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        yield* runTask(yield* TaskHarness.make, "nowhere")
        expect(yield* refusalOf(directory)).toMatchObject({
          state: "refused",
          spec: "nowhere",
          path: "nowhere",
          reason: "R1 nowhere: not inside a `<slug>.spec` folder",
        })
      }),
    { git: true },
  )

  it.instance(
    "lists only the R3 line of a spec that also has an R7 cycle: R5-R13 wait for R1-R4 (VF23)",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        yield* edit(directory, T11, (text) => text.replace("---\n", "---\nafter: [T1.2]\n"))
        yield* edit(directory, T12, (text) => text.replace("---\n", "---\nafter: [T1.1]\n"))
        // The cycle on its own is an R7 failure.
        expect((yield* loaderLines(directory)).map(ruleOf)).toContain("R7")
        yield* edit(directory, T13, duplicateKey)
        const lines = yield* loaderLines(directory)
        expect(lines.map(ruleOf)).toEqual(["R3"])

        expect(yield* runTask(yield* TaskHarness.make)).toEqual([
          [`Refused ${SPEC}: 1 failure. No work started.`, lines[0], HINT].join("\n"),
        ])
      }),
    { git: true },
  )

  it.instance(
    "refuses a spec with no task with one plain line, and starts nothing (VF22)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        const jobs = jobsOf()
        // Only SPEC.md.
        const bare = "task-formats/blend/bare.spec"
        yield* taskless(directory, bare)
        expect(yield* loaderLines(directory, bare)).toEqual([])
        expect(yield* runTask(harness, bare, jobs)).toEqual([
          `Refused ${bare}. No work started.\nthe spec holds no task`,
        ])
        expect(yield* refusalOf(directory)).toMatchObject({
          state: "refused",
          spec: bare,
          reason: "the spec holds no task",
        })
        // Only outside preconditions and a scenario that needs one of them.
        const outside = "task-formats/blend/outside-only.spec"
        yield* taskless(directory, outside)
        yield* fs.makeDirectory(path.join(directory, outside, "acceptance"))
        yield* fs.writeFileString(
          path.join(directory, outside, "acceptance", "S1.md"),
          [
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
          ].join("\n"),
        )
        expect(yield* loaderLines(directory, outside)).toEqual([])
        expect(yield* runTask(harness, outside, jobs)).toEqual([
          `Refused ${outside}. No work started.\nthe spec holds no task`,
        ])
        expect(jobs.starts).toEqual([])
        expect(yield* harness.live(directory)).toEqual(Option.none())
      }),
    { git: true },
  )

  it.instance(
    "with a run live, a faulty spec gets its refusal in the session and the live run's status file stays (VF2)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        yield* harness.claim({ directory, runID: "task_live", spec: SPEC, path: SPEC })
        // The live run's status file, as its writer left it.
        yield* fs.makeDirectory(path.dirname(statusFile(directory)), { recursive: true })
        yield* fs.writeFileString(statusFile(directory), '{"run":{"state":"running"}}')
        yield* edit(directory, T13, duplicateKey)

        const replies = yield* runTask(harness)

        expect(replies[0]).toStartWith(`Refused ${SPEC}: 1 failure. No work started.\nR3 `)
        expect(yield* fs.readFileString(statusFile(directory))).toBe('{"run":{"state":"running"}}')
      }),
    { git: true },
  )
})

describe("the refusal lines of a load (D10)", () => {
  const failure = (rule: BlendModel.RuleId, path: string, message: string) => ({ rule, path, message })

  test("lists every failure as one `<rule> <path>: <message>` line, in the load's order", () => {
    expect(
      TaskCommand.loadFailures({
        failures: [failure("R1", "notes.txt", "a stray file"), failure("R4", "T1.task/TASK.md", "no H1")],
        notes: [],
      }),
    ).toEqual(["R1 notes.txt: a stray file", "R4 T1.task/TASK.md: no H1"])
  })

  test("gives the one fallback line for a load with neither a spec nor a failure", () => {
    expect(TaskCommand.loadFailures({ failures: [], notes: [] })).toEqual(["R1 .: the spec did not load"])
  })
})

describe("one run per directory (AD-19, SV8)", () => {
  it.instance(
    "with a run live, a valid spec gets one busy line naming the live run, writes no file and starts nothing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        yield* harness.claim({ directory, runID: "task_live", spec: SPEC, path: SPEC })
        const jobs = jobsOf()
        expect(yield* runTask(harness, SPEC, jobs)).toEqual([BUSY])
        expect(jobs.starts).toEqual([])
        expect(yield* fs.exists(statusFile(directory))).toBe(false)
        // The same line answers a second /task of another path of the spec.
        expect(yield* runTask(harness, `${SPEC}/T1-release-notes.task`, jobs)).toEqual([BUSY])
      }),
    { git: true },
  )

  it.instance(
    "answers the usage line to an empty /task, and claims and starts nothing",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        const jobs = jobsOf()
        expect(yield* runTask(harness, "  ", jobs)).toEqual([
          "Usage: /task <path to a .spec or .task folder> | /task trust <id>",
        ])
        expect(yield* harness.live(directory)).toEqual(Option.none())
        expect(jobs.starts).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "with a run live and a dirty checkout, answers the busy line: the live check comes before the git check",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* seeded
        yield* fs.writeFileString(path.join(directory, "app.ts"), "export const app = 2\n")
        const harness = yield* TaskHarness.make
        yield* harness.claim({ directory, runID: "task_live", spec: SPEC, path: SPEC })
        expect(yield* runTask(harness)).toEqual([BUSY])
        expect(yield* fs.exists(statusFile(directory))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "refuses to resume a slice that started on another branch, before it claims or starts",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const events = yield* EventV2Bridge.Service
        const id = TaskEvents.runID(directory, SPEC)
        yield* TaskEvents.publish(events, id, { type: "run.started", at: 1, base: "release", path: SPEC })
        const harness = yield* TaskHarness.make
        const jobs = jobsOf()
        expect(yield* runTask(harness, SPEC, jobs)).toEqual([
          `Refused ${SPEC}. No work started.\nthe unfinished run of ${SPEC} started on the branch release; switch back to it to resume the run`,
        ])
        expect(yield* harness.live(directory)).toEqual(Option.none())
        expect(jobs.starts).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "resumes the open slice of the same path: the job records run.resumed with the normalised path",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
        const events = yield* EventV2Bridge.Service
        const db = yield* Database.Service
        const id = TaskEvents.runID(directory, SPEC)
        // The stored slice also names T1.9, a task the spec no longer has: its fold must not throw.
        yield* TaskEvents.publish(events, id, { type: "run.started", at: 1, base: branch, path: SPEC })
        yield* TaskEvents.publish(events, id, {
          type: "task.started",
          at: 2,
          task: "T1.9",
          worktree: "/wt",
          branch: "b",
          base: "c",
          session: "ses_gone",
        })
        const harness = yield* TaskHarness.make
        const jobs = jobsOf()
        jobs.mode = "run"
        const replies = yield* runTask(harness, `./${SPEC}/`, jobs)
        expect(replies[0]).toStartWith("Implementing spec **Release notes from conventional commits**")
        yield* eventually(
          Effect.map(TaskEvents.read(db.db, id), (list) => list.some((fact) => fact.type === "run.resumed")),
          "run.resumed",
        )
        const stored = yield* TaskEvents.read(db.db, id)
        expect(stored.filter((fact) => fact.type === "run.started")).toHaveLength(1)
        expect(stored.find((fact) => fact.type === "run.resumed")).toMatchObject({ path: SPEC, base: branch })
        jobs.status = "cancelled"
        for (const fiber of jobs.fibers) yield* Fiber.interrupt(fiber)
        expect(yield* harness.live(directory)).toEqual(Option.none())
      }),
    { git: true },
  )

  it.instance(
    "with a run live, a loader refusal and a task-folder refusal answer in the session only",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        yield* harness.claim({ directory, runID: "task_live", spec: SPEC, path: SPEC })
        expect(yield* runTask(harness, "nowhere")).toEqual([
          "Refused nowhere: 1 failure. No work started.\nR1 nowhere: not inside a `<slug>.spec` folder\nFix each line, then type /task nowhere again.",
        ])
        // The acceptance folder loads, and is not a task folder.
        expect(yield* runTask(harness, `${SPEC}/acceptance`)).toEqual([
          `Refused ${SPEC}/acceptance: 1 failure. No work started.\nR2 acceptance: not a \`<task id>-<slug>.task\` folder\nFix each line, then type /task ${SPEC}/acceptance again.`,
        ])
        expect(yield* fs.exists(statusFile(directory))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "starts the job as the run id under the root session and claims the lease with the normalised path",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        const jobs = jobsOf()
        const replies = yield* runTask(harness, `./${SPEC}/`, jobs)
        expect(replies).toEqual(["Implementing spec **Release notes from conventional commits**"])
        const id = TaskEvents.runID(directory, SPEC)
        expect(jobs.starts).toHaveLength(1)
        expect(jobs.starts[0]).toMatchObject({
          id,
          type: "task-harness",
          title: `/task ./${SPEC}/`,
          metadata: { parentSessionId: SESSION },
        })
        // `./spec/`, `spec/` and `spec` name one run: the lease holds the normalised path.
        expect(yield* harness.live(directory)).toEqual(Option.some({ runID: id, spec: SPEC, path: SPEC }))
        expect(yield* runTask(harness, SPEC, jobs)).toEqual([BUSY])
        expect(jobs.starts).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "frees the claim of a job that did not start, so the next /task is not busy",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        const jobs = jobsOf()
        jobs.mode = "fail"
        const failed = yield* Effect.exit(runTask(harness, SPEC, jobs))
        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* harness.live(directory)).toEqual(Option.none())
        jobs.mode = "start"
        expect((yield* runTask(harness, SPEC, jobs))[0]).toStartWith("Implementing spec")
        expect(jobs.starts).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "frees this call's claim when a job of that id is already running",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        const jobs = jobsOf()
        jobs.mode = "elsewhere"
        expect(yield* runTask(harness, SPEC, jobs)).toEqual([`Task harness: the run of ${SPEC} is already going on.`])
        expect(yield* harness.live(directory)).toEqual(Option.none())
      }),
    { git: true },
  )

  it.instance(
    "answers busy to the second of two calls that both passed the live check, and keeps the first claim",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        // The first call has claimed after this call read the lease as free.
        yield* harness.claim({ directory, runID: "task_first", spec: SPEC, path: SPEC })
        const stale: TaskHarness.Interface = { ...harness, live: () => Effect.succeed(Option.none()) }
        const jobs = jobsOf()
        expect(yield* runTask(stale, SPEC, jobs)).toEqual([BUSY])
        expect(jobs.starts).toEqual([])
        expect(yield* (yield* FileSystem.FileSystem).exists(statusFile(directory))).toBe(false)
        expect(yield* harness.live(directory)).toEqual(Option.some({ runID: "task_first", spec: SPEC, path: SPEC }))
      }),
    { git: true },
  )

  it.instance(
    "SV20 records /task trust on the directory aggregate, then forwards it to the live run of the directory",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        const listener = setup({
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- xstate reads `types` for its type parameters only
          types: {} as { context: { trusts: ReadonlyArray<string> }; events: { type: "run.trust"; id: string } },
        }).createMachine({
          context: { trusts: [] },
          on: { "run.trust": { actions: assign({ trusts: ({ context, event }) => [...context.trusts, event.id] }) } },
        })
        yield* harness.claim({ directory, runID: "task_live", spec: SPEC, path: SPEC })
        yield* harness.spawnRun("task_live", listener)
        expect(yield* runTask(harness, "trust T9")).toEqual([
          "Task harness: recorded the outside precondition T9 as trusted.",
        ])
        const db = yield* Database.Service
        const recorded = yield* TaskEvents.read(db.db, TaskEvents.directoryID(directory))
        expect(TaskEvents.trustedOutside(recorded)).toEqual(["T9"])
        yield* eventually(
          Effect.gen(function* () {
            const ref = yield* harness.system.get("run:task_live")
            if (Option.isNone(ref)) return false
            return JSON.stringify((yield* ref.value.getSnapshot).context).includes('"T9"')
          }),
          "the live run got the trust",
        )
      }),
    { git: true },
  )
})

const WHOLE = "task-formats/blend/release-notes.spec"
const SUBTREE = `${WHOLE}/T1-release-notes.task/T1.5-issue-links.task`

describe("the slice a /task starts from (SV3, RM8, SV26)", () => {
  it.live("RM8b resumes an old slice with no path and no end for the whole spec, written any way", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const stored: ReadonlyArray<Fact> = [f.runStarted(), f.started("T1.1")]
      expect(yield* TaskCommand.sliceOf(plan, stored, WHOLE)).toEqual({ kind: "resume", facts: stored })
      const paths = yield* Path.Path
      const directory = "/repo"
      for (const written of [WHOLE, `${WHOLE}/`, `./${WHOLE}`, `./${WHOLE}/`])
        expect(TaskCommand.normalizedPath(paths, directory, paths.resolve(directory, written))).toBe(WHOLE)
    }),
  )

  it.live("SV3 resumes the slice of the same path and starts a new slice for another path", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const subtree: ReadonlyArray<Fact> = [f.runStarted(SUBTREE), f.started("T1.1")]
      expect(yield* TaskCommand.sliceOf(plan, subtree, SUBTREE)).toEqual({ kind: "resume", facts: subtree })
      expect(yield* TaskCommand.sliceOf(plan, subtree, WHOLE)).toEqual({ kind: "new", died: Option.none() })
      // Only the latest slice counts: an earlier one of the same path does not resume.
      const later: ReadonlyArray<Fact> = [...subtree, f.runStarted(WHOLE)]
      expect(yield* TaskCommand.sliceOf(plan, later, SUBTREE)).toEqual({ kind: "new", died: Option.none() })
      expect(yield* TaskCommand.sliceOf(plan, [], WHOLE)).toEqual({ kind: "new", died: Option.none() })
    }),
  )

  it.live("RM8a starts a new slice after a stored stop", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      for (const stop of [f.cancelled("user stop"), f.ended("failed", "wall clock")])
        expect(yield* TaskCommand.sliceOf(plan, [f.runStarted(WHOLE), stop], WHOLE)).toEqual({
          kind: "new",
          died: Option.none(),
        })
    }),
  )

  it.live("RM8c starts a new slice after a slice whose fold is done with no stop", () =>
    Effect.gen(function* () {
      // The subtree of the leaf T1.1: T1.1, the scenarios that need only it, and the spec's outside preconditions.
      const plan = yield* loadPlan("release-notes.spec", "T1.1")
      expect(plan.scenarios.map((item) => item.id)).toEqual(["S2", "S7"])
      const f = facts()
      const stored: ReadonlyArray<Fact> = [
        f.runStarted(plan.path),
        f.outside("T8"),
        f.outside("T9"),
        ...trustLeaf(plan, f, "T1.1"),
        ...["S2", "S7"].flatMap((id) => [
          f.scenarioProved(id, "passed"),
          f.scenarioVerified({ id, verdict: "trusted" }),
        ]),
      ]
      expect(TaskEngineXState.ended(TaskEvents.fold(TaskEngineXState.XStateEngine, plan, stored))).toBe(true)
      expect(yield* TaskCommand.sliceOf(plan, stored, plan.path)).toEqual({ kind: "new", died: Option.none() })
    }),
  )

  it.live("folds a slice that names an id the spec dropped without a throw, and resumes it", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const stored: ReadonlyArray<Fact> = [f.runStarted(WHOLE), f.started("T1.9"), f.started("T1.1")]
      expect(yield* TaskCommand.sliceOf(plan, stored, WHOLE)).toEqual({ kind: "resume", facts: stored })
    }),
  )

  it.live("SV26 counts a slice whose fold dies as ended, names the defect, and starts a new slice", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      // Two tasks with one id: the run machine of this plan cannot be built, so the fold dies.
      const broken: Plan = { ...plan, tasks: [...plan.tasks, ...plan.tasks.slice(0, 1)] }
      const messages: Array<unknown> = []
      const slice = yield* TaskCommand.sliceOf(broken, [facts().runStarted(WHOLE)], WHOLE).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make<unknown, void>((options) => {
              messages.push(options.message)
            }),
          ]),
        ),
      )
      if (slice.kind !== "new" || Option.isNone(slice.died)) throw new Error(`the slice did not die: ${slice.kind}`)
      // The defect is logged, and the start reply says that a new run started instead of the stored one.
      expect(JSON.stringify(messages)).toContain("task harness: the stored run could not be folded")
      expect(JSON.stringify(messages)).toContain(slice.died.value.slice(0, 40))
      // T4.10 re-baselined: the note is the header message's second part.
      expect(TaskCommand.diedLine(slice)).toEqual(
        Option.some(
          `The stored run could not be resumed (${slice.died.value.replace(/\s*\n\s*/g, " | ")}), so a new run started.`,
        ),
      )
      expect(TaskCommand.diedLine({ kind: "new", died: Option.none() })).toEqual(Option.none())
    }),
  )
})

describe("the job of a run (AD-8, SV4, SV21, SV27)", () => {
  // The job of a whole-spec run in the seeded repository: its harness, its fiber, and the job registry's answer.
  // `order` gets one line per lease release and per run removal the job makes, with the lease's state at that moment.
  const started = Effect.fnUntraced(function* (directory: string, order: Array<string> = []) {
    const real = yield* TaskHarness.make
    const held = Effect.map(real.live(directory), (live) => (Option.isSome(live) ? "held" : "free"))
    const harness: TaskHarness.Interface = {
      ...real,
      release: (where, runID) =>
        Effect.flatMap(held, (state) => Effect.sync(() => order.push(`release:${state}`))).pipe(
          Effect.andThen(real.release(where, runID)),
        ),
      removeRun: (runID) =>
        Effect.flatMap(held, (state) => Effect.sync(() => order.push(`removeRun:${state}`))).pipe(
          Effect.andThen(real.removeRun(runID)),
        ),
    }
    const plan = yield* loadPlan("release-notes.spec")
    const id = TaskEvents.runID(directory, SPEC)
    const claimed = yield* harness.claim({ directory, runID: id, spec: SPEC, path: SPEC })
    if (claimed.kind !== "claimed") return yield* Effect.die(new Error("not claimed"))
    const jobs = jobsOf()
    jobs.starts.push({ id, type: "task-harness", run: Effect.succeed("") })
    const { env } = boundary([])
    const background = backgroundOf(jobs)
    const events = yield* EventV2Bridge.Service
    const db = yield* Database.Service
    const fiber = yield* Effect.forkChild(
      TaskCommand.job({
        harness,
        env: { ...env, events, db: db.db, background },
        id,
        directory,
        base: "dev",
        specDir: path.join(directory, SPEC),
        plan: { ...plan, specPath: SPEC, path: SPEC },
        path: SPEC,
        slice: { kind: "new", died: Option.none() },
        externals: [],
        root: SESSION,
        model: { providerID: "test", modelID: "test" },
        limits,
        locks: claimed.locks,
      }),
    )
    const stored = Effect.gen(function* () {
      return (yield* TaskEvents.read(db.db, id)).map((fact) => fact.type)
    })
    yield* eventually(
      Effect.map(stored, (types) => types.includes("run.started")),
      "run.started",
    )
    return { harness: real, id, jobs, fiber, stored }
  })

  it.instance(
    "SV4 a cancelled job records run.cancelled, its supervisor closes, and the next /task is not busy (SV21)",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        yield* git(directory, "branch", "-m", "dev")
        const job = yield* started(directory)
        job.jobs.status = "cancelled"
        yield* Fiber.interrupt(job.fiber)
        expect(yield* job.stored).toContain("run.cancelled")
        expect(yield* job.harness.running(job.id)).toBe(false)
        expect(yield* job.harness.live(directory)).toEqual(Option.none())
      }),
    { git: true },
  )

  it.instance(
    "SV27 a scope that closes without a job cancel records nothing more, frees the lease, and leaves the slice open",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        yield* git(directory, "branch", "-m", "dev")
        const job = yield* started(directory)
        yield* Fiber.interrupt(job.fiber)
        expect(yield* job.stored).not.toContain("run.cancelled")
        expect(yield* job.harness.running(job.id)).toBe(false)
        expect(yield* job.harness.live(directory)).toEqual(Option.none())
        // The next /task of the same path resumes: the slice has not ended.
        const db = yield* Database.Service
        const plan = yield* loadPlan("release-notes.spec")
        const slice = yield* TaskCommand.sliceOf(plan, yield* TaskEvents.read(db.db, job.id), SPEC)
        expect(slice.kind).toBe("resume")
      }),
    { git: true },
  )

  it.instance(
    "frees the lease last: after the cancel finalizer of a cancelled job and after the supervisor's own release",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        yield* git(directory, "branch", "-m", "dev")
        const order: Array<string> = []
        const job = yield* started(directory, order)
        job.jobs.status = "cancelled"
        yield* Fiber.interrupt(job.fiber)
        // run.cancelled made the run done: the supervisor waited for the writer and freed the lease (UI24), then the
        // cancel finalizer removed the run, then the run scope's first finalizer released, last, as a no-op.
        expect(order).toEqual(["release:held", "removeRun:free", "release:free"])
        expect(yield* job.stored).toContain("run.cancelled")
      }),
    { git: true },
  )

  it.instance(
    "frees the lease last after a scope close: the cancel finalizer runs while the lease is still held",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        yield* git(directory, "branch", "-m", "dev")
        const order: Array<string> = []
        const job = yield* started(directory, order)
        yield* Fiber.interrupt(job.fiber)
        expect(order).toEqual(["removeRun:held", "release:held"])
        expect(yield* job.harness.live(directory)).toEqual(Option.none())
      }),
    { git: true },
  )

  it.instance(
    "frees the lease when the job body dies",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        const plan = yield* loadPlan("release-notes.spec")
        const id = TaskEvents.runID(directory, SPEC)
        const claimed = yield* harness.claim({ directory, runID: id, spec: SPEC, path: SPEC })
        if (claimed.kind !== "claimed") return yield* Effect.die(new Error("not claimed"))
        const { env } = boundary([])
        const events = yield* EventV2Bridge.Service
        const db = yield* Database.Service
        // A plan whose run machine cannot be built: the Recorder dies in the job body.
        const broken: Plan = { ...plan, tasks: [...plan.tasks, ...plan.tasks.slice(0, 1)] }
        const exit = yield* Effect.exit(
          TaskCommand.job({
            harness,
            env: { ...env, events, db: db.db },
            id,
            directory,
            base: "dev",
            specDir: path.join(directory, SPEC),
            plan: broken,
            path: SPEC,
            slice: { kind: "new", died: Option.none() },
            externals: [],
            root: SESSION,
            model: { providerID: "test", modelID: "test" },
            limits,
            locks: claimed.locks,
          }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* harness.live(directory)).toEqual(Option.none())
        return yield* Effect.void
      }),
    { git: true },
  )
})

// A task folder of the seeded spec, as `/task` takes it, and as its folder relative to the spec.
const folder = (name: string) => `T1-release-notes.task/${name}`
const SUB = (name: string) => `${SPEC}/${folder(name)}`
const T1_1 = "T1.1-commit-parser.task"
const T1_3 = "T1.3-markdown-render.task"
const T1_4 = "T1.4-command-line.task"
const T1_5 = "T1.5-issue-links.task"

const r12 = (name: string, task: string, other: string) =>
  `R12 ${folder(name)}: ${task} is after ${other}, which is outside this run and not trusted`

// Stored slices on the run's aggregate, oldest first.
const storeSlices = (directory: string, ...slices: ReadonlyArray<ReadonlyArray<Fact>>) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    for (const fact of slices.flat()) yield* TaskEvents.publish(events, TaskEvents.runID(directory, SPEC), fact)
  })

// A whole-spec slice in which T1.1 ended trusted.
const trustedSlice = Effect.gen(function* () {
  const plan = yield* loadPlan("release-notes.spec")
  const f = facts()
  return [f.runStarted(SPEC), ...trustLeaf(plan, f, "T1.1")]
})

describe("a subtree run and the folder tasks outside it (D13, AD-15)", () => {
  it.instance(
    "VF6 refuses the T1.3 subtree with no stored run: one R12 line naming T1.3 and T1.1, then the hint",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const harness = yield* TaskHarness.make
        const jobs = jobsOf()
        expect(yield* runTask(harness, SUB(T1_3), jobs)).toEqual([
          [
            `Refused ${SUB(T1_3)}: 1 failure. No work started.`,
            r12(T1_3, "T1.3", "T1.1"),
            "Run the whole spec, or a folder that holds T1.1.",
          ].join("\n"),
        ])
        expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", reason: r12(T1_3, "T1.3", "T1.1") })
        expect(jobs.starts).toEqual([])
        expect(yield* harness.live(directory)).toEqual(Option.none())
      }),
    { git: true },
  )

  it.instance(
    "names two untrusted folder tasks in natural id order, and the hint names both",
    () =>
      Effect.gen(function* () {
        yield* seeded
        expect(yield* runTask(yield* TaskHarness.make, SUB(T1_4))).toEqual([
          [
            `Refused ${SUB(T1_4)}: 2 failures. No work started.`,
            r12(T1_4, "T1.4", "T1.2"),
            r12(T1_4, "T1.4", "T1.3"),
            "Run the whole spec, or a folder that holds T1.2 and T1.3.",
          ].join("\n"),
        ])
      }),
    { git: true },
  )

  it.instance(
    "VF7 runs the T1.3 subtree after a slice in which T1.1 ended trusted: outside.trusted T1.1 directly after run.started",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const db = yield* Database.Service
        yield* storeSlices(directory, yield* trustedSlice)
        const harness = yield* TaskHarness.make
        const jobs = jobsOf()
        jobs.mode = "run"
        const replies = yield* runTask(harness, SUB(T1_3), jobs)
        expect(replies[0]).toStartWith("Implementing **T1.3 Render the release notes as Markdown** from spec")
        const id = TaskEvents.runID(directory, SPEC)
        const slice = Effect.map(TaskEvents.read(db.db, id), (stored) =>
          Option.getOrElse(TaskEvents.latestRun(stored), (): ReadonlyArray<Fact> => []),
        )
        // The new slice: its run.started names the T1.3 path, and one more fact follows it.
        yield* eventually(
          Effect.map(slice, (list) => {
            const first = list[0]
            return first?.type === "run.started" && first.path === SUB(T1_3) && list.length >= 2
          }),
          "the new slice's first two facts",
        )
        expect((yield* slice).slice(0, 2)).toMatchObject([
          { type: "run.started", path: SUB(T1_3) },
          { type: "outside.trusted", id: "T1.1" },
        ])
        jobs.status = "cancelled"
        for (const fiber of jobs.fibers) yield* Fiber.interrupt(fiber)
      }),
    { git: true },
  )

  it.instance(
    "VF21 a typed /task trust T1.1 never stands in for the folder task's own trust",
    () =>
      Effect.gen(function* () {
        yield* seeded
        const harness = yield* TaskHarness.make
        expect(yield* runTask(harness, "trust T1.1")).toEqual([
          "Task harness: recorded the outside precondition T1.1 as trusted.",
        ])
        expect((yield* runTask(harness, SUB(T1_3)))[0]).toContain(r12(T1_3, "T1.3", "T1.1"))
      }),
    { git: true },
  )

  it.instance(
    "VF20 the latest slice that holds T1.1 decides: trusted, then budget exhausted, is refused",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const f = facts(100)
        yield* storeSlices(directory, yield* trustedSlice, [f.runStarted(SPEC), ...exhaustLeaf(f, "T1.1", "T1.1.c1")])
        expect((yield* runTask(yield* TaskHarness.make, SUB(T1_3)))[0]).toContain(r12(T1_3, "T1.3", "T1.1"))
      }),
    { git: true },
  )

  it.instance(
    "VF21 trusted, then reopened and cancelled, is refused",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const plan = yield* loadPlan("release-notes.spec")
        const f = facts(100)
        yield* storeSlices(directory, yield* trustedSlice, [
          f.runStarted(SPEC),
          ...trustLeaf(plan, f, "T1.1"),
          f.stale("T1.1.c1"),
          f.cancelled("user stop"),
        ])
        expect((yield* runTask(yield* TaskHarness.make, SUB(T1_3)))[0]).toContain(r12(T1_3, "T1.3", "T1.1"))
      }),
    { git: true },
  )

  it.instance(
    "VF21 a later slice whose plan has no T1.1 region does not decide: the T1.3 subtree runs",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const f = facts(100)
        // The T1.4 subtree's plan holds T1.4 and the external regions T1.2 and T1.3, not T1.1.
        yield* storeSlices(directory, yield* trustedSlice, [f.runStarted(SUB(T1_4))])
        const jobs = jobsOf()
        expect((yield* runTask(yield* TaskHarness.make, SUB(T1_3), jobs))[0]).toStartWith(
          "Implementing **T1.3 Render the release notes as Markdown** from spec",
        )
        expect(jobs.starts).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "VF21 an old slice with no path and T1.1 trusted counts as a whole-spec slice: the T1.3 subtree runs",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const plan = yield* loadPlan("release-notes.spec")
        const f = facts()
        yield* storeSlices(directory, [f.runStarted(), ...trustLeaf(plan, f, "T1.1"), f.ended("done")])
        expect((yield* runTask(yield* TaskHarness.make, SUB(T1_3)))[0]).toStartWith(
          "Implementing **T1.3 Render the release notes as Markdown** from spec",
        )
      }),
    { git: true },
  )

  it.instance(
    "a subtree slice that trusted T1.1 as an external region decides too: its own subtree resumes",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
        yield* storeSlices(directory, [
          { type: "run.started", at: 1, base: branch, path: SUB(T1_3) },
          { type: "outside.trusted", at: 2, id: "T1.1" },
        ])
        expect((yield* runTask(yield* TaskHarness.make, SUB(T1_3)))[0]).toStartWith(
          "Implementing **T1.3 Render the release notes as Markdown** from spec",
        )
      }),
    { git: true },
  )

  it.instance(
    "VF24 a newer slice that holds T1.1 decides before an older slice whose path no longer loads",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const f = facts(100)
        yield* storeSlices(directory, [f.runStarted(SUB("T1.9-gone.task"))], yield* trustedSlice)
        expect((yield* runTask(yield* TaskHarness.make, SUB(T1_3)))[0]).toStartWith(
          "Implementing **T1.3 Render the release notes as Markdown** from spec",
        )
      }),
    { git: true },
  )

  it.instance(
    "VF24 a newest slice whose path no longer loads refuses with one plain line naming its path",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const f = facts(100)
        yield* storeSlices(directory, yield* trustedSlice, [f.runStarted(SUB("T1.9-gone.task"))])
        const jobs = jobsOf()
        expect(yield* runTask(yield* TaskHarness.make, SUB(T1_3), jobs)).toEqual([
          [
            `Refused ${SUB(T1_3)}. No work started.`,
            `the stored run of /task ${SUB("T1.9-gone.task")} no longer loads; run the whole spec once to record a newer run`,
          ].join("\n"),
        ])
        expect(jobs.starts).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "the T1.5 subtree with T1.3 trusted: one R12 line for T1.4, and the outside precondition T9 is no refusal",
    () =>
      Effect.gen(function* () {
        const directory = yield* seeded
        const plan = yield* loadPlan("release-notes.spec")
        const f = facts()
        yield* storeSlices(directory, [
          f.runStarted(SPEC),
          ...trustLeaf(plan, f, "T1.1"),
          ...trustLeaf(plan, f, "T1.3"),
        ])
        expect(yield* runTask(yield* TaskHarness.make, SUB(T1_5))).toEqual([
          [
            `Refused ${SUB(T1_5)}: 1 failure. No work started.`,
            r12(T1_5, "T1.5", "T1.4"),
            "Run the whole spec, or a folder that holds T1.4.",
          ].join("\n"),
        ])
      }),
    { git: true },
  )

  it.instance(
    "VF8 a subtree run that leaves scenarios out names them in its start message",
    () =>
      Effect.gen(function* () {
        yield* seeded
        const plan = yield* loadPlan("release-notes.spec")
        // The scenarios that need a task other than T1.1 that is not an outside precondition.
        const leftOut = plan.spec.scenarios
          .filter((scenario) => scenario.needs.some((id) => id !== "T1.1" && !(id in plan.spec.outside)))
          .map((scenario) => scenario.id)
        expect(leftOut.length).toBeGreaterThan(0)
        // T4.10 re-baselined: the header names the task and the spec, and lists the left-out scenarios in its
        // text and its metadata.
        const [reply] = yield* runTaskInputs(yield* TaskHarness.make, SUB(T1_1))
        expect(reply?.parts).toEqual([
          {
            type: "text",
            text: `Implementing **T1.1 Parse a conventional-commit message** from spec **Release notes from conventional commits**\nLeft out: ${leftOut.join(", ")} — they need tasks outside this run.`,
            metadata: {
              taskHarness: {
                header: {
                  spec: { id: "release-notes.spec", title: "Release notes from conventional commits" },
                  task: { id: "T1.1", title: "Parse a conventional-commit message" },
                  leftOut,
                },
              },
            },
          },
        ])
      }),
    { git: true },
  )
})

describe("the plan of a subtree (AD-15)", () => {
  it.live("gives an external region for an after inherited through afterEffective", () =>
    Effect.gen(function* () {
      const whole = yield* loadPlan("release-notes.spec")
      const parent = whole.spec.tasks.find((task) => task.id === "T1.3")
      if (parent === undefined) throw new Error("no T1.3")
      // A child of T1.3 with no `after` of its own inherits T1.3's `after: [T1.1]`.
      const child = { ...parent, id: "T1.3.1", parent: "T1.3", after: [], afterEffective: ["T1.1"], children: [] }
      const spec = { ...whole.spec, tasks: [...whole.spec.tasks, child] }
      const plan = TaskCommand.plan({ spec, specPath: SPEC, path: SPEC, root: Option.some("T1.3.1") })
      expect(plan.tasks.map((task) => task.id)).toEqual(["T1.3.1"])
      expect(plan.external).toEqual(["T1.1"])
    }),
  )
})

describe("the run header (T4.10: UI6, VF8)", () => {
  it.instance(
    "header: a whole-spec run's first message reads Implementing spec and the title, with the header as metadata (UI6)",
    () =>
      Effect.gen(function* () {
        yield* seeded
        const inputs = yield* runTaskInputs(yield* TaskHarness.make, SPEC)
        expect(inputs).toHaveLength(1)
        expect(inputs[0]?.noReply).toBe(true)
        expect(inputs[0]?.parts).toEqual([
          {
            type: "text",
            text: "Implementing spec **Release notes from conventional commits**",
            metadata: {
              taskHarness: {
                header: {
                  spec: { id: "release-notes.spec", title: "Release notes from conventional commits" },
                  leftOut: [],
                },
              },
            },
          },
        ])
      }),
    { git: true },
  )

  it.live(
    "header: an empty H1 falls back to the spec id in the same bold style; the metadata keeps the empty title",
    () =>
      Effect.gen(function* () {
        // The loader refuses an empty H1 (R4), so only a plan built another way reaches this fallback.
        const whole = yield* loadPlan("release-notes.spec")
        const untitled = TaskCommand.header({ ...whole, spec: { ...whole.spec, title: "" } })
        expect(untitled.text).toBe("Implementing spec **release-notes.spec**")
        expect(untitled.metadata).toEqual({
          taskHarness: { header: { spec: { id: "release-notes.spec", title: "" }, leftOut: [] } },
        })
      }),
  )

  it.live("header: status.json carries the title, the spec id when it is empty, and a subtree run's task", () =>
    Effect.gen(function* () {
      const whole = yield* loadPlan("release-notes.spec")
      const started = facts().runStarted()
      const project = (plan: Plan) => TaskStatus.project(plan, fold(plan, [started]))
      const status = project(whole)
      expect(status.run.title).toBe("Release notes from conventional commits")
      expect("task" in status.run).toBe(false)
      expect(project({ ...whole, spec: { ...whole.spec, title: "" } }).run.title).toBe("release-notes.spec")
      const subtree = yield* loadPlan("release-notes.spec", "T1.2")
      expect(project(subtree).run.task).toEqual({ id: "T1.2", title: "Compute the next version" })
      expect(TaskCommand.header(subtree).text).toStartWith(
        "Implementing **T1.2 Compute the next version** from spec **Release notes from conventional commits**",
      )
    }),
  )

  test("header: the reply rides the Ops text parts with their metadata; src/task imports no SessionPrompt", async () => {
    const files = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: path.join(import.meta.dir, "../../src/task") }))
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const text = await Bun.file(path.join(import.meta.dir, "../../src/task", file)).text()
      expect({ file, imports: /from "@\/session\/prompt"/.test(text) }).toEqual({ file, imports: false })
    }
    // SessionPrompt's taskOps hands the parts on whole, metadata included.
    const prompt = await Bun.file(path.join(import.meta.dir, "../../src/session/prompt.ts")).text()
    const ops = prompt.slice(prompt.indexOf("const taskOps: TaskOps.Ops = {"), prompt.indexOf("cancel: (sessionID) =>"))
    expect(ops).toContain("parts: input.parts,")
  })
})
