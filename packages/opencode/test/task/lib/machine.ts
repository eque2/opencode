import { Effect, Option } from "effect"
import path from "path"
import { initialTransition, transition } from "@jambudipa/xstate-effect"
import { Blend } from "@/task/blend"
import { TaskCommand } from "@/task/core/command"
import type { Fact, Plan, Result, Verdict } from "@/task/core/model"
import { TaskMachine } from "@/task/engine-xstate/machine"

// Helpers for the run machine tests: plans loaded from `task-formats/blend`, fact builders with a clock, a fold
// through the pure `transition`, and reads of a snapshot's unit states.

const formatDir = path.resolve(import.meta.dir, "../../../../../task-formats/blend")

/** The plan of `/task task-formats/blend/<name>`, or of the task folder `root` inside it. */
export const loadPlan = (name: string, root?: string) =>
  Effect.gen(function* () {
    const loaded = yield* Blend.load(path.join(formatDir, name))
    if (!loaded.spec) return yield* Effect.die(`${name} did not load: ${JSON.stringify(loaded.failures)}`)
    const specPath = `task-formats/blend/${name}`
    return TaskCommand.plan({ spec: loaded.spec, specPath, path: specPath, root: Option.fromNullishOr(root) })
  })

export const pass = (id: string): Result => ({ id, status: "passed" })
export const judge = (id: string): Result => ({ id, status: "needs-judge" })
export const fail = (id: string, reason: string): Result => ({ id, status: "failed", reason })
export const trust = (id: string): Verdict => ({ id, verdict: "trusted" })
export const reject = (id: string, reason: string): Verdict => ({ id, verdict: "rejected", reason })

/** Fact builders that stamp each fact with the next tick of their own clock, from `start + 1`. */
export const facts = (start = 0) => {
  let clock = start
  const at = () => ++clock
  return {
    runStarted: (): Fact => ({ type: "run.started", at: at() }),
    runResumed: (): Fact => ({ type: "run.resumed", at: at() }),
    started: (task: string): Fact => ({
      type: "task.started",
      at: at(),
      task,
      worktree: `/wt/${task}`,
      branch: `task/${task}`,
      base: "base0",
      session: `ses_${task}`,
    }),
    ready: (task: string, head = "head1"): Fact => ({ type: "task.ready", at: at(), task, head }),
    proved: (task: string, results: ReadonlyArray<Result>, reason?: string): Fact => ({
      type: "task.proved",
      at: at(),
      task,
      results,
      ...(reason === undefined ? {} : { reason }),
    }),
    verified: (task: string, verdicts: ReadonlyArray<Verdict>): Fact => ({ type: "task.verified", at: at(), task, verdicts }),
    stalled: (task: string, reason: string): Fact => ({ type: "task.stalled", at: at(), task, reason }),
    repeated: (task: string, reason: string): Fact => ({ type: "task.repeated", at: at(), task, reason }),
    needsHuman: (task: string, reason: string): Fact => ({ type: "task.needs_human", at: at(), task, reason }),
    failed: (task: string, reason: string): Fact => ({ type: "task.failed", at: at(), task, reason }),
    stale: (id: string, hash = "hash2"): Fact => ({ type: "obligation.stale", at: at(), id, hash }),
    outside: (id: string): Fact => ({ type: "outside.trusted", at: at(), id }),
    scenarioProved: (id: string, status: "passed" | "failed", reason?: string): Fact => ({
      type: "scenario.proved",
      at: at(),
      id,
      status,
      ...(reason === undefined ? {} : { reason }),
    }),
    scenarioVerified: (verdict: Verdict): Fact => ({ type: "scenario.verified", at: at(), verdict }),
    cancelled: (reason: string): Fact => ({ type: "run.cancelled", at: at(), reason }),
    ended: (state: "done" | "failed", reason?: string): Fact => ({
      type: "run.ended",
      at: at(),
      state,
      ...(reason === undefined ? {} : { reason }),
    }),
  }
}

export type Facts = ReturnType<typeof facts>

/** The obligations of a task in a plan, in plan order. */
export const obligationsOf = (plan: Plan, task: string) =>
  plan.spec.obligations.filter((obligation) => obligation.task === task).map((obligation) => obligation.id)

/** A leaf built, proved with every obligation passed, and verified: it ends trusted on its first attempt. */
export const trustLeaf = (plan: Plan, f: Facts, task: string): ReadonlyArray<Fact> => [
  f.started(task),
  f.ready(task),
  f.proved(task, obligationsOf(plan, task).map(pass)),
  f.verified(task, []),
]

/** A leaf built three times, each proof failing one obligation: with a budget of 3 it ends budget exhausted. */
export const exhaustLeaf = (f: Facts, task: string, obligation: string, attempts = 3): ReadonlyArray<Fact> => [
  f.started(task),
  ...Array.from({ length: attempts }, () => [
    f.ready(task),
    f.proved(task, [fail(obligation, "the test asserts only that 'topic change' appears")]),
  ]).flat(),
]

/**
 * The observed release-notes facts: the run starts, T1.1 to T1.3 become trusted, and T1.4 fails its proof on each
 * of its three attempts.
 */
export const observed = (plan: Plan, f: Facts = facts()): ReadonlyArray<Fact> => [
  f.runStarted(),
  ...trustLeaf(plan, f, "T1.1"),
  ...trustLeaf(plan, f, "T1.2"),
  ...trustLeaf(plan, f, "T1.3"),
  ...exhaustLeaf(f, "T1.4", "T1.4.c7"),
]

/** The first snapshot of a plan's machine. */
export const first = (plan: Plan) => Effect.runSync(initialTransition(TaskMachine.machine(plan)))[0]

export type RunSnapshot = ReturnType<typeof first>

/** One fact through the pure transition. */
export const step = (plan: Plan, snapshot: RunSnapshot, fact: Fact) =>
  Effect.runSync(transition(TaskMachine.machine(plan), snapshot, fact))[0]

/** Facts folded from the first snapshot through the pure transition. */
export const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = first(plan)) =>
  list.reduce((snapshot, fact) => step(plan, snapshot, fact), from)

type Value = { readonly [key: string]: unknown }
const isValue = (value: unknown): value is Value => typeof value === "object" && value !== null

const valueAt = (value: unknown, ...keys: ReadonlyArray<string>) =>
  keys.reduce((current, key) => (isValue(current) ? current[key] : undefined), value)

/** The machine state of a unit: a task's work state, or a scenario's, outside or external region's state. */
export const unitState = (snapshot: RunSnapshot, id: string) => {
  const region = valueAt(snapshot.value, "active", TaskMachine.key(id))
  if (typeof region === "string") return region
  return String(valueAt(region, "work"))
}

/** The machine state of an obligation of a task. */
export const obligationState = (snapshot: RunSnapshot, id: string) => {
  const task = id.slice(0, id.lastIndexOf("."))
  return String(valueAt(snapshot.value, "active", TaskMachine.key(task), "evidence", TaskMachine.key(id)))
}

/** The state of the outcome region. */
export const outcome = (snapshot: RunSnapshot) => String(valueAt(snapshot.value, "outcome"))
