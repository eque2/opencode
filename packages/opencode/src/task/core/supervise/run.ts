import { Clock, Duration, Effect, Fiber, Option, Predicate, Stream } from "effect"
import {
  type ActorRefFrom,
  assign,
  enqueueActions,
  type EventObject,
  fromCallback,
  fromEffect,
  logWarning,
  raise,
  setup,
} from "@jambudipa/xstate-effect"
import type { EventV2 } from "@opencode-ai/core/event"
import type { BlendModel } from "@/task/blend/model"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { TaskHarness } from "../harness"
import type { Plan } from "../model"
import type { Unstamped } from "../recorder"
import { TaskSessions } from "../sessions"
import { TaskWorkers } from "../workers"
import { ScenarioSupervisor } from "./scenario"
import { TaskSupervisor } from "./task"

// The run supervisor (spine AD-8, AD-12, D6): the owner of one run while it is live, registered as `run:<runID>` in
// the harness system. Its first state records `run.started` or `run.resumed` and defers the forwarded trusts; then
// it applies the trusts the directory recorded before the run. Its `main` region follows the run actor's snapshots:
// it spawns a task supervisor for each task tagged `ready` or `active` and a scenario supervisor for each scenario
// in `verifying`, stops one when its unit leaves those tags, and sends each live supervisor `unit.moved` once per new
// history entry of its unit. Each timer is its own region (heartbeat, run wall clock, stale cadence), and the batch
// proof of the `ready` scenarios is another. No transition of one region targets another region's state, and no timer
// row re-enters. When the run actor is done, every region stops, and `main` waits for the status writer's last
// write, frees the directory lease, and closes.

export interface Input {
  readonly run: TaskWorkers.Run
  /** The event bus the unit supervisors' session events come from. */
  readonly events: EventV2.Interface
  /** Whether the run resumes its stored slice: its first fact is `run.resumed`, else `run.started`. */
  readonly resumed: boolean
  /** The `/task` argument, recorded as the slice's `path`. */
  readonly path: string
  /** The outside ids the directory recorded as trusted before this run. */
  readonly trusts: Effect.Effect<ReadonlyArray<string>>
  /** The external regions the command found trusted in the stored slices (AD-15): trusted directly after the start. */
  readonly externals: ReadonlyArray<string>
  /** Frees the directory lease on the harness root (AD-19). */
  readonly release: Effect.Effect<void>
  /** The Recorder's status writer: it ends after it has written the `done` snapshot. */
  readonly writer: Fiber.Fiber<void, unknown>
}

/** The run actor's snapshot, as the `watch` actor relays it, with the time it saw it. */
export interface RunChanged {
  readonly type: "run.changed"
  readonly snapshot: RunSnapshot
  readonly now: number
}

/** `/task trust <id>`, forwarded by the harness root (SV20). */
export interface RunTrust {
  readonly type: "run.trust"
  readonly id: string
}

type Kind = "task" | "scenario"

interface Context {
  readonly run: TaskWorkers.Run
  readonly events: EventV2.Interface
  readonly resumed: boolean
  readonly path: string
  readonly trusts: Effect.Effect<ReadonlyArray<string>>
  readonly externals: ReadonlyArray<string>
  readonly release: Effect.Effect<void>
  readonly writer: Fiber.Fiber<void, unknown>
  /** The current spec (AD-12): the plan's, then each valid reload. */
  readonly spec: BlendModel.Spec
  /** The obligations the last stale check found, recorded once the reloaded spec is assigned. */
  readonly stale: TaskWorkers.Stale["stale"]
  /** When this job recorded `run.started` or `run.resumed`: the run wall clock and the task clocks count from it. */
  readonly runStart: number
  readonly latest: Option.Option<RunSnapshot>
  /** Trusts forwarded during start-up, applied once after it. */
  readonly pending: ReadonlyArray<string>
  /** Trusts recorded and not yet folded, so a second trust does not record again. */
  readonly trusting: ReadonlyArray<string>
  /** The history entries already dispatched. */
  readonly seen: number
  /** The live unit supervisors. */
  readonly units: Readonly<Record<string, Kind>>
  /** The scenarios of the batch proof in flight, and those proved whose result has not folded yet. */
  readonly batch: ReadonlyArray<string>
  readonly proved: ReadonlyArray<string>
  readonly batchFailures: number
  readonly error: string
  /** A counter for the ids of the fire-and-forget record workers. */
  readonly records: number
  /** The run actor's error, when it stopped with one. */
  readonly defect: string
}

type Event = RunChanged | RunTrust | { readonly type: "run.ended" }

/** Worker failures in a row that end a scenario batch with `harness error: …` (SV6). */
export const FAILURE_LIMIT = 3

/** The heartbeat cadence: the status writer rewrites the last snapshot with a fresh `aliveAt`. */
export const HEARTBEAT = Duration.seconds(5)

/** The stale-check cadence: the spec is loaded again from the root checkout. */
export const STALE_CADENCE = Duration.seconds(1)

const RETRY_DELAY = Duration.seconds(1)

// The phase tags, as the machine's CLASS table names them.
const PHASES = Object.values(TaskMachine.CLASS)
  .flatMap((kind) =>
    Object.values(kind).flatMap((state: { readonly phase?: string }) =>
      state.phase === undefined ? [] : [state.phase],
    ),
  )
  .filter((phase, index, all) => all.indexOf(phase) === index)

const message = (error: unknown) =>
  TaskSessions.oneLine(Predicate.hasProperty(error, "message") ? String(error.message) : String(error)).slice(0, 600)

/** A unit's own class and phase tags, without the `<unit>:` prefix (AD-8). */
export const tagsOf = (snapshot: RunSnapshot, unit: string) => [
  ...TaskEngineXState.tags(snapshot, unit),
  ...PHASES.filter((tag) => snapshot.hasTag(`${unit}:${tag}`)),
]

/** The units a run supervisor supervises in a snapshot: tasks tagged `ready` or `active`, scenarios in `verifying`. */
export const supervised = (plan: Plan, snapshot: RunSnapshot): Readonly<Record<string, Kind>> =>
  Object.fromEntries([
    ...plan.tasks
      .filter((task) => snapshot.hasTag(`${task.id}:ready`) || snapshot.hasTag(`${task.id}:active`))
      .map((task) => [task.id, "task" as const]),
    ...plan.scenarios
      .filter((scenario) => snapshot.hasTag(`${scenario.id}:verifying`))
      .map((scenario) => [scenario.id, "scenario" as const]),
  ])

/** An untrusted region of kind `outside` in the snapshot: an outside precondition of the spec, not an external task. */
export const untrustedOutside = (plan: Plan, snapshot: RunSnapshot, id: string) => {
  if (!(id in plan.spec.outside) || plan.external.includes(id)) return false
  const state = TaskEngineXState.unitState(snapshot, id)
  return state !== undefined && state !== "trusted"
}

/** The scenarios tagged `ready` in a snapshot: the next batch proof. */
export const readyScenarios = (plan: Plan, snapshot: RunSnapshot) =>
  plan.scenarios.filter((scenario) => snapshot.hasTag(`${scenario.id}:ready`)).map((scenario) => scenario.id)

// --- the run's workers ---------------------------------------------------------------------------------------------------

/**
 * The first fact of the job, then `outside.trusted` for each trusted external region not yet trusted (AD-15: the only
 * path that moves one), then the time the first fact was recorded: the run's start.
 */
const startRun = (input: {
  readonly run: TaskWorkers.Run
  readonly resumed: boolean
  readonly path: string
  readonly externals: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    yield* TaskWorkers.record(input.run, {
      type: input.resumed ? "run.resumed" : "run.started",
      base: input.run.base,
      path: input.path,
    })
    const start = yield* Clock.currentTimeMillis
    const snapshot = yield* input.run.recorder.actor.getSnapshot
    for (const id of input.externals.filter((id) => TaskEngineXState.unitState(snapshot, id) === "untrusted"))
      yield* TaskWorkers.record(input.run, { type: "outside.trusted", id })
    return start
  })

/** Records `outside.trusted` once for each id that names an untrusted outside region; external regions and tasks never. */
const applyTrusts = (input: { readonly run: TaskWorkers.Run; readonly ids: Effect.Effect<ReadonlyArray<string>> }) =>
  Effect.gen(function* () {
    const snapshot = yield* input.run.recorder.actor.getSnapshot
    const ids = yield* input.ids
    const outside = ids.filter(
      (id, index) => ids.indexOf(id) === index && untrustedOutside(input.run.plan, snapshot, id),
    )
    for (const id of outside) yield* TaskWorkers.record(input.run, { type: "outside.trusted", id })
    return outside
  })

/** A stale check, given the run's current warning: it records `spec.checked` itself (D12). */
const checkStale = (input: { readonly run: TaskWorkers.Run }) =>
  Effect.gen(function* () {
    const warning = TaskEngineXState.view(yield* input.run.recorder.actor.getSnapshot).run.warning ?? ""
    return yield* TaskWorkers.staleCheck(input.run, warning)
  })

/** `obligation.stale` for each obligation a stale check found, once the new spec is assigned (AD-12). */
const markStale = (input: { readonly run: TaskWorkers.Run; readonly stale: TaskWorkers.Stale["stale"] }) =>
  Effect.gen(function* () {
    for (const item of input.stale) yield* TaskWorkers.record(input.run, { type: "obligation.stale", ...item })
  })

/** The batch proof of the `ready` scenarios: one `scenario.proved` for each. */
const proveBatch = (input: { readonly run: TaskWorkers.Run; readonly ids: ReadonlyArray<string> }) =>
  Effect.gen(function* () {
    const results = yield* TaskWorkers.scenarioProof(input.run, input.ids)
    for (const result of results) yield* TaskWorkers.record(input.run, { type: "scenario.proved", ...result })
  })

/**
 * The end of the run's work: the status writer has written the `done` snapshot, then the lease is free (UI24). A run
 * actor that stopped with an error ends the run the same way, and its defect is logged (SV26).
 */
const finish = (input: {
  readonly runID: string
  readonly writer: Fiber.Fiber<void, unknown>
  readonly release: Effect.Effect<void>
  readonly defect: string
}) =>
  Effect.gen(function* () {
    if (input.defect !== "")
      yield* Effect.logError("task harness: the run actor stopped with an error", {
        runID: input.runID,
        error: input.defect,
      })
    yield* Fiber.await(input.writer)
    yield* input.release
  })

const recordFact = (input: { readonly run: TaskWorkers.Run; readonly fact: Unstamped }) =>
  TaskWorkers.record(input.run, input.fact)

/**
 * Relays each snapshot of the run actor, the current one first, as `run.changed`. The stream ends when the actor stops
 * or errors, without the last snapshot; the relay then sends the actor's final snapshot, so the supervisor sees the
 * `done` or `error` that ends the run.
 */
const watch = fromCallback<EventObject, { readonly run: TaskWorkers.Run }>(({ input, sendBack }) => {
  const actor = input.run.recorder.actor
  const send = (snapshot: RunSnapshot) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sync(() => sendBack({ type: "run.changed", snapshot, now } satisfies RunChanged)),
    )
  const relay = actor.changes.pipe(
    Stream.runForEach(send),
    Effect.exit,
    Effect.andThen(Effect.flatMap(actor.getSnapshot, send)),
  )
  const fiber = Effect.runFork(relay)
  return () => {
    Effect.runFork(Fiber.interrupt(fiber))
  }
})

const childId = (run: TaskWorkers.Run, kind: Kind, unit: string) => `${kind}:${run.id}:${unit}`

const ended = (snapshot: RunSnapshot) => snapshot.status !== "active"

/** The run supervisor's logic; the job asks the harness root to spawn it as `run:<runID>` with an `Input`. */
export const machine = setup({
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- xstate reads `types` for its type parameters only
  types: {} as { context: Context; events: Event; input: Input },
  actors: {
    start: fromEffect(({ input }: { input: Parameters<typeof startRun>[0] }) => startRun(input)),
    trust: fromEffect(({ input }: { input: Parameters<typeof applyTrusts>[0] }) => applyTrusts(input)),
    watch,
    touch: fromEffect(({ input }: { input: { run: TaskWorkers.Run } }) => TaskWorkers.touch(input.run)),
    stale: fromEffect(({ input }: { input: Parameters<typeof checkStale>[0] }) => checkStale(input)),
    mark: fromEffect(({ input }: { input: Parameters<typeof markStale>[0] }) => markStale(input)),
    batch: fromEffect(({ input }: { input: Parameters<typeof proveBatch>[0] }) => proveBatch(input)),
    finish: fromEffect(({ input }: { input: Parameters<typeof finish>[0] }) => finish(input)),
    summary: fromEffect(({ input }: { input: { run: TaskWorkers.Run } }) => TaskWorkers.summary(input.run)),
    record: fromEffect(({ input }: { input: Parameters<typeof recordFact>[0] }) => recordFact(input)),
    task: TaskSupervisor.machine,
    scenario: ScenarioSupervisor.machine,
  },
  delays: {
    heartbeat: Duration.toMillis(HEARTBEAT),
    stale: Duration.toMillis(STALE_CADENCE),
    retry: Duration.toMillis(RETRY_DELAY),
    runWallClock: ({ context }: { context: Context }) =>
      Option.match(context.run.limits.runWallClock, { onNone: () => 0, onSome: Duration.toMillis }),
  },
  guards: {
    limited: ({ context }) => Option.isSome(context.run.limits.runWallClock),
    ended: ({ event }) => event.type === "run.changed" && ended(event.snapshot),
    batchDue: ({ context }) =>
      Option.match(context.latest, {
        onNone: () => false,
        onSome: (snapshot) =>
          !ended(snapshot) && readyScenarios(context.run.plan, snapshot).some((id) => !context.proved.includes(id)),
      }),
    batchFailureLeft: ({ context }) => context.batchFailures + 1 < FAILURE_LIMIT,
    outcome: ({ context }) => context.defect === "",
  },
  actions: {
    // A failed touch or stale check is logged; it counts toward no failure rule and records no fact.
    logTouchFailure: logWarning(
      ({ context, event }) =>
        `task harness: a heartbeat touch failed in ${context.run.id}: ${message("error" in event ? event.error : event)}`,
    ),
    logStaleFailure: logWarning(
      ({ context, event }) =>
        `task harness: a stale check failed in ${context.run.id}: ${message("error" in event ? event.error : event)}`,
    ),
    // Follows a new snapshot: the unit supervisors to spawn and stop, and `unit.moved` for each new entry.
    dispatch: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "run.changed") return
      const snapshot = event.snapshot
      const log = snapshot.context.log
      const view = TaskEngineXState.view(snapshot)
      const plan = context.run.plan
      const wanted = ended(snapshot) ? {} : supervised(plan, snapshot)
      const newest = (unit: string) => log.findLastIndex((item) => item.unit === unit)
      const sessionOf = (unit: string) => view.tasks[unit]?.session
      for (const [unit, kind] of Object.entries(context.units))
        if (wanted[unit] !== kind) enqueue.stopChild(childId(context.run, kind, unit))
      for (const [unit, kind] of Object.entries(wanted)) {
        if (context.units[unit] === kind) continue
        const id = childId(context.run, kind, unit)
        const entry = newest(unit)
        const tags = tagsOf(snapshot, unit)
        if (kind === "scenario") {
          const scenario = plan.scenarios.find((item) => item.id === unit)
          if (scenario === undefined) continue
          enqueue.spawnChild("scenario", {
            id,
            systemId: id,
            input: { run: context.run, scenario, owner: id, entry, tags },
          })
          continue
        }
        const task = context.spec.tasks.find((item) => item.id === unit) ?? plan.tasks.find((item) => item.id === unit)
        if (task === undefined) continue
        const session = sessionOf(unit)
        const clockStart = TaskWorkers.taskClockStart(view.history, unit, context.runStart)
        enqueue.spawnChild("task", {
          id,
          systemId: id,
          input: {
            run: context.run,
            events: context.events,
            task,
            spec: context.spec,
            owner: id,
            entry,
            tags,
            ...(session === undefined ? {} : { session }),
            runStart: context.runStart,
            ...Option.match(clockStart, {
              onNone: () => ({}),
              onSome: (start) => ({ clock: { start, now: event.now } }),
            }),
          },
        })
      }
      // Each new entry of a unit whose supervisor lives on; a supervisor spawned now starts from its newest entry.
      for (let index = context.seen; index < log.length; index++) {
        const item = log[index]
        if (item === undefined) continue
        const kind = context.units[item.unit]
        if (kind === undefined || wanted[item.unit] !== kind) continue
        const session = sessionOf(item.unit)
        enqueue.sendTo(childId(context.run, kind, item.unit), {
          type: "unit.moved",
          unit: item.unit,
          entry: index,
          state: item.to,
          tags: tagsOf(snapshot, item.unit),
          latest: index === newest(item.unit),
          at: item.at,
          ...(session === undefined ? {} : { session }),
        })
      }
      const ready = readyScenarios(plan, snapshot)
      enqueue.assign({
        units: wanted,
        seen: log.length,
        latest: Option.some(snapshot),
        defect: snapshot.status === "error" ? String(Option.getOrUndefined(snapshot.error)) : context.defect,
        // A scenario proved earlier leaves the list once its result has folded (it is no longer ready).
        proved: context.proved.filter((id) => ready.includes(id) || context.batch.includes(id)),
        trusting: context.trusting.filter((id) => untrustedOutside(plan, snapshot, id)),
      })
    }),
    // A forwarded trust: recorded once, and only for an untrusted region of kind `outside` (SV20).
    trust: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "run.trust") return
      const snapshot = Option.getOrUndefined(context.latest)
      if (snapshot === undefined || context.trusting.includes(event.id)) return
      if (!untrustedOutside(context.run.plan, snapshot, event.id)) return
      enqueue.spawnChild("record", {
        id: `record:${context.records}`,
        input: { run: context.run, fact: { type: "outside.trusted", id: event.id } },
      })
      enqueue.assign({ trusting: [...context.trusting, event.id], records: context.records + 1 })
    }),
    // A unit supervisor that errored counts as three worker failures: its unit ends with the defect (SV26).
    unitFailed: enqueueActions(({ context, event, enqueue }) => {
      const match = Option.fromNullishOr(/^xstate\.error\.actor\.(task|scenario):[^:]+:(.+)$/.exec(event.type))
      if (Option.isNone(match)) return
      const unit = match.value[2] ?? ""
      const reason = `harness error: ${message("error" in event ? event.error : "the supervisor failed")}`
      const fact: Unstamped =
        match.value[1] === "task"
          ? { type: "task.failed", task: unit, reason }
          : { type: "scenario.verified", verdict: { id: unit, verdict: "rejected", reason } }
      enqueue.spawnChild("record", { id: `record:${context.records}`, input: { run: context.run, fact } })
      enqueue.assign({
        records: context.records + 1,
        units: Object.fromEntries(Object.entries(context.units).filter(([id]) => id !== unit)),
      })
    }),
  },
}).createMachine({
  id: "run",
  context: ({ input }) => ({
    run: input.run,
    events: input.events,
    resumed: input.resumed,
    path: input.path,
    trusts: input.trusts,
    externals: input.externals,
    release: input.release,
    writer: input.writer,
    spec: input.run.plan.spec,
    stale: [],
    runStart: 0,
    latest: Option.none(),
    pending: [],
    trusting: [],
    seen: 0,
    units: {},
    batch: [],
    proved: [],
    batchFailures: 0,
    error: "",
    records: 0,
    defect: "",
  }),
  initial: "starting",
  states: {
    // `run.started` or `run.resumed` first; a trust forwarded meanwhile waits for it.
    starting: {
      on: { "run.trust": { actions: assign({ pending: ({ context, event }) => [...context.pending, event.id] }) } },
      invoke: {
        src: "start",
        input: ({ context }) => ({
          run: context.run,
          resumed: context.resumed,
          path: context.path,
          externals: context.externals,
        }),
        onDone: {
          target: "trusting",
          actions: assign({ runStart: ({ event }) => Option.getOrElse(event.output, () => 0) }),
        },
        onError: "closing",
      },
    },
    // The trusts the directory recorded before this run, and those forwarded during start-up, each once.
    trusting: {
      on: { "run.trust": { actions: assign({ pending: ({ context, event }) => [...context.pending, event.id] }) } },
      invoke: {
        src: "trust",
        input: ({ context }) => ({
          run: context.run,
          ids: Effect.map(context.trusts, (ids) => [...ids, ...context.pending]),
        }),
        onDone: {
          target: "running",
          actions: assign({ trusting: ({ event }) => Option.getOrElse(event.output, () => []), pending: [] }),
        },
        onError: "running",
      },
    },
    running: {
      type: "parallel",
      onDone: "closed",
      states: {
        main: {
          initial: "active",
          states: {
            active: {
              invoke: { src: "watch", input: ({ context }) => ({ run: context.run }) },
              on: {
                "run.changed": [
                  { guard: "ended", target: "finishing", actions: ["dispatch", raise({ type: "run.ended" })] },
                  { actions: "dispatch" },
                ],
                "run.trust": { actions: "trust" },
                "*": { actions: "unitFailed" },
              },
            },
            finishing: {
              invoke: {
                src: "finish",
                input: ({ context }) => ({
                  runID: context.run.id,
                  writer: context.writer,
                  release: context.release,
                  defect: context.defect,
                }),
                // The run machine is done: the closing summary, after the lease is free (UI24); a run actor that
                // stopped with an error has no outcome to sum up.
                onDone: [{ guard: "outcome", target: "summarizing" }, { target: "closed" }],
                onError: [{ guard: "outcome", target: "summarizing" }, { target: "closed" }],
              },
            },
            summarizing: {
              invoke: {
                src: "summary",
                input: ({ context }) => ({ run: context.run }),
                onDone: "closed",
                onError: "closed",
              },
            },
            closed: { type: "final" },
          },
        },
        heartbeat: {
          initial: "beating",
          on: { "run.ended": ".stopped" },
          states: {
            beating: { after: { heartbeat: "touching" } },
            // A touch that fails is logged by the actor's logger, counts toward nothing and records nothing.
            touching: {
              invoke: {
                src: "touch",
                input: ({ context }) => ({ run: context.run }),
                onDone: "beating",
                onError: {
                  target: "beating",
                  actions: "logTouchFailure",
                },
              },
            },
            stopped: { type: "final" },
          },
        },
        wallClock: {
          initial: "init",
          on: { "run.ended": ".stopped" },
          states: {
            init: { always: [{ guard: "limited", target: "counting" }, { target: "stopped" }] },
            counting: { after: { runWallClock: "ending" } },
            ending: {
              invoke: {
                src: "record",
                input: ({ context }) => ({
                  run: context.run,
                  fact: {
                    type: "run.ended",
                    state: "failed",
                    reason: `wall clock: the run took over ${Option.match(context.run.limits.runWallClock, {
                      onNone: () => 0,
                      onSome: (limit) => Math.round(Duration.toMinutes(limit)),
                    })} min`,
                  },
                }),
                onDone: "stopped",
                onError: "stopped",
              },
            },
            stopped: { type: "final" },
          },
        },
        staleCadence: {
          initial: "waiting",
          on: { "run.ended": ".stopped" },
          states: {
            waiting: { after: { stale: "checking" } },
            // A failed check is logged, records nothing more, and the cadence goes on. The check records
            // `spec.checked`; a valid reload's spec is assigned and sent before `obligation.stale` is recorded.
            checking: {
              invoke: {
                src: "stale",
                input: ({ context }) => ({ run: context.run }),
                onDone: {
                  target: "marking",
                  actions: enqueueActions(({ context, event, enqueue }) => {
                    if (Option.isNone(event.output)) return
                    const found = event.output.value
                    enqueue.assign({ stale: found.stale })
                    if (Option.isNone(found.spec)) return
                    const spec = found.spec.value
                    enqueue.assign({ spec })
                    for (const [unit, kind] of Object.entries(context.units))
                      enqueue.sendTo(childId(context.run, kind, unit), { type: "spec.reloaded", spec })
                  }),
                },
                onError: {
                  target: "waiting",
                  actions: "logStaleFailure",
                },
              },
            },
            marking: {
              invoke: {
                src: "mark",
                input: ({ context }) => ({ run: context.run, stale: context.stale }),
                onDone: "waiting",
                onError: { target: "waiting", actions: "logStaleFailure" },
              },
            },
            stopped: { type: "final" },
          },
        },
        scenarios: {
          initial: "idle",
          on: { "run.ended": ".stopped" },
          states: {
            idle: {
              always: {
                guard: "batchDue",
                target: "proving",
                actions: assign(({ context }) => {
                  const ready = Option.match(context.latest, {
                    onNone: () => [],
                    onSome: (snapshot) => readyScenarios(context.run.plan, snapshot),
                  })
                  return { batch: ready.filter((id) => !context.proved.includes(id)) }
                }),
              },
            },
            proving: {
              invoke: {
                src: "batch",
                input: ({ context }) => ({ run: context.run, ids: context.batch }),
                onDone: {
                  target: "idle",
                  actions: assign(({ context }) => ({
                    proved: [...context.proved, ...context.batch],
                    batch: [],
                    batchFailures: 0,
                  })),
                },
                onError: [
                  {
                    guard: "batchFailureLeft",
                    target: "retrying",
                    actions: assign(({ context, event }) => ({
                      batchFailures: context.batchFailures + 1,
                      error: message(event.error),
                    })),
                  },
                  {
                    target: "failing",
                    actions: assign(({ context, event }) => ({
                      batchFailures: context.batchFailures + 1,
                      error: message(event.error),
                    })),
                  },
                ],
              },
            },
            retrying: { after: { retry: "proving" } },
            // The third failure in a row fails the scenarios of the batch.
            failing: {
              entry: enqueueActions(({ context, enqueue }) => {
                context.batch.forEach((id, index) =>
                  enqueue.spawnChild("record", {
                    id: `record:${context.records + index}`,
                    input: {
                      run: context.run,
                      fact: {
                        type: "scenario.proved",
                        id,
                        status: "failed",
                        reason: `harness error: ${context.error}`,
                      },
                    },
                  }),
                )
                enqueue.assign({
                  proved: [...context.proved, ...context.batch],
                  records: context.records + context.batch.length,
                  batch: [],
                  batchFailures: 0,
                })
              }),
              always: "idle",
            },
            stopped: { type: "final" },
          },
        },
      },
    },
    // A start that failed: nothing more can be recorded; the lease is freed and the supervisor closes.
    closing: {
      invoke: {
        src: "finish",
        input: ({ context }) => ({
          runID: context.run.id,
          writer: context.writer,
          release: context.release,
          defect: context.defect,
        }),
        onDone: "closed",
        onError: "closed",
      },
    },
    closed: { type: "final" },
  },
})

export type RunSupervisor = ActorRefFrom<typeof machine>

// --- the job's side (AD-8): spawn, wait for the close, cancel ---------------------------------------------------------

// The run supervisor's first snapshot that is no longer active; none when it is not in the system. Its changes end
// without the final snapshot of an actor that stops or errors, so the final one is read once they end.
const untilClosed = (harness: TaskHarness.Interface, runID: string) =>
  Effect.gen(function* () {
    const ref = yield* harness.system.get(TaskHarness.systemId.run(runID))
    if (Option.isNone(ref)) return Option.none()
    const ended = yield* Stream.runHead(
      ref.value.changes.pipe(Stream.filter((snapshot) => snapshot.status !== "active")),
    ).pipe(Effect.orElseSucceed(() => Option.none()))
    if (Option.isSome(ended)) return ended
    return Option.some(yield* ref.value.getSnapshot)
  })

/**
 * Waits until the run supervisor is final; a supervisor that ends in `error` ends the wait the same way, and its defect
 * is logged (SV26). The job then closes its run scope, whose first finalizer frees the lease.
 */
export const awaitClosed = Effect.fn("RunSupervisor.awaitClosed")(function* (
  harness: TaskHarness.Interface,
  runID: string,
) {
  const last = yield* untilClosed(harness, runID).pipe(
    Effect.catchCause((cause) =>
      Effect.as(Effect.logError("task harness: the run supervisor failed", { runID, cause }), Option.none()),
    ),
  )
  if (Option.isSome(last) && last.value.status === "error")
    yield* Effect.logError("task harness: the run supervisor stopped with an error", {
      runID,
      error: String(Option.getOrUndefined(last.value.error)),
    })
})

/** Asks the harness root to spawn the run supervisor as `run:<runID>`, then waits until it is final. */
export const supervise = Effect.fn("RunSupervisor.supervise")(function* (harness: TaskHarness.Interface, input: Input) {
  yield* harness.spawnRun(input.run.id, machine, input)
  yield* awaitClosed(harness, input.run.id)
})

/**
 * The cancel finalizer of a cancelled job (SV4, SV25): once the supervisor has stored the job's first fact (so the
 * cancel never lands in the previous slice), `run.cancelled`; then the supervisor gets `limits.cancelDeadline` to
 * close, and is stopped. A job whose supervisor never started records nothing.
 */
export const cancel = Effect.fn("RunSupervisor.cancel")(function* (
  harness: TaskHarness.Interface,
  run: TaskWorkers.Run,
) {
  const ref = yield* harness.system.get(TaskHarness.systemId.run(run.id))
  if (Option.isNone(ref)) return
  const started = yield* Stream.runHead(
    ref.value.changes.pipe(Stream.filter((snapshot) => snapshot.status !== "active" || !isStarting(snapshot))),
  ).pipe(Effect.orElseSucceed(() => Option.none()))
  if (Option.isSome(started) && started.value.status === "active")
    yield* TaskWorkers.record(run, { type: "run.cancelled", reason: "cancelled" }).pipe(Effect.ignore)
  yield* untilClosed(harness, run.id).pipe(Effect.ignore, Effect.timeoutOption(run.limits.cancelDeadline))
  yield* harness.removeRun(run.id)
})

// Whether a run supervisor's snapshot is in its first state, before its first fact is stored.
const isStarting = (snapshot: unknown) => Predicate.hasProperty(snapshot, "value") && snapshot.value === "starting"

export * as RunSupervisor from "./run"
