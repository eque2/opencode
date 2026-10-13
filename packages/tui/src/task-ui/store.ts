// The data every task-ui design shares: the harness status file, the task tree derived from it, the selection, the
// peek toggle, and the design number. The designs only render; nothing here writes to the harness.
import { Effect, Fiber, Option, Schedule, Schema, type Duration } from "effect"
import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { RGBA } from "@opentui/core"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"

// The harness writes `<directory>/.opencode/task/status.json` (packages/opencode/src/task/core/status.ts). States are
// kept as plain strings so a state the harness adds later still renders, with a neutral tone.
const Reason = Schema.NullOr(Schema.String).annotate({ identifier: "TaskUi.Reason" })

const Task = Schema.Struct({
  state: Schema.String,
  attempts: Schema.Number,
  waitingOn: Schema.Array(Schema.String),
  worktree: Schema.optional(Reason),
  reason: Schema.optional(Reason),
}).annotate({ identifier: "TaskUi.Task" })

const Unit = Schema.Struct({ state: Schema.String, reason: Schema.optional(Reason) }).annotate({
  identifier: "TaskUi.Obligation",
})

const Scenario = Schema.Struct({
  state: Schema.String,
  waitingOn: Schema.Array(Schema.String),
  reason: Schema.optional(Reason),
}).annotate({ identifier: "TaskUi.Scenario" })

const History = Schema.Struct({
  at: Schema.Number,
  unit: Schema.String,
  from: Schema.optional(Reason),
  to: Schema.String,
  reason: Schema.optional(Reason),
}).annotate({ identifier: "TaskUi.History" })

export const Status = Schema.Struct({
  harness: Schema.String,
  run: Schema.Struct({ state: Schema.String, reason: Schema.optional(Reason), spec: Schema.String, path: Schema.String }),
  tasks: Schema.Record(Schema.String, Task),
  obligations: Schema.Record(Schema.String, Unit),
  scenarios: Schema.Record(Schema.String, Scenario),
  history: Schema.Array(History),
}).annotate({ identifier: "TaskUi.Status" })
export type Status = typeof Status.Type
export type TaskStatus = typeof Task.Type

/** The status in `text`, or none when it is not a status file (empty, half written, or another shape). */
export const parse = Schema.decodeUnknownOption(Schema.fromJsonString(Status))

/** `read`'s value, read now and then every `every` while the calling owner lives. A failed read keeps the last value. */
export function poll<A>(initial: A, every: Duration.Input, read: Effect.Effect<A, unknown>): Accessor<A> {
  const [value, setValue] = createSignal(initial)
  const fiber = Effect.runFork(
    read.pipe(
      Effect.tap((next) => Effect.sync(() => setValue(() => next))),
      Effect.ignore,
      Effect.repeat(Schedule.spaced(every)),
    ),
  )
  onCleanup(() => Effect.runFork(Fiber.interrupt(fiber)))
  return value
}

// Natural order, so `T1.10` sorts after `T1.2`.
const collator = new Intl.Collator("en", { numeric: true })

/** Ids in natural order. */
export const byId = (a: string, b: string) => collator.compare(a, b)

/** `<directory>/.opencode/task/status.json`, as the harness writes it. */
export const statusFile = (directory: string) => `${directory}/.opencode/task/status.json`

// --- tones and glyphs ----------------------------------------------------------------------------------------------

export type Tone = "idle" | "active" | "pass" | "good" | "bad" | "warn" | "off"

const TONES: Record<string, Tone> = {
  waiting: "idle",
  pending: "idle",
  running: "active",
  building: "active",
  proving: "active",
  verifying: "active",
  passed: "pass",
  trusted: "good",
  done: "good",
  failed: "bad",
  rejected: "bad",
  refused: "bad",
  budget_exhausted: "bad",
  stalled: "warn",
  needs_human: "warn",
  stale: "warn",
  cancelled: "off",
}

const GLYPHS: Record<string, string> = {
  waiting: "○",
  pending: "·",
  running: "◆",
  building: "◐",
  proving: "◑",
  verifying: "◒",
  passed: "◉",
  trusted: "✓",
  done: "✓",
  failed: "✗",
  rejected: "✗",
  refused: "⊘",
  budget_exhausted: "⊘",
  stalled: "‼",
  needs_human: "?",
  stale: "~",
  cancelled: "–",
}

export const tone = (state: string): Tone => TONES[state] ?? "idle"

export const glyph = (state: string) => GLYPHS[state] ?? "•"

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

const SEVERITY: ReadonlyArray<Tone> = ["bad", "warn", "active", "pass", "idle", "off", "good"]

/** Failures first, trusted last: in a short list, the line that explains a stop is the one that shows. */
export const bySeverity = (a: { state: string }, b: { state: string }) =>
  SEVERITY.indexOf(tone(a.state)) - SEVERITY.indexOf(tone(b.state))

/** The colour of a state. */
export const stateColor = (theme: TuiThemeCurrent, state: string) => color(theme, tone(state))

// The task states in which the harness works on a task: building, proving or verifying.
export const ACTIVE = ["building", "proving", "verifying"]

// The run and task states after which nothing moves without the developer.
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

/** How many tasks are in each tone. */
export const counts = (status: Status) => {
  const tasks = Object.values(status.tasks)
  return {
    total: tasks.length,
    trusted: tasks.filter((task) => task.state === "trusted").length,
    active: tasks.filter((task) => ACTIVE.includes(task.state)).length,
    stopped: tasks.filter((task) => tone(task.state) === "bad" || tone(task.state) === "warn").length,
  }
}

/** The task to select when nothing is selected: the first one in work, else the first stopped one, else the first. */
export const focus = (list: ReadonlyArray<Row>) =>
  (list.find((row) => ACTIVE.includes(row.task.state)) ??
    list.find((row) => tone(row.task.state) === "bad" || tone(row.task.state) === "warn") ??
    list[0])?.id

/** `▰▰▰▱▱▱` for `done` of `total`, `width` cells wide. */
export const bar = (done: number, total: number, width: number) => {
  const full = total === 0 ? 0 : Math.round((done / total) * width)
  return "▰".repeat(full) + "▱".repeat(width - full)
}

/** `text` cut to `width` characters, with `…` when it was longer. */
export const cut = (text: string, width: number) =>
  text.length <= width ? text : width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`

/** `95s` → `1m 35s`. */
export const elapsed = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

// --- the view state ------------------------------------------------------------------------------------------------

export const DESIGNS = [
  { id: 1, name: "Ledger" },
  { id: 2, name: "Dock" },
  { id: 3, name: "Board" },
  { id: 4, name: "Matrix" },
  { id: 5, name: "Gantt" },
  { id: 6, name: "HUD" },
  { id: 7, name: "Ticker" },
] as const

export type View = ReturnType<typeof createView>

/** The selection, peek toggle and design number over a status accessor. Call it inside a reactive root. */
export function createView(input: { status: Accessor<Status | undefined>; now: Accessor<number>; design: number }) {
  const [design, setDesign] = createSignal(input.design)
  const [chosen, setChosen] = createSignal<string>()
  const [peek, setPeek] = createSignal(false)
  const list = createMemo(() => {
    const status = input.status()
    return status ? rows(status) : []
  })
  const selected = createMemo(() => {
    const id = chosen()
    return id && list().some((row) => row.id === id) ? id : focus(list())
  })
  const move = (by: number) => {
    const ids = list().map((row) => row.id)
    if (ids.length === 0) return
    const at = ids.indexOf(selected() ?? ids[0])
    setChosen(ids[(at + by + ids.length) % ids.length])
  }
  return {
    status: input.status,
    now: input.now,
    rows: list,
    selected,
    select: setChosen,
    next: () => move(1),
    previous: () => move(-1),
    peek,
    setPeek,
    togglePeek: () => setPeek((open) => !open),
    design,
    cycleDesign: () => setDesign((id) => (id % DESIGNS.length) + 1),
  }
}
