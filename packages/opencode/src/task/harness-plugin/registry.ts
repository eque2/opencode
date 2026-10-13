import { type Effect, MutableHashMap, Option, Schema } from "effect"
import type { Verdict } from "@/task/core/model"

// What the plugin's hooks share with the runs of this process. opencode calls the plugin once per instance
// (directory) but imports its module once, so module state is where every instance's hooks and every run meet:
// the two tools record what they receive here, `tool.execute.before` counts a builder's calls here, the `event`
// hook notes stream activity here, and a run registers here so that `/task trust` and an abort of its root
// session reach it.
//
// ponytail: process-wide maps keyed by session id, as O1's TaskHooks. A restart empties them; a resumed run
// registers its sessions again.

export const BUILDER = "task-builder"
export const VERIFIER = "task-verifier"
/** The agent of the `/task` command's own turn: no tool, one short line. Only `/task trust` reaches a model. */
export const NOTE = "task-note"

const ready = MutableHashMap.empty<string, { readonly summary?: string }>()
const verdicts = MutableHashMap.empty<string, ReadonlyArray<Verdict>>()
const repeated = MutableHashMap.empty<string, string>()
const watched = MutableHashMap.empty<string, { readonly limit: number; readonly calls: ReadonlyArray<string> }>()
const activity = MutableHashMap.empty<string, number>()

// The same encoding the doom-loop check of opencode compares tool inputs with.
const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const take = <V>(map: MutableHashMap.MutableHashMap<string, V>, key: string) => {
  const value = MutableHashMap.get(map, key)
  MutableHashMap.remove(map, key)
  return value
}

export const recordReady = (session: string, input: { readonly summary?: string }) =>
  MutableHashMap.set(ready, session, input)

/** The builder's `task_ready` of the turn that just ended, cleared on read. */
export const takeReady = (session: string) => take(ready, session)

export const recordVerdicts = (session: string, input: ReadonlyArray<Verdict>) =>
  MutableHashMap.set(verdicts, session, [...Option.getOrElse(MutableHashMap.get(verdicts, session), () => []), ...input])

/** The verdicts of the round that just ended, cleared on read. */
export const takeVerdicts = (session: string): ReadonlyArray<Verdict> =>
  Option.getOrElse(take(verdicts, session), () => [])

/** The repetition that ended the builder's turn, cleared on read. */
export const takeRepeated = (session: string) => take(repeated, session)

/** Watch a builder session: `limit` identical calls in a row end its turn. */
export const watch = (session: string, limit: number) => {
  MutableHashMap.set(watched, session, { limit, calls: [] })
  MutableHashMap.remove(repeated, session)
}

/**
 * A new turn starts: what an earlier turn left (a `task_ready`, verdicts, a repetition, the calls so far) must not
 * count for it.
 */
export const startTurn = (session: string) => {
  MutableHashMap.remove(ready, session)
  MutableHashMap.remove(verdicts, session)
  MutableHashMap.remove(repeated, session)
  Option.map(MutableHashMap.get(watched, session), (entry) =>
    MutableHashMap.set(watched, session, { ...entry, calls: [] }),
  )
}

/**
 * One tool call of a session, seen before it runs. In a watched builder session it returns the reason when this
 * call makes `limit` identical calls (same tool, same input) in a row, and remembers it.
 */
export const noteCall = (session: string, tool: string, input: unknown): Option.Option<string> => {
  const entry = MutableHashMap.get(watched, session)
  if (Option.isNone(entry)) return Option.none()
  const { limit } = entry.value
  const key = `${tool}\u0000${Option.getOrElse(encodeJson(input), () => "")}`
  const calls = [...entry.value.calls, key].slice(-limit)
  MutableHashMap.set(watched, session, { limit, calls })
  if (calls.length < limit || !calls.every((call) => call === key)) return Option.none()
  const reason = `repetition: ${limit} identical ${tool} calls in a row`
  MutableHashMap.set(repeated, session, reason)
  return Option.some(reason)
}

/** Stream activity of a session: a part update or delta, or a status change, at `at` (epoch ms). */
export const touch = (session: string, at: number) => MutableHashMap.set(activity, session, at)

export const lastActivity = (session: string) => MutableHashMap.get(activity, session)

// --- the runs of this process ----------------------------------------------------------------------------------

export interface ActiveRun {
  readonly directory: string
  /** The session that ran the `/task` of this run: aborting it cancels the run. */
  readonly root: string
  /** Records an `outside` id as trusted in the run. */
  readonly trust: (id: string) => Effect.Effect<void>
  /** Cancels the run: its child sessions are aborted and the run ends `cancelled`. */
  readonly cancel: Effect.Effect<void>
}

const runs = MutableHashMap.empty<string, ActiveRun>()

/** The key of the run of one spec folder in one directory. */
export const runKey = (directory: string, spec: string) => `${directory}\u0000${spec}`

export const register = (key: string, run: ActiveRun) => MutableHashMap.set(runs, key, run)

export const unregister = (key: string) => MutableHashMap.remove(runs, key)

export const running = (key: string) => MutableHashMap.has(runs, key)

/** The runs of a directory that go on in this process. */
export const runsIn = (directory: string) => [...MutableHashMap.values(runs)].filter((run) => run.directory === directory)

/** The runs whose root session is `session`. */
export const runsOf = (session: string) => [...MutableHashMap.values(runs)].filter((run) => run.root === session)

export * as HarnessRegistry from "./registry"
