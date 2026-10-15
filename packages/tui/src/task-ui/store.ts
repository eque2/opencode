// The data every task-ui design shares: the harness status file and what pure selectors derive from it (the task tree,
// the tags' classes, the display table, durations). The view state is the taskView actor's (machine.ts, view.ts).
import { Array as Arr, Option, Schema } from "effect"
import type { RGBA } from "@opentui/core"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"

// The harness writes `<directory>/.opencode/task/status.json` (packages/opencode/src/task/core/status.ts). States are
// kept as plain strings so a state the harness adds later still renders, with a neutral tone.
const Reason = Schema.NullOr(Schema.String).annotate({ identifier: "TaskUi.Reason" })

// The AD-13 fields are optional, so a status file written before them still parses (SV17). A tag the task-ui does not
// know is kept and read by nothing.
const Tags = Schema.optional(Schema.Array(Schema.String))
const At = Schema.optional(Schema.Number)
const Span = Schema.Struct({ state: Schema.String, from: Schema.Number, to: At }).annotate({ identifier: "TaskUi.Span" })

const Task = Schema.Struct({
  state: Schema.String,
  tags: Tags,
  attempts: Schema.Number,
  waitingOn: Schema.Array(Schema.String),
  waitingOnOutside: Schema.optional(Schema.Array(Schema.String)),
  worktree: Schema.optional(Reason),
  reason: Schema.optional(Reason),
  blockedBy: Schema.optional(Schema.Struct({ id: Schema.String, state: Schema.String })),
  startedAt: At,
  endedAt: At,
  spans: Schema.optional(Schema.Array(Span)),
}).annotate({ identifier: "TaskUi.Task" })

const Unit = Schema.Struct({ state: Schema.String, tags: Tags, reason: Schema.optional(Reason), endedAt: At }).annotate(
  { identifier: "TaskUi.Obligation" },
)

const Scenario = Schema.Struct({
  state: Schema.String,
  tags: Tags,
  title: Schema.optional(Schema.String),
  waitingOn: Schema.Array(Schema.String),
  reason: Schema.optional(Reason),
}).annotate({ identifier: "TaskUi.Scenario" })

const Region = Schema.Struct({ state: Schema.String, tags: Tags }).annotate({ identifier: "TaskUi.Region" })

const History = Schema.Struct({
  at: Schema.Number,
  unit: Schema.String,
  from: Schema.optional(Reason),
  to: Schema.String,
  reason: Schema.optional(Reason),
}).annotate({ identifier: "TaskUi.History" })

export const Status = Schema.Struct({
  run: Schema.Struct({
    state: Schema.String,
    tags: Tags,
    reason: Schema.optional(Reason),
    warning: Schema.optional(Schema.String),
    spec: Schema.String,
    specId: Schema.optional(Schema.String),
    path: Schema.String,
    title: Schema.optional(Schema.String),
    task: Schema.optional(Schema.Struct({ id: Schema.String, title: Schema.String })),
    startedAt: At,
    endedAt: At,
    // The heartbeat (AD-9): the status writer's latest write.
    aliveAt: At,
  }),
  tasks: Schema.Record(Schema.String, Task),
  obligations: Schema.Record(Schema.String, Unit),
  scenarios: Schema.Record(Schema.String, Scenario),
  outside: Schema.optional(Schema.Record(Schema.String, Region)),
  external: Schema.optional(Schema.Record(Schema.String, Region)),
  history: Schema.Array(History),
}).annotate({ identifier: "TaskUi.Status" })
export type Status = typeof Status.Type
export type TaskStatus = typeof Task.Type

/** The status in `text`, or none when it is not a status file (empty, half written, or another shape). */
export const parse = Schema.decodeUnknownOption(Schema.fromJsonString(Status))

// Natural order, so `T1.10` sorts after `T1.2`.
const collator = new Intl.Collator("en", { numeric: true })

/** Ids in natural order. */
export const byId = (a: string, b: string) => collator.compare(a, b)

/** `<directory>/.opencode/task/status.json`, as the harness writes it. */
export const statusFile = (directory: string) => `${directory}/.opencode/task/status.json`

/** `<directory>/.opencode/task/proofs/<task>.log`: the harness appends each proof command and its output as they run. */
export const proofLogFile = (directory: string, task: string) => `${directory}/.opencode/task/proofs/${task}.log`

/** A proof log: its name (a task id, or `scenarios`) and when the harness last wrote to it, in epoch milliseconds. */
export type ProofLog = { readonly name: string; readonly mtime: number }

/** The mark on every task-workflow surface, so none of it reads as an ordinary subagent task. */
export const MARK = "◆ In the Flow"

/** The plain name of the task workflow, for titles that carry no glyph. */
export const NAME = "In the Flow"

// --- tones and glyphs ----------------------------------------------------------------------------------------------

export type Tone = "idle" | "active" | "pass" | "good" | "bad" | "warn" | "off"

/** The Board column of an active task's phase; the tags choose every other column. */
export type Column = "WAITING" | "BUILDING" | "PROVING" | "VERIFYING" | "STOPPED" | "TRUSTED"

/** How a state shows: its glyph, its tone, its Gantt block, and an active phase's Board column. */
export interface Display {
  readonly glyph: string
  readonly tone: Tone
  readonly block: string
  readonly column?: Column
}

/**
 * The display table (AD-16, EXPERIENCE "State vocabulary"): the one table keyed by state names in the task-ui. A
 * design uses a unit's state only as a key here; every grouping reads the tags. `stalled` stays for an older file.
 */
export const DISPLAY: Readonly<Record<string, Display>> = {
  waiting: { glyph: "○", tone: "idle", block: "░" },
  building: { glyph: "◐", tone: "active", block: "▓", column: "BUILDING" },
  proving: { glyph: "◑", tone: "active", block: "▒", column: "PROVING" },
  verifying: { glyph: "◒", tone: "active", block: "▞", column: "VERIFYING" },
  trusted: { glyph: "✓", tone: "good", block: "█" },
  failed: { glyph: "✗", tone: "bad", block: "█" },
  budget_exhausted: { glyph: "⊘", tone: "bad", block: "█" },
  needs_human: { glyph: "?", tone: "warn", block: "█" },
  blocked: { glyph: "⊖", tone: "warn", block: "█" },
  cancelled: { glyph: "–", tone: "off", block: "█" },
  pending: { glyph: "·", tone: "idle", block: "░" },
  rejected: { glyph: "✗", tone: "bad", block: "█" },
  passed: { glyph: "◉", tone: "pass", block: "█" },
  stale: { glyph: "~", tone: "warn", block: "░" },
  stalled: { glyph: "‼", tone: "warn", block: "█" },
  untrusted: { glyph: "○", tone: "idle", block: "░" },
  running: { glyph: "◆", tone: "active", block: "▓" },
  done: { glyph: "✓", tone: "good", block: "█" },
  refused: { glyph: "⊘", tone: "bad", block: "█" },
}

export const tone = (state: string): Tone => DISPLAY[state]?.tone ?? "idle"

export const glyph = (state: string) => DISPLAY[state]?.glyph ?? "•"

/** `budget_exhausted` → `budget exhausted`. */
export const label = (state: string) => state.replaceAll("_", " ")

export const color = (theme: TuiThemeCurrent, value: Tone): RGBA =>
  ({
    idle: theme.textMuted,
    active: theme.primary,
    pass: theme.info,
    good: theme.success,
    bad: theme.error,
    warn: theme.warning,
    off: theme.textMuted,
  })[value]

// --- the tags (AD-13): every classification reads them ---------------------------------------------------------

type Tagged = { readonly tags?: ReadonlyArray<string> }

export const tagsOf = (unit: Tagged): ReadonlyArray<string> => unit.tags ?? []

export const tagged = (unit: Tagged, tag: string) => tagsOf(unit).includes(tag)

/** A status written before the tags (AD-13): drawn with the UI25 fallback and classified not at all. */
export const older = (status: Status) => status.run.tags === undefined

/** The muted line an older status shows (UI25). */
export const OLDER_LINE = "status from an older harness — type /task to refresh"

// The severity order of AD-16: dead, then blocked, then stopped, then active, then waiting, then ended.
const SEVERITY = ["dead", "blocked", "stopped", "active", "waiting", "ended"]

/** A unit's place in the severity order; a unit with no known tag comes last. */
export const severity = (unit: Tagged) => {
  const at = SEVERITY.findIndex((tag) => tagged(unit, tag))
  return at < 0 ? SEVERITY.length : at
}

/** Most severe first: in a short list, the line that explains a stop is the one that shows. */
export const bySeverity = (a: Tagged, b: Tagged) => severity(a) - severity(b)

/** A task's Board column from its tags; none for a task with no tags (an older status). */
export const columnOf = (task: TaskStatus): Option.Option<Column> => {
  if (tagged(task, "stopped")) return Option.some("STOPPED")
  if (tagged(task, "ended")) return Option.some("TRUSTED")
  if (tagged(task, "active")) return Option.fromNullishOr(DISPLAY[task.state]?.column)
  if (tagged(task, "waiting")) return Option.some("WAITING")
  return Option.none()
}

/** The STOPPED group of a stopped task: 0 dead, 1 blocked, 2 the rest. */
export const stoppedGroup = (task: TaskStatus) => (tagged(task, "dead") ? 0 : tagged(task, "blocked") ? 1 : 2)

/** The colour of a state. */
export const stateColor = (theme: TuiThemeCurrent, state: string) => color(theme, tone(state))

// The run and task states after which nothing moves without the developer. The Gantt and the Ticker read it until T4.7
// and T4.8; the store reads the tags.
export const ENDED = ["done", "refused", "cancelled", "needs_human", "budget_exhausted", "failed"]

// --- the tree ------------------------------------------------------------------------------------------------------

export type Row = {
  readonly id: string
  readonly depth: number
  /** No later sibling: the tree draws `└` instead of `├`. */
  readonly last: boolean
  readonly task: TaskStatus
}

// The parent of `T1.4` is `T1` when the run has a task `T1`; a root task has none.
const parentOf = (id: string, ids: ReadonlyArray<string>) => {
  const parent = id.slice(0, Math.max(0, id.lastIndexOf(".")))
  return ids.includes(parent) ? Option.some(parent) : Option.none<string>()
}

/** The tasks in tree order: a parent, then its children (`T1`, `T1.1`, `T1.2`), with their depth. */
export const rows = (status: Status): Row[] => {
  const ids = Object.keys(status.tasks).sort(byId)
  const depth = (id: string): number =>
    Option.match(parentOf(id, ids), { onNone: () => 0, onSome: (parent) => depth(parent) + 1 })
  const siblings = (a: string, b: string) => Option.getOrElse(parentOf(a, ids), () => "") === Option.getOrElse(parentOf(b, ids), () => "")
  return ids.map((id, index) => ({
    id,
    depth: depth(id),
    last: !ids.slice(index + 1).some((other) => siblings(other, id)),
    task: status.tasks[id],
  }))
}

/** A task's own obligations (`T1.4.c1`, `T1.4.f2`), not its children's. */
export const obligationsOf = (status: Status, id: string) =>
  Object.keys(status.obligations)
    .filter((key) => key.startsWith(`${id}.`) && /^[a-z]+\d*$/.test(key.slice(id.length + 1)))
    .sort(byId)
    .map((key) => ({ id: key, local: key.slice(id.length + 1), ...status.obligations[key] }))

/** How many tasks the tags put in each class; an older status has a total and no classes. */
export const counts = (status: Status) => {
  const tasks = Object.values(status.tasks)
  return {
    total: tasks.length,
    trusted: tasks.filter((task) => tagged(task, "ended") && !tagged(task, "stopped")).length,
    active: tasks.filter((task) => tagged(task, "active")).length,
    stopped: tasks.filter((task) => tagged(task, "stopped")).length,
  }
}

/** The run has not ended: its tags say so. An older status, with no tags, is not active. */
export const runActive = (status: Status) => !older(status) && !tagged(status.run, "ended")

/** What the run waits on: the dependencies of its waiting tasks, in natural order. */
export const waitsOn = (status: Status) =>
  Arr.dedupe(Object.values(status.tasks).flatMap((task) => (tagged(task, "waiting") ? task.waitingOn : []))).sort(byId)

/**
 * The task in work after `selected` in tree order (`by` 1), or before it (`by` -1), wrapping round; none when no task
 * is in work, or when the selected task is the only one.
 */
export const nextRunning = (list: ReadonlyArray<Row>, selected: string | undefined, by: 1 | -1) => {
  const at = list.findIndex((row) => row.id === selected)
  const working = list.flatMap((row, index) => (tagged(row.task, "active") ? [{ id: row.id, index }] : []))
  const found =
    by === 1
      ? (working.find((item) => item.index > at) ?? working[0])
      : (working.findLast((item) => item.index < at) ?? working.at(-1))
  return Option.fromNullishOr(found?.id).pipe(Option.filter((id) => id !== selected))
}

/** The task to select when nothing is selected: the first one in work, else the most severe stopped one, else the first. */
export const focus = (list: ReadonlyArray<Row>) => {
  const stopped = list.filter((row) => tagged(row.task, "stopped"))
  return (list.find((row) => tagged(row.task, "active")) ??
    stopped.toSorted((a, b) => bySeverity(a.task, b.task))[0] ??
    list[0])?.id
}

/** `▰▰▰▱▱▱` for `done` of `total`, `width` cells wide. */
export const bar = (done: number, total: number, width: number) => {
  const full = total === 0 ? 0 : Math.round((done / total) * width)
  return "▰".repeat(full) + "▱".repeat(width - full)
}

/** `text` cut to `width` characters, with `…` when it was longer; nothing for a width below 1. */
export const cut = (text: string, width: number) => {
  const room = Math.max(0, width)
  return text.length <= room ? text : room <= 1 ? text.slice(0, room) : `${text.slice(0, room - 1)}…`
}

/** `45s`, `3m 12s`, `1h 4m` (EXPERIENCE "Durations"). */
export const elapsed = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`
}

/** The view's liveness (AD-16): no status, an ended run, a fresh heartbeat, or a run that stands still. */
export type Liveness = "absent" | "ended" | "live" | "still"

/**
 * A task's duration (D21): fixed from `endedAt`; to now while the view is live; to the last heartbeat otherwise;
 * blank with no `startedAt`, or with no heartbeat to stop at.
 */
export const durationOf = (
  task: { readonly startedAt?: number; readonly endedAt?: number },
  run: { readonly aliveAt?: number },
  liveness: Liveness,
  now: number,
) => {
  if (task.startedAt === undefined) return ""
  if (task.endedAt !== undefined) return elapsed(task.endedAt - task.startedAt)
  if (liveness === "live") return elapsed(now - task.startedAt)
  return run.aliveAt === undefined ? "" : elapsed(run.aliveAt - task.startedAt)
}

// --- the designs ---------------------------------------------------------------------------------------------------

/** The designs, and where each one shows: the picker and the switch notice say it, so a design is never hard to find. */
export const DESIGNS = [
  { id: 1, name: "Ledger", where: "task tree in the sidebar" },
  { id: 2, name: "Dock", where: "status line at the bottom of the screen" },
  { id: 3, name: "Board", where: "full-screen board of task stages" },
  { id: 4, name: "Matrix", where: "full-screen grid of proofs and scenarios" },
  { id: 5, name: "Gantt", where: "full-screen timeline of the run" },
  { id: 6, name: "HUD", where: "floating panel in the top-right corner" },
  { id: 7, name: "Ticker", where: "line beside the prompt, with notices" },
] as const
