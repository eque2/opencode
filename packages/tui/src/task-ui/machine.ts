// The task-ui view machine (spine AD-16): one `taskView` actor for each plugin instance holds the view state that
// the designs share — the design, the chosen task, the expansion, the watch and its target, the stop key's arming —
// and every periodic read and timer of the task-ui as a delayed transition:
//
// - `feed` reads the status file, its mtime, the proof logs and the clock once a second. A text that does not parse
//   keeps the last status; a file that is gone clears it; a failed read keeps it and reads again.
// - `sessions`, `activity` and `tail` tick every 2 s, 1.5 s and 500 ms: the session list, a session's activity lines
//   and a proof log's tail are read again on each tick (`ticks` in the context).
// - `stopKey`: while the run is live, the first `stop.key` warns and arms, a second one within 5 s stops the run. It
//   disarms when the view stops being live or the route moves to another session.
// - `liveness`: absent (no status), ended (the run's `ended` tag), live (the heartbeat `run.aliveAt` at most 15 s
//   old), else still. It reads no ownership: each key that acts on the run checks that itself.
import { Clock, Effect, Option } from "effect"
import { assign, emit, fromEffect, setup, type SnapshotFrom } from "@jambudipa/xstate-effect"
import { DESIGNS, focus, nextRunning, parse, rows, statusFile, type ProofLog, type Status } from "./store"

/** One read of the feed: the status text (empty when the file is gone), its mtime, the proof logs, and the time. */
export interface Read {
  readonly exists: boolean
  readonly text: string
  readonly mtime: number
  readonly logs: ReadonlyArray<ProofLog>
  readonly now: number
}

// When a file was last written, in epoch milliseconds; 0 when it cannot be read.
const modified = (file: string) =>
  Effect.tryPromise(() => Bun.file(file).stat()).pipe(
    Effect.map((stat) => stat.mtimeMs),
    Effect.orElseSucceed(() => 0),
  )

// The proof logs the harness writes as proofs run (`.opencode/task/proofs/<name>.log`); none when it wrote none.
const proofLogs = (directory: string) => {
  const folder = `${directory}/.opencode/task/proofs`
  return Effect.tryPromise(() => Array.fromAsync(new Bun.Glob("*.log").scan({ cwd: folder }))).pipe(
    Effect.flatMap((names) =>
      Effect.forEach(names, (name) =>
        modified(`${folder}/${name}`).pipe(Effect.map((mtime): ProofLog => ({ name: name.slice(0, -4), mtime }))),
      ),
    ),
    Effect.orElseSucceed((): ReadonlyArray<ProofLog> => []),
  )
}

/** The feed's read of `<directory>/.opencode/task/status.json`; it fails when the file is there but unreadable. */
export const read = (directory: string) =>
  Effect.gen(function* () {
    const file = statusFile(directory)
    const exists = yield* Effect.tryPromise(() => Bun.file(file).exists())
    const text = exists ? yield* Effect.tryPromise(() => Bun.file(file).text()) : ""
    return {
      exists,
      text,
      mtime: exists ? yield* modified(file) : 0,
      logs: yield* proofLogs(directory),
      now: yield* Clock.currentTimeMillis,
    } satisfies Read
  })

export interface Input {
  readonly directory: string
  /** The design to start on; a value that is not a design starts on 1. */
  readonly design: number
}

export interface Context {
  readonly directory: string
  /** 1–7, the design on screen. */
  readonly design: number
  /** The task the developer chose; the focus task when none, or when the status no longer has it. */
  readonly chosen: Option.Option<string>
  /** The last status that parsed; none when there is no status file. */
  readonly status: Option.Option<Status>
  /** The text of the last read, so an unchanged file is not parsed again. */
  readonly text: string
  readonly mtime: number
  readonly logs: ReadonlyArray<ProofLog>
  /** The clock at the last read. */
  readonly now: number
  /** The root session on screen: the session, or its parent when the developer opened a child session. */
  readonly root: string
  /** The session in the watch frame; "" for the root's own transcript. */
  readonly target: string
  /** Whether the root owns harness sessions, and when one last changed. */
  readonly owns: boolean
  readonly updated: number
  /** One count for each read cadence: a reader reads again whenever its count changes. */
  readonly ticks: { readonly sessions: number; readonly activity: number; readonly tail: number }
}

export type Event =
  | { readonly type: "design.set"; readonly id: number }
  | { readonly type: "design.cycle" }
  | { readonly type: "select"; readonly id: string }
  | { readonly type: "select.next" }
  | { readonly type: "select.previous" }
  | { readonly type: "select.nextRunning" }
  | { readonly type: "select.previousRunning" }
  | { readonly type: "expand.toggle" }
  | { readonly type: "expand.set"; readonly open: boolean }
  | { readonly type: "watch.toggle" }
  | { readonly type: "watch.set"; readonly on: boolean }
  | { readonly type: "stop.key" }
  | { readonly type: "sessions.changed"; readonly owns: boolean; readonly updated: number }
  | { readonly type: "route.changed"; readonly session: string; readonly parent?: string }
  | { readonly type: "watch.target"; readonly session: string; readonly keep: boolean }

/** What the stop key asks of the plugin: warn on the first press, stop the run on the second. */
export type Emitted = { readonly type: "stop.warn" } | { readonly type: "stop.run" }

/** A heartbeat at most this old (`now - run.aliveAt`) is a live run (AD-13). */
export const LIVE_MS = 15_000

export type Liveness = "absent" | "ended" | "live" | "still"

// The liveness rows, in the order AD-16 gives them; the first that holds wins.
const LIVENESS: ReadonlyArray<Liveness> = ["absent", "ended", "live", "still"]

/** The liveness the context gives: no status, the run's `ended` tag, a fresh heartbeat, or else still. */
export const livenessOf = (context: Context): Liveness =>
  Option.match(context.status, {
    onNone: () => "absent",
    onSome: (status) => {
      if (status.run.tags?.includes("ended")) return "ended"
      const alive = status.run.aliveAt
      return alive !== undefined && context.now - alive <= LIVE_MS ? "live" : "still"
    },
  })

const listOf = (context: Context) => Option.match(context.status, { onNone: () => [], onSome: rows })

/** The selected task: the chosen one while the status has it, else the focus task; none without tasks. */
export const selected = (context: Context): Option.Option<string> => {
  const list = listOf(context)
  return Option.filter(context.chosen, (id) => list.some((row) => row.id === id)).pipe(
    Option.orElse(() => Option.fromNullishOr(focus(list))),
  )
}

// The task `by` rows after the selected one, wrapping round.
const stepped = (context: Context, by: 1 | -1) => {
  const ids = listOf(context).map((row) => row.id)
  if (ids.length === 0) return context.chosen
  const at = Math.max(0, ids.indexOf(Option.getOrElse(selected(context), () => ids[0])))
  return Option.some(ids[(at + by + ids.length) % ids.length])
}

// The next task in work after the selected one, or the chosen task when nothing else runs.
const running = (context: Context, by: 1 | -1) =>
  nextRunning(listOf(context), Option.getOrUndefined(selected(context)), by).pipe(Option.orElse(() => context.chosen))

const isDesign = (id: number) => DESIGNS.some((item) => item.id === id)

/** The view machine of the task-ui; `start()` in `index.tsx` makes its one actor. */
export const machine = setup({
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- xstate reads `types` for its type parameters only
  types: {} as { context: Context; events: Event; input: Input; emitted: Emitted },
  actors: {
    read: fromEffect(({ input }: { input: { directory: string } }) => read(input.directory)),
  },
  delays: { feed: 1_000, sessions: 2_000, activity: 1_500, tail: 500, stopWindow: 5_000 },
}).createMachine({
  id: "taskView",
  type: "parallel",
  context: ({ input }) => ({
    directory: input.directory,
    design: isDesign(input.design) ? input.design : 1,
    chosen: Option.none(),
    status: Option.none(),
    text: "",
    mtime: 0,
    logs: [],
    now: 0,
    root: "",
    target: "",
    owns: false,
    updated: 0,
    ticks: { sessions: 0, activity: 0, tail: 0 },
  }),
  on: {
    "design.set": { guard: ({ event }) => isDesign(event.id), actions: assign({ design: ({ event }) => event.id }) },
    "design.cycle": { actions: assign({ design: ({ context }) => (context.design % DESIGNS.length) + 1 }) },
    select: { actions: assign({ chosen: ({ event }) => Option.some(event.id) }) },
    "select.next": { actions: assign({ chosen: ({ context }) => stepped(context, 1) }) },
    "select.previous": { actions: assign({ chosen: ({ context }) => stepped(context, -1) }) },
    "select.nextRunning": { actions: assign({ chosen: ({ context }) => running(context, 1) }) },
    "select.previousRunning": { actions: assign({ chosen: ({ context }) => running(context, -1) }) },
    "sessions.changed": { actions: assign({ owns: ({ event }) => event.owns, updated: ({ event }) => event.updated }) },
    "route.changed": { actions: assign({ root: ({ event }) => event.parent ?? event.session }) },
    // A choice with `keep` (nothing runs) leaves the frame on the session it shows.
    "watch.target": { guard: ({ event }) => !event.keep, actions: assign({ target: ({ event }) => event.session }) },
  },
  states: {
    feed: {
      initial: "reading",
      states: {
        reading: {
          invoke: {
            src: "read",
            input: ({ context }) => ({ directory: context.directory }),
            onDone: {
              target: "resting",
              actions: assign(({ context, event }) =>
                Option.match(event.output, {
                  onNone: () => ({}),
                  onSome: (got) => ({
                    text: got.text,
                    mtime: got.mtime,
                    logs: got.logs,
                    now: got.now,
                    status: !got.exists
                      ? Option.none<Status>()
                      : got.text === context.text
                        ? context.status
                        : parse(got.text).pipe(Option.orElse(() => context.status)),
                  }),
                }),
              ),
            },
            onError: "resting",
          },
        },
        resting: { after: { feed: "reading" } },
      },
    },
    expansion: {
      initial: "collapsed",
      states: {
        collapsed: {
          on: { "expand.toggle": "expanded", "expand.set": { guard: ({ event }) => event.open, target: "expanded" } },
        },
        expanded: {
          on: {
            "expand.toggle": "collapsed",
            "expand.set": { guard: ({ event }) => !event.open, target: "collapsed" },
          },
        },
      },
    },
    watch: {
      initial: "off",
      states: {
        // Off shows the root's own transcript.
        off: {
          entry: assign({ target: "" }),
          on: { "watch.toggle": "on", "watch.set": { guard: ({ event }) => event.on, target: "on" } },
        },
        on: { on: { "watch.toggle": "off", "watch.set": { guard: ({ event }) => !event.on, target: "off" } } },
      },
    },
    stopKey: {
      initial: "disarmed",
      states: {
        // Only a live run takes the key: an ended or still run has nothing to stop.
        disarmed: {
          on: {
            "stop.key": {
              guard: ({ context }) => livenessOf(context) === "live",
              target: "armed",
              actions: emit({ type: "stop.warn" }),
            },
          },
        },
        armed: {
          always: { guard: ({ context }) => livenessOf(context) !== "live", target: "disarmed" },
          after: { stopWindow: "disarmed" },
          on: { "stop.key": { target: "disarmed", actions: emit({ type: "stop.run" }) }, "route.changed": "disarmed" },
        },
      },
    },
    liveness: {
      initial: "absent",
      states: Object.fromEntries(
        LIVENESS.map((state) => [
          state,
          {
            always: LIVENESS.filter((other) => other !== state).map((other) => ({
              guard: ({ context }: { context: Context }) => livenessOf(context) === other,
              target: other,
            })),
          },
        ]),
      ),
    },
    sessions: {
      initial: "ticking",
      states: {
        ticking: {
          after: {
            sessions: {
              target: "ticking",
              reenter: true,
              actions: assign({ ticks: ({ context }) => ({ ...context.ticks, sessions: context.ticks.sessions + 1 }) }),
            },
          },
        },
      },
    },
    activity: {
      initial: "ticking",
      states: {
        ticking: {
          after: {
            activity: {
              target: "ticking",
              reenter: true,
              actions: assign({ ticks: ({ context }) => ({ ...context.ticks, activity: context.ticks.activity + 1 }) }),
            },
          },
        },
      },
    },
    tail: {
      initial: "ticking",
      states: {
        ticking: {
          after: {
            tail: {
              target: "ticking",
              reenter: true,
              actions: assign({ ticks: ({ context }) => ({ ...context.ticks, tail: context.ticks.tail + 1 }) }),
            },
          },
        },
      },
    },
  },
})

export type Snapshot = SnapshotFrom<typeof machine>

export * as TaskView from "./machine"
