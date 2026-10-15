// The view the designs read (spine AD-16): accessors over the taskView actor's snapshot, through `fromActor`, and the
// events that change it. It holds no state of its own: every value is the machine's context or a pure selector over it.
import { Effect, Option, type Stream } from "effect"
import { createMemo, type Accessor } from "solid-js"
import { fromActor } from "./actor"
import { TaskView } from "./machine"
import { rows, type Liveness, type ProofLog, type Row, type Status } from "./store"

/** What the view needs of the taskView actor. */
export interface ViewActor {
  readonly getSnapshot: Effect.Effect<TaskView.Snapshot>
  readonly changes: Stream.Stream<TaskView.Snapshot, unknown>
  readonly send: (event: TaskView.Event) => Effect.Effect<void>
}

export interface View {
  /** The last status that parsed; undefined with no status file. */
  readonly status: Accessor<Status | undefined>
  /** The clock at the last read of the feed. */
  readonly now: Accessor<number>
  readonly liveness: Accessor<Liveness>
  /** The run is live: Tab, esc twice and the watch keys may act on it (each also checks ownership). */
  readonly live: Accessor<boolean>
  readonly rows: Accessor<ReadonlyArray<Row>>
  readonly selected: Accessor<string | undefined>
  readonly select: (id: string) => void
  readonly next: () => void
  readonly previous: () => void
  /** The next task in work: what Tab selects in the watch view. */
  readonly nextRunning: () => void
  readonly previousRunning: () => void
  readonly expanded: Accessor<boolean>
  readonly setExpanded: (open: boolean) => void
  readonly toggleExpanded: () => void
  /** The watch view is on: the session area shows the selected task's running session (see `watch.tsx`). */
  readonly watching: Accessor<boolean>
  readonly setWatching: (on: boolean) => void
  readonly design: Accessor<number>
  readonly setDesign: (id: number) => void
  readonly cycleDesign: () => void
  /** The root session on screen; "" before the developer opens one. */
  readonly root: Accessor<string>
  /** The session in the watch frame; "" for the root's own transcript. */
  readonly target: Accessor<string>
  /** Whether the root owns harness sessions: the run on screen is its run. */
  readonly owns: Accessor<boolean>
  readonly logs: Accessor<ReadonlyArray<ProofLog>>
  /** When the status file was last written. */
  readonly mtime: Accessor<number>
  /** The read cadences' counts: a reader reads again whenever its count changes. */
  readonly ticks: Accessor<TaskView.Context["ticks"]>
  readonly send: (event: TaskView.Event) => void
}

/** The view over `actor`, for as long as the calling owner lives. */
export function viewOf(actor: ViewActor): View {
  const snapshot = fromActor(actor)
  const context = () => snapshot().context
  const send = (event: TaskView.Event) => {
    Effect.runFork(actor.send(event))
  }
  const status = createMemo(() => Option.getOrUndefined(context().status))
  const list = createMemo(() => {
    const current = status()
    return current ? rows(current) : []
  })
  return {
    status,
    now: () => context().now,
    liveness: () => TaskView.livenessOf(context()),
    live: () => TaskView.livenessOf(context()) === "live",
    rows: list,
    selected: () => Option.getOrUndefined(TaskView.selected(context())),
    select: (id) => send({ type: "select", id }),
    next: () => send({ type: "select.next" }),
    previous: () => send({ type: "select.previous" }),
    nextRunning: () => send({ type: "select.nextRunning" }),
    previousRunning: () => send({ type: "select.previousRunning" }),
    expanded: () => snapshot().matches({ expansion: "expanded" }),
    setExpanded: (open) => send({ type: "expand.set", open }),
    toggleExpanded: () => send({ type: "expand.toggle" }),
    watching: () => snapshot().matches({ watch: "on" }),
    setWatching: (on) => send({ type: "watch.set", on }),
    design: () => context().design,
    setDesign: (id) => send({ type: "design.set", id }),
    cycleDesign: () => send({ type: "design.cycle" }),
    root: () => context().root,
    target: () => context().target,
    owns: () => context().owns,
    logs: () => context().logs,
    mtime: () => context().mtime,
    ticks: () => context().ticks,
    send,
  }
}
