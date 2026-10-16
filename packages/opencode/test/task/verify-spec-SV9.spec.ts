import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Duration, Effect, Fiber, FileSystem, Layer, Option } from "effect"
import fs from "node:fs"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import { TaskHooks } from "@/task/core/hooks"
import type { Fact, Plan } from "@/task/core/model"
import type { TaskOps } from "@/task/core/ops"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { TaskAlphabet } from "@/task/engine-xstate/alphabet"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { git, type Jobs, jobsOf, SESSION, services } from "./lib/command"
import { facts, trustLeaf } from "./lib/machine"
import { eventually } from "./lib/supervise"

// Scenario SV9 (spec task-harness-feedback, AD-7, AD-8; tasks T2.8, T2.9, T2.10): supervisors record only facts the
// progress alphabet allows.
//
//   Given each unit kind in each state
//   When its supervisor records a fact
//   Then the fact is in the progress alphabet for that state, or is a stall, a nudge, a run start, a resume, a spec
//   check, a run-level stop or a stale obligation
//
// Each test is a real `/task` run in a seeded git instance: the real command, harness root, Recorder, run, task and
// scenario supervisors, workers, proofs (`bun test` in the worktrees and on the base branch) and merges. Only the
// session side is scripted: a builder writes its leaf's files and calls `task_ready`, ends its turn silently, repeats
// a tool call or never ends; a judge trusts each id it is asked about. The scripted side acts through the real hook
// routing of the harness root (`TaskHooks.sendReady`, `sendVerdicts`, `repetitionStop` on `harness.hooks`).
//
// Every fact a run stores was recorded by one of its supervisors (the Recorder is the only way in, SV7). So the test
// replays the stored facts through the pure fold and checks each one against `TaskAlphabet.alphabet` of the snapshot
// just before it. The alphabet's payloads are abstract by design (AD-7), so a fact is in the alphabet of its state
// when that alphabet holds a fact of the same type for the same unit. The alphabet keys an external region's trust on
// the start-up step (an empty log); a real run records it in its start-up step straight after `run.started`, so an
// external trust passes only there and only when the empty-log alphabet holds it.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SEED = path.resolve(import.meta.dir, "../task-harness/release-notes-repo")
const FORMATS = path.resolve(import.meta.dir, "../../../../task-formats/blend")
const RUN_MS = 120_000

// --- the replay check ---------------------------------------------------------------------------------------------

const EXCEPTIONS: ReadonlyArray<Fact["type"]> = [
  "task.stalled",
  "task.nudged",
  "run.started",
  "run.resumed",
  "spec.checked",
  "run.cancelled",
  "run.ended",
  "obligation.stale",
]

const unitOf = (fact: Fact): string => {
  switch (fact.type) {
    case "scenario.proved":
    case "outside.trusted":
    case "obligation.stale":
      return fact.id
    case "scenario.verified":
      return fact.verdict.id
    default:
      return "task" in fact ? fact.task : "run"
  }
}

const PHASES = ["ready", "building", "proving", "verifying", "waiting"]

// A unit's kind and state tag in a snapshot: `leaf:building`, `parent:ready`, `scenario:verifying`, `outside:waiting`.
const where = (snapshot: RunSnapshot, unit: string) => {
  const slot = snapshot.context.units[unit]
  const kind = slot?.kind === "task" ? (slot.leaf ? "leaf" : "parent") : (slot?.kind ?? "run")
  const phase = PHASES.find((tag) => snapshot.hasTag(`${unit}:${tag}`)) ?? TaskEngineXState.unitState(snapshot, unit)
  return `${kind}:${phase ?? "-"}`
}

interface Checked {
  readonly fact: string
  readonly at: string
  readonly by: "alphabet" | "start-up" | "exception" | "NOT ALLOWED"
}

// Replays one slice's facts from the plan's first snapshot and checks each fact against the snapshot before it.
const check = (plan: Plan, list: ReadonlyArray<Fact>) => {
  const start = TaskEngineXState.initial(plan)
  let snapshot = start
  let startup = true
  const checked: Array<Checked> = []
  for (const fact of list) {
    const unit = unitOf(fact)
    const same = (other: Fact) => other.type === fact.type && unitOf(other) === unit
    const external = fact.type === "outside.trusted" && plan.external.includes(unit)
    const by: Checked["by"] = EXCEPTIONS.includes(fact.type)
      ? "exception"
      : TaskAlphabet.alphabet(snapshot).some(same)
        ? "alphabet"
        : startup &&
            external &&
            TaskEngineXState.unitState(snapshot, unit) === "untrusted" &&
            TaskAlphabet.alphabet(start).some(same)
          ? "start-up"
          : "NOT ALLOWED"
    checked.push({ fact: `${fact.type} ${unit}`, at: where(snapshot, unit), by })
    // The start-up step: the job's first fact and the external trusts straight after it.
    if (!(fact.type === "run.started" || fact.type === "run.resumed" || external)) startup = false
    snapshot = TaskEngineXState.apply(plan, snapshot, fact)
  }
  return { checked, snapshot }
}

const covered = (checked: ReadonlyArray<Checked>) =>
  [
    ...new Set(checked.filter((item) => item.by === "alphabet" || item.by === "start-up").map((item) => item.at)),
  ].toSorted()

// --- the scripted session side ----------------------------------------------------------------------------------

/** What one builder turn does: write the leaf's files and call task_ready (optionally after a stray verdict), end
 * silently, repeat one tool call three times, or never end. Past the end of a unit's list, a turn is `ready`. */
type Act = "ready" | "stray" | "silent" | "repeat" | "hang"

interface Script {
  readonly runID: string
  readonly acts: Readonly<Record<string, ReadonlyArray<Act>>>
  readonly leaves: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** A judge also sends a stray task_ready and repetition before its verdicts. */
  readonly strayJudge?: boolean
}

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the command and the workers never read a turn's last message
const ANSWER = {} as SessionV1.WithParts

const opsOf = (
  harness: TaskHarness.Interface,
  db: Database.Interface["db"],
  script: Script,
  replies: Array<string>,
) => {
  const turns: Record<string, number> = {}
  const builder = (session: string) =>
    Effect.gen(function* () {
      const started = (yield* TaskEvents.read(db, script.runID)).findLast(
        (fact) => fact.type === "task.started" && fact.session === session,
      )
      if (started === undefined || started.type !== "task.started")
        return yield* Effect.die(new Error(`no task.started for ${session}`))
      const unit = started.task
      const turn = (turns[unit] = (turns[unit] ?? 0) + 1)
      const act = script.acts[unit]?.[turn - 1] ?? "ready"
      if (act === "hang") return yield* Effect.never
      if (act === "silent") return yield* Effect.void
      if (act === "repeat") {
        const calls = Array.from({ length: 3 }, () => ({ tool: "bash", input: { command: "ls" } }))
        yield* TaskHooks.repetitionStop(harness.hooks, session, calls)
        return yield* Effect.void
      }
      if (act === "stray") yield* TaskHooks.sendVerdicts(harness.hooks, session, [{ id: unit, verdict: "trusted" }])
      for (const [file, content] of Object.entries(script.leaves[unit] ?? {})) {
        fs.mkdirSync(path.dirname(path.join(started.worktree, file)), { recursive: true })
        fs.writeFileSync(path.join(started.worktree, file), content)
      }
      yield* TaskHooks.sendReady(harness.hooks, session, { summary: `${unit}: the files are written.` })
      return yield* Effect.void
    })
  const judge = (session: string, text: string) =>
    Effect.gen(function* () {
      const ids = text
        .split("\n")
        .filter((line) => line.startsWith("judge "))
        .map((line) => line.slice("judge ".length, line.indexOf(":")))
      if (script.strayJudge) {
        yield* TaskHooks.sendReady(harness.hooks, session, {})
        yield* harness.hooks.send({ type: "hook.repeated", session, reason: "repetition: 3 identical bash calls" })
      }
      yield* TaskHooks.sendVerdicts(
        harness.hooks,
        session,
        ids.map((id) => ({ id, verdict: "trusted" as const })),
      )
    })
  const ops: TaskOps.Ops = {
    prompt: (input) => {
      const text = input.parts.map((part) => part.text).join("\n")
      if (input.sessionID === SESSION) return Effect.sync(() => replies.push(text)).pipe(Effect.as(ANSWER))
      const turn = input.agent === TaskHooks.BUILDER ? builder(input.sessionID) : judge(input.sessionID, text)
      return turn.pipe(Effect.orDie, Effect.as(ANSWER))
    },
    cancel: () => Effect.void,
    currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
    say: () => Effect.void,
  }
  return ops
}

// --- the instance -----------------------------------------------------------------------------------------------

// The demo seed (an empty src/ and test/) and the spec folder, committed in the instance's repository.
const seeded = (folder: string) =>
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem
    const directory = (yield* TestInstance).directory
    for (const name of ["package.json", "tsconfig.json"])
      yield* files.copyFile(path.join(SEED, name), path.join(directory, name))
    for (const name of ["src", "test"]) yield* files.copy(path.join(SEED, name), path.join(directory, name))
    yield* files.copy(path.join(FORMATS, folder), path.join(directory, "task-formats/blend", folder))
    yield* git(directory, "add", "-A")
    yield* git(directory, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "seed")
    return directory
  })

// The plan the command builds for `/task <args>`, from the instance's copy of the spec.
const planOf = (directory: string, specPath: string, args: string, root?: string) =>
  Effect.gen(function* () {
    const loaded = yield* Blend.load(path.join(directory, specPath))
    if (!loaded.spec) return yield* Effect.die(new Error(`${specPath} did not load`))
    return TaskCommand.plan({ spec: loaded.spec, specPath, path: args, root: Option.fromNullishOr(root) })
  })

const task = (harness: TaskHarness.Interface, args: string, jobs: Jobs, ops: TaskOps.Ops) =>
  TaskCommand.run({ sessionID: SESSION, arguments: args }, ops, harness).pipe(Effect.provide(services(jobs)))

// Waits until the job of the run (on its own fiber, as the registry runs it) has ended.
const ended = (jobs: Jobs) =>
  Effect.gen(function* () {
    const fiber = jobs.fibers[0]
    if (fiber === undefined) return yield* Effect.die(new Error("no job ran"))
    return yield* Fiber.await(fiber).pipe(Effect.timeout(Duration.millis(RUN_MS)))
  })

const SLUG = [
  "export const slugify = (title: string): string =>",
  '  title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")',
  "",
].join("\n")

const SLUG_TEST = [
  'import { expect, test } from "bun:test"',
  'import { slugify } from "../src/slug"',
  "",
  'test("[T1.1.c1] slugify gives the slug of a title", () => {',
  '  expect(slugify("Hello, World!")).toBe("hello-world")',
  '  expect(slugify(" v1.2.0 ")).toBe("v1-2-0")',
  '  expect(slugify("!!!")).toBe("")',
  "})",
  "",
  'test("[S1] a release title becomes its slug", () => {',
  '  expect(slugify("Release 2.0: Faster Notes!")).toBe("release-2-0-faster-notes")',
  "})",
  "",
].join("\n")

const CLAMP =
  "export const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))\n"

const CLAMP_TEST = [
  'import { expect, test } from "bun:test"',
  'import { clamp } from "../src/clamp"',
  "",
  'test("[T1.3.c1] clamp keeps a number inside its range", () => {',
  "  expect(clamp(5, 0, 3)).toBe(3)",
  "  expect(clamp(-1, 0, 3)).toBe(0)",
  "  expect(clamp(2, 0, 3)).toBe(2)",
  "})",
  "",
].join("\n")

// --- the runs -------------------------------------------------------------------------------------------------------

it.instance(
  "[SV9] example-scenarios: each fact of a leaf, a parent and a scenario in each of its states is in the alphabet of that state",
  () =>
    Effect.gen(function* () {
      const folder = "example-scenarios.spec"
      const specPath = `task-formats/blend/${folder}`
      const directory = yield* seeded(folder)
      const db = (yield* Database.Service).db
      const harness = yield* TaskHarness.make
      const runID = TaskEvents.runID(directory, specPath)
      const jobs = jobsOf()
      jobs.mode = "run"
      const replies: Array<string> = []
      // The builder first sends a stray verdict; each judge first sends a stray task_ready and repetition.
      const ops = opsOf(
        harness,
        db,
        {
          runID,
          acts: { "T1.1": ["stray"] },
          leaves: { "T1.1": { "src/slug.ts": SLUG, "test/slug.test.ts": SLUG_TEST } },
          strayJudge: true,
        },
        replies,
      )
      yield* task(harness, specPath, jobs, ops)
      expect(replies[0]).toStartWith("Implementing spec")
      yield* ended(jobs)

      const stored = yield* TaskEvents.read(db, runID)
      const { checked, snapshot } = check(yield* planOf(directory, specPath, specPath), stored)
      // The run went the whole way: every unit trusted, the run done.
      expect(TaskEngineXState.view(snapshot).run.state).toBe("done")
      for (const unit of ["T1.1", "T1", "S1"]) expect(TaskEngineXState.unitState(snapshot, unit)).toBe("trusted")
      // Then each fact is in the progress alphabet of its unit's state, or is one of the exceptions.
      expect(checked.filter((item) => item.by === "NOT ALLOWED")).toEqual([])
      expect(checked.filter((item) => item.by === "exception").map((item) => item.fact)).toEqual(["run.started run"])
      // Given each unit kind in each state that has a supervisor's fact.
      expect(covered(checked)).toEqual([
        "leaf:building",
        "leaf:proving",
        "leaf:ready",
        "leaf:verifying",
        "parent:ready",
        "parent:verifying",
        "scenario:ready",
        "scenario:verifying",
      ])
    }),
  { git: true },
  150_000,
)

it.instance(
  "[SV9] example-cascade: nudges, an unready proof, a repetition and a budget exhausted record only allowed facts",
  () =>
    Effect.gen(function* () {
      const folder = "example-cascade.spec"
      const specPath = `task-formats/blend/${folder}`
      const directory = yield* seeded(folder)
      const db = (yield* Database.Service).db
      const harness = yield* TaskHarness.make
      const runID = TaskEvents.runID(directory, specPath)
      const jobs = jobsOf()
      jobs.mode = "run"
      // T1.1 never calls task_ready: two nudges, then its work is proved failed and its one attempt is spent. T1.3
      // repeats itself on its first attempt and builds on its second.
      const ops = opsOf(
        harness,
        db,
        {
          runID,
          acts: { "T1.1": ["silent", "silent", "silent"], "T1.3": ["repeat", "ready"] },
          leaves: { "T1.3": { "src/clamp.ts": CLAMP, "test/clamp.test.ts": CLAMP_TEST } },
        },
        [],
      )
      yield* task(harness, specPath, jobs, ops)
      yield* ended(jobs)

      const stored = yield* TaskEvents.read(db, runID)
      const { checked, snapshot } = check(yield* planOf(directory, specPath, specPath), stored)
      expect(TaskEngineXState.unitState(snapshot, "T1.1")).toBe("budget_exhausted")
      expect(TaskEngineXState.unitState(snapshot, "T1.2")).toBe("blocked")
      expect(TaskEngineXState.unitState(snapshot, "T1")).toBe("blocked")
      expect(TaskEngineXState.unitState(snapshot, "T1.3")).toBe("trusted")
      expect(TaskEngineXState.view(snapshot).run.state).toBe("budget_exhausted")
      expect(checked.filter((item) => item.by === "NOT ALLOWED")).toEqual([])
      // The nudges are the exceptions the Gherkin names; the repetition and the unready proof are in the alphabet.
      expect(checked.filter((item) => item.by === "exception").map((item) => item.fact)).toEqual([
        "run.started run",
        "task.nudged T1.1",
        "task.nudged T1.1",
      ])
      expect(checked).toContainEqual({ fact: "task.repeated T1.3", at: "leaf:building", by: "alphabet" })
      expect(checked).toContainEqual({ fact: "task.ready T1.1", at: "leaf:building", by: "alphabet" })
      expect(checked).toContainEqual({ fact: "task.proved T1.1", at: "leaf:proving", by: "alphabet" })
      expect(covered(checked)).toEqual(["leaf:building", "leaf:proving", "leaf:ready", "leaf:verifying"])
    }),
  { git: true },
  150_000,
)

it.instance(
  "[SV9] release-notes T1.5: external trusts at start-up, a forwarded outside trust, spec checks and a cancel are allowed",
  () =>
    Effect.gen(function* () {
      const folder = "release-notes.spec"
      const specPath = `task-formats/blend/${folder}`
      const subtree = `${specPath}/T1-release-notes.task/T1.5-issue-links.task`
      const directory = yield* seeded(folder)
      const db = (yield* Database.Service).db
      const events = yield* EventV2Bridge.Service
      const harness = yield* TaskHarness.make
      const runID = TaskEvents.runID(directory, specPath)
      const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
      // A stored whole-spec run in which T1.1 to T1.4 became trusted: the subtree run of T1.5 may start (D13).
      const whole = yield* planOf(directory, specPath, specPath)
      const f = facts()
      const before: ReadonlyArray<Fact> = [
        { type: "run.started", at: 0, base: branch, path: specPath },
        ...["T1.1", "T1.2", "T1.3", "T1.4"].flatMap((id) => trustLeaf(whole, f, id)),
      ]
      for (const fact of before) yield* TaskEvents.publish(events, runID, fact)
      const jobs = jobsOf()
      jobs.mode = "run"
      // T1.5's builder never ends its turn, so the run stays live until it is cancelled.
      const ops = opsOf(harness, db, { runID, acts: { "T1.5": ["hang"] }, leaves: {} }, [])
      const replies: Array<string> = []
      const say = opsOf(harness, db, { runID, acts: {}, leaves: {} }, replies)
      yield* task(harness, subtree, jobs, ops)
      const slice = Effect.map(TaskEvents.read(db, runID), (list) => list.slice(before.length))
      const has = (what: string, probe: (list: ReadonlyArray<Fact>) => boolean) =>
        eventually(Effect.map(slice, probe), what)
      yield* has("the external trusts", (list) => list.filter((fact) => fact.type === "outside.trusted").length === 2)

      // A trust of the outside T9, forwarded to the live run; trusts of an external region and of a task record nothing.
      for (const id of ["T1.4", "T1.5", "T9"]) yield* task(harness, `trust ${id}`, jobs, say)
      yield* has("T1.5 started", (list) => list.some((fact) => fact.type === "task.started"))
      // The spec stops validating, then validates again: two spec checks.
      const verify = path.join(directory, specPath, "T1-release-notes.task/T1.1-commit-parser.task/VERIFY.md")
      const text = fs.readFileSync(verify, "utf8")
      fs.writeFileSync(verify, text.replace("category: happy-path", "category: nonsense"))
      yield* has("the failing spec check", (list) => list.some((fact) => fact.type === "spec.checked"))
      fs.writeFileSync(verify, text)
      yield* has("the clearing spec check", (list) => list.filter((fact) => fact.type === "spec.checked").length === 2)
      // The run is cancelled.
      jobs.status = "cancelled"
      for (const fiber of jobs.fibers) yield* Fiber.interrupt(fiber)

      const stored = yield* slice
      const { checked } = check(yield* planOf(directory, specPath, subtree, "T1.5"), stored)
      expect(checked.filter((item) => item.by === "NOT ALLOWED")).toEqual([])
      expect(checked.map((item) => [item.fact, item.at, item.by])).toEqual([
        ["run.started run", "run:waiting", "exception"],
        ["outside.trusted T1.3", "external:waiting", "start-up"],
        ["outside.trusted T1.4", "external:waiting", "start-up"],
        ["outside.trusted T9", "outside:waiting", "alphabet"],
        ["task.started T1.5", "leaf:ready", "alphabet"],
        ["spec.checked run", "run:running", "exception"],
        ["spec.checked run", "run:running", "exception"],
        ["run.cancelled run", "run:running", "exception"],
      ])
      expect(replies).toContain("Task harness: recorded the outside precondition T9 as trusted.")
    }),
  { git: true },
  150_000,
)

// The check's own negative control: facts that no supervisor may record in their unit's state are found.
it.live(
  "[SV9] the replay check finds a fact outside the alphabet of its state, and an external trust after start-up",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      yield* fs.copy(path.join(FORMATS, "release-notes.spec"), path.join(directory, "release-notes.spec"))
      const whole = yield* planOf(directory, "release-notes.spec", "release-notes.spec")
      const f = facts()
      const wrong = check(whole, [
        f.runStarted(),
        f.started("T1.1"),
        // A verdict for a building task, a proof for a task that has not started, a start for a task that waits.
        f.verified("T1.1", [{ id: "T1.1.c1", verdict: "trusted" }]),
        f.proved("T1.2", [{ id: "T1.2.c1", status: "passed" }]),
        f.started("T1.4"),
        // A scenario judged while it waits on its needs.
        f.scenarioVerified({ id: "S2", verdict: "trusted" }),
      ])
      expect(wrong.checked.map((item) => [item.fact, item.by])).toEqual([
        ["run.started run", "exception"],
        ["task.started T1.1", "alphabet"],
        ["task.verified T1.1", "NOT ALLOWED"],
        ["task.proved T1.2", "NOT ALLOWED"],
        ["task.started T1.4", "NOT ALLOWED"],
        ["scenario.verified S2", "NOT ALLOWED"],
      ])
      // An external region's trust passes only in the start-up step.
      const subtree = yield* planOf(directory, "release-notes.spec", "release-notes.spec", "T1.5")
      const g = facts()
      const late = check(subtree, [g.runStarted(), g.outside("T1.3"), g.outside("T9"), g.outside("T1.4")])
      expect(late.checked.map((item) => [item.fact, item.by])).toEqual([
        ["run.started run", "exception"],
        ["outside.trusted T1.3", "start-up"],
        ["outside.trusted T9", "alphabet"],
        ["outside.trusted T1.4", "NOT ALLOWED"],
      ])
    }),
)
