import { Predicate } from "effect"
import type { Fact, Plan } from "@/task/core/model"
import { type RunSnapshot, type Slot, TaskMachine } from "./machine"

// The progress alphabet and the walk key of the graph proof (spine AD-7). The proof walks every state of the run
// machine that the facts of a live run can reach, and requires that every state that is not done has a fact that
// moves it. So the alphabet holds what a supervisor records for a unit in a given state, with abstract payloads, and
// nothing that moves every state at once:
//
// - a ready task: its start (`task.started` for a leaf, its review proof for a parent) and `task.failed`;
// - a task in work: the outcomes of its phase (results all passed or one failed, verdicts all trusted or one
//   rejected, `task.ready`, the repetition, `task.needs_human`, `task.failed`);
// - a ready scenario: its passed proof; a verifying scenario: its trusted verdict (a scenario has no dependant, so
//   its failures cannot make a state stuck; the unit tests cover them);
// - an untrusted `outside` region: its trust; an `external` region: its trust in the start-up step only (AD-15).
//
// It never holds `run.cancelled`, `run.ended`, `task.stalled` or `task.nudged`, and every fact has the same `at`.
// The key lists each unit by its machine state, never its status name (which merges `ready` with `waiting`).

/** The time of every fact of the alphabet. */
export const AT = 1

/** The context paths that the machine's guards read: the walk key covers each one. */
export const KEYED: ReadonlyArray<string> = ["units", "log", "stop"]

const REASON = "walk"

type Valued = { readonly [key: string]: unknown }
const isValued = (value: unknown): value is Valued => Predicate.isObject(value)
const empty: Valued = {}

const valueAt = (value: unknown, ...keys: ReadonlyArray<string>): unknown =>
  keys.reduce((current: unknown, name) => (isValued(current) ? current[name] : empty), value)

/** A unit's machine state key: a task's work state, an obligation's state, or a region's state. */
const machineState = (snapshot: RunSnapshot, id: string, slot: Slot) => {
  const at = (...keys: ReadonlyArray<string>) => String(valueAt(snapshot.value, "active", ...keys))
  if (slot.kind === "task") return at(TaskMachine.key(id), "work")
  if (slot.kind === "obligation") return at(TaskMachine.key(slot.task ?? ""), "evidence", TaskMachine.key(id))
  return at(TaskMachine.key(id))
}

const taskFacts = (id: string, slot: Slot, own: ReadonlyArray<string>, tagged: (tag: string) => boolean) => {
  const failed: Fact = { type: "task.failed", at: AT, task: id, reason: REASON }
  const needsHuman: Fact = { type: "task.needs_human", at: AT, task: id, reason: REASON }
  if (tagged("ready")) {
    const start: Fact = slot.leaf
      ? {
          type: "task.started",
          at: AT,
          task: id,
          worktree: `/walk/${id}`,
          branch: `walk/${id}`,
          base: REASON,
          session: id,
        }
      : { type: "task.proved", at: AT, task: id, results: [] }
    return [start, failed]
  }
  if (tagged("building"))
    return [
      { type: "task.ready", at: AT, task: id, head: REASON },
      { type: "task.repeated", at: AT, task: id, reason: REASON },
      needsHuman,
      failed,
    ] satisfies ReadonlyArray<Fact>
  if (tagged("proving")) {
    const passed: Fact = {
      type: "task.proved",
      at: AT,
      task: id,
      results: own.map((obligation) => ({ id: obligation, status: "passed" })),
    }
    const first = own[0]
    const one: ReadonlyArray<Fact> =
      first === undefined
        ? []
        : [{ type: "task.proved", at: AT, task: id, results: [{ id: first, status: "failed", reason: REASON }] }]
    return [passed, ...one, needsHuman, failed]
  }
  if (tagged("verifying")) {
    const trusted: Fact = {
      type: "task.verified",
      at: AT,
      task: id,
      verdicts: own.map((obligation) => ({ id: obligation, verdict: "trusted" })),
    }
    const first = own[0]
    const one: ReadonlyArray<Fact> =
      first === undefined
        ? []
        : [{ type: "task.verified", at: AT, task: id, verdicts: [{ id: first, verdict: "rejected", reason: REASON }] }]
    return [trusted, ...one, needsHuman, failed]
  }
  return []
}

/** The facts that can move the run from this snapshot, as a supervisor would record them. */
export const alphabet = (snapshot: RunSnapshot): ReadonlyArray<Fact> => {
  const units = Object.entries(snapshot.context.units)
  const startup = snapshot.context.log.length === 0
  const own = (task: string) =>
    units.filter(([, slot]) => slot.kind === "obligation" && slot.task === task).map(([id]) => id)
  return units.flatMap(([id, slot]): ReadonlyArray<Fact> => {
    const tagged = (tag: string) => snapshot.hasTag(`${id}:${tag}`)
    switch (slot.kind) {
      case "task":
        return taskFacts(id, slot, own(id), tagged)
      case "scenario":
        if (tagged("ready")) return [{ type: "scenario.proved", at: AT, id, status: "passed" }]
        if (tagged("verifying")) return [{ type: "scenario.verified", at: AT, verdict: { id, verdict: "trusted" } }]
        return []
      case "outside":
        return tagged("waiting") ? [{ type: "outside.trusted", at: AT, id }] : []
      case "external":
        return startup && tagged("waiting") ? [{ type: "outside.trusted", at: AT, id }] : []
      default:
        return []
    }
  })
}

/**
 * The key of a snapshot in the walk: each unit in plan order by its machine state; a task that has not ended adds
 * its attempts and its obligations' states; the state of the first death and the noted stop, which the outcome's
 * guards read.
 * The main walk keys an ended task by its state alone. The stale walk (`stale`) keeps an ended task's full key and
 * keys the obligations of a dead or blocked task as `-`.
 */
export const walkKey =
  (plan: Plan, mode: "main" | "stale" = "main") =>
  (snapshot: RunSnapshot): string => {
    const context = snapshot.context
    const units = Object.entries(context.units)
    const parts = units.flatMap(([id, slot]) => {
      if (slot.kind === "obligation" || slot.kind === "run") return []
      const state = machineState(snapshot, id, slot)
      if (slot.kind !== "task") return [`${id}:${state}`]
      const ended = snapshot.hasTag(`${id}:ended`)
      if (ended && mode === "main") return [`${id}:${state}`]
      const stopped = snapshot.hasTag(`${id}:dead`) || snapshot.hasTag(`${id}:blocked`)
      const obligations = units
        .filter(([, each]) => each.kind === "obligation" && each.task === id)
        .map(([obligation, each]) => (stopped ? "-" : machineState(snapshot, obligation, each)))
      return [`${id}:${state}@${slot.attempts ?? 0}[${obligations.join(",")}]`]
    })
    // What the outcome's `firstDead` guard reads: the state of the first log entry that moved a task into a dead state.
    const dead = context.log.find((entry) => context.units[entry.unit]?.kind === "task" && TaskMachine.isDead(entry.to))
    const outcome = String(valueAt(snapshot.value, "outcome"))
    return [
      plan.path,
      ...parts,
      `run:${outcome}`,
      `dead:${dead?.to ?? "-"}`,
      `stop:${context.stop?.state ?? "-"}`,
    ].join("|")
  }

export * as TaskAlphabet from "./alphabet"
