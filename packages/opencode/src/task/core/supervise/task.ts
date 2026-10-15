import { Duration, Effect, Option, Predicate } from "effect"
import { type ActorRefFrom, assign, fromEffect, raise, setup } from "@jambudipa/xstate-effect"
import type { EventV2 } from "@opencode-ai/core/event"
import type { SessionID } from "@/session/schema"
import type { BlendModel } from "@/task/blend/model"
import { TaskEngineXState } from "@/task/engine-xstate"
import type { TaskHooks } from "../hooks"
import type { Result as Proved, Verdict } from "../model"
import type { Unstamped } from "../recorder"
import { TaskSessions } from "../sessions"
import { TaskWorkers } from "../workers"

// The task supervisor (spine AD-8, AD-10, AD-11, D7): one actor per task while the task is tagged `ready` or
// `active`. It branches only on the phase tags of `unit.moved`, starts the phase's work again on each new entry,
// and moves the lifecycle only by recording facts through its workers. It holds only live-process state: the turn
// in flight, the watch timers, the nudge count, the hooks it received, the verifier round's sub-states, the worker
// failures in a row and the task wall clock. After it records the fact that ends a phase, it waits quietly, with no
// timer, until a `unit.moved` with a new entry arrives.

/** What the run supervisor sends a unit supervisor for each new history entry of its unit (AD-8). */
export interface UnitMoved {
  readonly type: "unit.moved"
  readonly unit: string
  /** The entry's index in the run's history. */
  readonly entry: number
  /** The machine state key. */
  readonly state: string
  /** The unit's class and phase tags, without the `<unit>:` prefix. */
  readonly tags: ReadonlyArray<string>
  /** Whether this is the unit's newest entry in the snapshot: a supervisor works only on its newest entry. */
  readonly latest: boolean
  /** When the entry was recorded. */
  readonly at: number
  /** The task's builder session, once it has one. */
  readonly session?: string
}

/** The run supervisor's new spec after a stale check reloaded it (AD-12). */
export interface SpecReloaded {
  readonly type: "spec.reloaded"
  readonly spec: BlendModel.Spec
}

export interface Input {
  readonly run: TaskWorkers.Run
  /** The event bus the session events of a turn come from. */
  readonly events: EventV2.Interface
  readonly task: BlendModel.Task
  /** The current spec (AD-12). */
  readonly spec: BlendModel.Spec
  /** This supervisor's system id, `task:<runID>:<taskId>`: the owner of the sessions it claims. */
  readonly owner: string
  /** The unit at spawn: its newest entry and its tags. */
  readonly entry: number
  readonly tags: ReadonlyArray<string>
  readonly session?: string
  /** When this job recorded `run.started` or `run.resumed`: the task clock never counts the time before it. */
  readonly runStart: number
  /** The task clock of a task that is already active: its start (`taskClockStart`) and the time of the spawn. */
  readonly clock?: { readonly start: number; readonly now: number }
}

type Phase = "none" | "ready" | "building" | "proving" | "verifying"

interface Judge {
  readonly id: string
  readonly text: string
}

interface Context {
  readonly run: TaskWorkers.Run
  readonly events: EventV2.Interface
  readonly task: BlendModel.Task
  readonly spec: BlendModel.Spec
  readonly owner: string
  /** The newest entry the supervisor acted on. */
  readonly entry: number
  readonly tags: ReadonlyArray<string>
  readonly phase: Phase
  readonly session: Option.Option<string>
  /** The repetition limit `prompt.ts` reads from this snapshot for a watched session (AD-11). */
  readonly limit: number
  /** What the next builder turn sends. */
  readonly prompt: TaskWorkers.BuilderPrompt
  readonly nudges: number
  /** The hooks of the turn in flight: cleared when each turn starts. */
  readonly ready: boolean
  readonly repeated: Option.Option<string>
  readonly turn: Option.Option<TaskWorkers.Turn>
  /** The spend-cap reason a retry status of the turn carried. */
  readonly cap: string
  /** The verifier round. */
  readonly verdicts: ReadonlyArray<Verdict>
  readonly round: number
  readonly judge: ReadonlyArray<Judge>
  readonly directory: string
  readonly role: "verifier" | "reviewer"
  readonly about: ReadonlyArray<string>
  readonly asking: Option.Option<SessionID>
  readonly missingAsked: boolean
  /** Worker failures in a row, and the last one's message. */
  readonly failures: number
  readonly error: string
  readonly runStart: number
  /** The milliseconds left on the task clock when it last started. */
  readonly clockLeft: number
}

type Event = UnitMoved | SpecReloaded | TaskHooks.HookEvent | TaskWorkers.TurnEvent | { readonly type: "clock.expired" }

/** Worker failures in a row that end the task with `harness error: …` (SV6). */
export const FAILURE_LIMIT = 3

/** The pause before a failed worker runs again. */
export const RETRY_DELAY = Duration.seconds(1)

const isLeaf = (task: BlendModel.Task) => task.children.length === 0

const obligationsOf = (spec: BlendModel.Spec, task: string) =>
  spec.obligations.filter((obligation) => obligation.task === task)

const minutes = (duration: Duration.Duration) => Math.round(Duration.toMinutes(duration))

const message = (error: unknown) =>
  TaskSessions.oneLine(Predicate.hasProperty(error, "message") ? String(error.message) : String(error)).slice(0, 600)

// --- the task's workers, each one Effect that ends in the fact it records ---------------------------------------------

/** A ready leaf: its worktree and builder session, then `task.started`. */
const beginTask = (input: { readonly run: TaskWorkers.Run; readonly task: BlendModel.Task }) =>
  Effect.gen(function* () {
    const started = yield* TaskWorkers.begin(input.run, input.task)
    yield* TaskWorkers.record(input.run, { type: "task.started", task: input.task.id, ...started })
    return started
  })

/** A task in `proving` (or a ready parent's review proof): the proofs, then `task.proved`. */
const proveTask = (input: {
  readonly run: TaskWorkers.Run
  readonly task: BlendModel.Task
  readonly spec: BlendModel.Spec
}) =>
  Effect.gen(function* () {
    const proof = yield* TaskWorkers.proof(input.run, input.task, input.spec)
    yield* TaskWorkers.record(input.run, {
      type: "task.proved",
      task: input.task.id,
      results: proof.results,
      ...Option.match(proof.reason, { onNone: () => ({}), onSome: (reason) => ({ reason }) }),
    })
  })

/** The builder called `task_ready`: its work is committed, and `task.ready` names the head the proofs run on. */
const readyTask = (input: {
  readonly run: TaskWorkers.Run
  readonly task: BlendModel.Task
  readonly attempt: string
}) =>
  Effect.gen(function* () {
    const head = yield* TaskWorkers.commit(input.run, input.task.id, `${input.task.id}: ${input.attempt}`)
    yield* TaskWorkers.record(input.run, { type: "task.ready", task: input.task.id, head })
  })

/**
 * After the last nudge the builder still ended without `task_ready`: its work is committed and proved failed, so the
 * next attempt starts with every test obligation reopened (SV12).
 */
const unreadyTask = (input: {
  readonly run: TaskWorkers.Run
  readonly task: BlendModel.Task
  readonly spec: BlendModel.Spec
}) =>
  Effect.gen(function* () {
    const head = yield* TaskWorkers.commit(input.run, input.task.id, `${input.task.id}: work without task_ready`)
    yield* TaskWorkers.record(input.run, { type: "task.ready", task: input.task.id, head })
    const own = obligationsOf(input.spec, input.task.id)
    const tests = own.filter((obligation) => obligation.proof.kind === "test")
    const results = (tests.length > 0 ? tests : own).map(
      (obligation): Proved => ({ id: obligation.id, status: "failed", reason: TaskWorkers.NO_READY }),
    )
    yield* TaskWorkers.record(input.run, {
      type: "task.proved",
      task: input.task.id,
      results,
      reason: TaskWorkers.NO_READY,
    })
  })

/** What a verifier round judges: the task's obligations in `passed`, where, and how the judge is told about it. */
const prepareRound = (input: {
  readonly run: TaskWorkers.Run
  readonly task: BlendModel.Task
  readonly spec: BlendModel.Spec
}) =>
  Effect.gen(function* () {
    const state = TaskEngineXState.view(yield* input.run.recorder.actor.getSnapshot)
    const model = state.tasks[input.task.id]
    const judge = obligationsOf(input.spec, input.task.id)
      .filter((obligation) => state.obligations[obligation.id]?.state === "passed")
      .map((obligation): Judge => ({ id: obligation.id, text: obligation.text }))
    const leaf = isLeaf(input.task)
    return {
      judge,
      directory: leaf && model?.worktree !== undefined ? model.worktree : input.run.directory,
      role: leaf ? ("verifier" as const) : ("reviewer" as const),
      about: leaf
        ? [`You verify task ${input.task.id}: ${input.task.title}.`, `Goal: ${TaskSessions.oneLine(input.task.goal)}`]
        : [
            `You review task ${input.task.id}: ${input.task.title}. Its children are trusted and merged on the ${input.run.base} branch.`,
            `Review their combined diff on the ${input.run.base} branch (git log, git diff) against the obligations above.`,
          ],
    }
  })

/**
 * The end of a verifier round: a leaf whose obligations all end trusted merges its proved head first (unless it is
 * on the base branch already), then `task.verified`; a merge that fails records `task.failed`.
 */
const finishRound = (input: {
  readonly run: TaskWorkers.Run
  readonly task: BlendModel.Task
  readonly spec: BlendModel.Spec
  readonly verdicts: ReadonlyArray<Verdict>
}) =>
  Effect.gen(function* () {
    const state = TaskEngineXState.view(yield* input.run.recorder.actor.getSnapshot)
    const model = state.tasks[input.task.id]
    const verdicts = TaskWorkers.latestVerdicts(input.verdicts)
    const trusted = obligationsOf(input.spec, input.task.id).every(
      (obligation) =>
        state.obligations[obligation.id]?.state === "trusted" ||
        verdicts.some((verdict) => verdict.id === obligation.id && verdict.verdict === "trusted"),
    )
    if (isLeaf(input.task) && trusted && model?.head !== undefined) {
      const merged = yield* Effect.result(TaskWorkers.merge(input.run, model.head))
      if (merged._tag === "Failure")
        return yield* TaskWorkers.record(input.run, {
          type: "task.failed",
          task: input.task.id,
          reason: `merge: ${message(merged.failure)}`,
        })
    }
    return yield* TaskWorkers.record(input.run, { type: "task.verified", task: input.task.id, verdicts })
  })

const recordFact = (input: { readonly run: TaskWorkers.Run; readonly fact: Unstamped }) =>
  TaskWorkers.record(input.run, input.fact)

// --- the machine ------------------------------------------------------------------------------------------------------

const has = (tags: ReadonlyArray<string>, tag: string) => tags.includes(tag)

const phaseOf = (tags: ReadonlyArray<string>): Phase => {
  if (has(tags, "ready")) return "ready"
  if (has(tags, "building")) return "building"
  if (has(tags, "proving")) return "proving"
  if (has(tags, "verifying")) return "verifying"
  return "none"
}

const missing = (context: Context) =>
  context.judge.filter((item) => !context.verdicts.some((verdict) => verdict.id === item.id))

const wallClock = (context: Context) => context.run.limits.taskWallClock

// The time a fresh clock or a respawned one has left.
const clockLeft = (input: Input) =>
  Option.match(input.run.limits.taskWallClock, {
    onNone: () => 0,
    onSome: (limit) =>
      input.clock === undefined
        ? Duration.toMillis(limit)
        : Math.max(0, Duration.toMillis(limit) - (input.clock.now - Math.max(input.clock.start, input.runStart))),
  })

/** The task supervisor's logic; the run supervisor spawns it as `task:<runID>:<taskId>` with an `Input`. */
export const machine = setup({
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- xstate reads `types` for its type parameters only
  types: {} as { context: Context; events: Event; input: Input },
  actors: {
    begin: fromEffect(({ input }: { input: Parameters<typeof beginTask>[0] }) => beginTask(input)),
    prove: fromEffect(({ input }: { input: Parameters<typeof proveTask>[0] }) => proveTask(input)),
    builderTurn: fromEffect(
      ({ input }: { input: { run: TaskWorkers.Run } & Parameters<typeof TaskWorkers.builderTurn>[1] }) =>
        TaskWorkers.builderTurn(input.run, input),
    ),
    sessionEvents: TaskWorkers.sessionEvents,
    ready: fromEffect(({ input }: { input: Parameters<typeof readyTask>[0] }) => readyTask(input)),
    unready: fromEffect(({ input }: { input: Parameters<typeof unreadyTask>[0] }) => unreadyTask(input)),
    record: fromEffect(({ input }: { input: Parameters<typeof recordFact>[0] }) => recordFact(input)),
    prepareRound: fromEffect(({ input }: { input: Parameters<typeof prepareRound>[0] }) => prepareRound(input)),
    verifierPrompt: fromEffect(
      ({ input }: { input: { run: TaskWorkers.Run } & Parameters<typeof TaskWorkers.verifierPrompt>[1] }) =>
        TaskWorkers.verifierPrompt(input.run, input),
    ),
    restore: fromEffect(({ input }: { input: { run: TaskWorkers.Run; directory: string } }) =>
      TaskWorkers.restore(input.run, input.directory),
    ),
    finishRound: fromEffect(({ input }: { input: Parameters<typeof finishRound>[0] }) => finishRound(input)),
  },
  actions: {
    // The reason of a spend-cap retry status.
    noteCap: assign({
      cap: ({ event }) =>
        event.type === "turn.status" ? `spend cap: ${TaskSessions.oneLine(event.message ?? "")}` : "",
    }),
    // A worker failed: one more failure in a row, and its message for the `harness error` reason.
    countFailure: assign(({ context, event }) => ({
      failures: context.failures + 1,
      error: "error" in event ? message(event.error) : "a worker failed",
    })),
  },
  delays: {
    streamIdle: ({ context }: { context: Context }) => Duration.toMillis(context.run.limits.streamIdle),
    retry: Duration.toMillis(RETRY_DELAY),
    wallClock: ({ context }: { context: Context }) => context.clockLeft,
  },
  guards: {
    spendCap: ({ event }) =>
      event.type === "turn.status" && event.status === "retry" && TaskSessions.SPEND_CAP.test(event.message ?? ""),
    fresh: ({ context, event }) => event.type === "unit.moved" && event.latest && event.entry > context.entry,
    leaf: ({ context }) => isLeaf(context.task),
    clocked: ({ context }) => Option.isSome(wallClock(context)),
    capped: ({ context }) => Option.isSome(Option.flatMap(context.turn, (turn) => turn.spendCap)),
    repeated: ({ context }) => Option.isSome(context.repeated),
    readied: ({ context }) => context.ready,
    nudgeLeft: ({ context }) => context.nudges < 2,
    failureLeft: ({ context }) => context.failures + 1 < FAILURE_LIMIT,
    noJudge: ({ context }) => context.judge.length === 0,
    verdicts: ({ context }) => context.verdicts.length > 0,
    askMissing: ({ context }) => context.verdicts.length > 0 && missing(context).length > 0 && !context.missingAsked,
    anotherRound: ({ context }) => context.round < 2,
  },
}).createMachine({
  id: "task",
  context: ({ input }) => ({
    run: input.run,
    events: input.events,
    task: input.task,
    spec: input.spec,
    owner: input.owner,
    entry: input.entry,
    tags: input.tags,
    phase: phaseOf(input.tags),
    session: Option.fromNullishOr(input.session),
    limit: input.run.limits.repetitionLimit,
    prompt: "attempt",
    nudges: 0,
    ready: false,
    repeated: Option.none(),
    turn: Option.none(),
    cap: "",
    verdicts: [],
    round: 1,
    judge: [],
    directory: input.run.directory,
    role: "verifier",
    about: [],
    asking: Option.none(),
    missingAsked: false,
    failures: 0,
    error: "",
    runStart: input.runStart,
    clockLeft: clockLeft(input),
  }),
  initial: "live",
  states: {
    live: {
      type: "parallel",
      on: {
        "clock.expired": "expired",
        "spec.reloaded": { actions: assign({ spec: ({ event }) => event.spec }) },
        "hook.ready": { actions: assign({ ready: true }) },
        "hook.repeated": { actions: assign({ repeated: ({ event }) => Option.some(event.reason) }) },
        "hook.verdicts": {
          actions: assign({
            verdicts: ({ context, event }) => [
              ...context.verdicts,
              ...event.verdicts.filter((verdict) => context.judge.some((item) => item.id === verdict.id)),
            ],
          }),
        },
      },
      states: {
        work: {
          initial: "start",
          on: {
            "unit.moved": {
              guard: "fresh",
              target: ".start",
              reenter: true,
              actions: assign(({ context, event }) => {
                const phase = phaseOf(event.tags)
                // A new attempt (a phase change into building) starts with its message and no nudge; a building entry
                // that the supervisor caused (a stall, a nudge) keeps the prompt it chose.
                const attempt = phase === "building" && context.phase !== "building"
                return {
                  entry: event.entry,
                  tags: event.tags,
                  phase,
                  session: event.session === undefined ? context.session : Option.some(event.session),
                  prompt: attempt ? ("attempt" as const) : context.prompt,
                  nudges: attempt ? 0 : context.nudges,
                }
              }),
            },
          },
          states: {
            // Starts the work that the unit's phase tag calls for.
            start: {
              always: [
                { guard: ({ context }) => context.phase === "ready" && isLeaf(context.task), target: "beginning" },
                { guard: ({ context }) => context.phase === "ready" || context.phase === "proving", target: "proving" },
                { guard: ({ context }) => context.phase === "building", target: "building" },
                { guard: ({ context }) => context.phase === "verifying", target: "verifying" },
                { target: "quiet" },
              ],
            },
            beginning: {
              invoke: {
                src: "begin",
                input: ({ context }) => ({ run: context.run, task: context.task }),
                onDone: {
                  target: "quiet",
                  actions: assign({
                    failures: 0,
                    session: ({ context, event }) =>
                      Option.match(event.output, {
                        onNone: () => context.session,
                        onSome: (out) => Option.some(out.session),
                      }),
                  }),
                },
                onError: [
                  { guard: "failureLeft", target: "retrying", actions: "countFailure" },
                  { target: "failing", actions: "countFailure" },
                ],
              },
            },
            proving: {
              invoke: {
                src: "prove",
                input: ({ context }) => ({ run: context.run, task: context.task, spec: context.spec }),
                onDone: { target: "quiet", actions: assign({ failures: 0 }) },
                onError: [
                  { guard: "failureLeft", target: "retrying", actions: "countFailure" },
                  { target: "failing", actions: "countFailure" },
                ],
              },
            },
            building: {
              initial: "turn",
              states: {
                turn: {
                  entry: assign({ ready: false, repeated: Option.none(), turn: Option.none() }),
                  invoke: [
                    {
                      src: "builderTurn",
                      input: ({ context }) => ({
                        run: context.run,
                        task: context.task,
                        spec: context.spec,
                        prompt: context.prompt,
                        owner: context.owner,
                      }),
                      onDone: { target: "ended", actions: assign({ failures: 0, turn: ({ event }) => event.output }) },
                      onError: [
                        { guard: "failureLeft", target: "#task.live.work.retrying", actions: "countFailure" },
                        { target: "#task.live.work.failing", actions: "countFailure" },
                      ],
                    },
                    {
                      src: "sessionEvents",
                      input: ({ context }) => ({
                        events: context.events,
                        session: Option.getOrElse(context.session, () => ""),
                      }),
                    },
                  ],
                  initial: "watching",
                  states: {
                    // The stream must move within streamIdle; any activity restarts the timer (SV10). A provider retry
                    // whose message is a spend cap ends the turn: a human must act (SV11, H14).
                    watching: {
                      after: { streamIdle: "#task.live.work.building.stalling" },
                      on: {
                        "turn.activity": { target: "watching", reenter: true },
                        "turn.status": [
                          { guard: "spendCap", target: "#task.live.work.building.spendCap", actions: "noteCap" },
                          { target: "watching", reenter: true },
                        ],
                        "turn.tool": [
                          { guard: ({ event }) => event.running, target: "tool" },
                          { target: "watching", reenter: true },
                        ],
                      },
                    },
                    // No stall timer while a tool runs (SV23).
                    tool: {
                      on: {
                        "turn.status": {
                          guard: "spendCap",
                          target: "#task.live.work.building.spendCap",
                          actions: "noteCap",
                        },
                        "turn.tool": { guard: ({ event }) => !event.running, target: "watching" },
                      },
                    },
                  },
                },
                // Leaving the turn interrupts it, which cancels the session turn; the stall spends no nudge (H12).
                stalling: {
                  invoke: {
                    src: "record",
                    input: ({ context }) => ({
                      run: context.run,
                      fact: {
                        type: "task.stalled",
                        task: context.task.id,
                        reason: `stall: no stream activity for ${Math.round(Duration.toSeconds(context.run.limits.streamIdle))} s`,
                      },
                    }),
                    onDone: { target: "#task.live.work.quiet", actions: assign({ prompt: "continue" as const }) },
                    onError: { target: "#task.live.work.failing", actions: "countFailure" },
                  },
                },
                spendCap: {
                  invoke: {
                    src: "record",
                    input: ({ context }) => ({
                      run: context.run,
                      fact: { type: "task.needs_human", task: context.task.id, reason: context.cap },
                    }),
                    onDone: "#task.live.work.quiet",
                    onError: { target: "#task.live.work.failing", actions: "countFailure" },
                  },
                },
                // The turn ended: a spend cap first, then a repetition, then task_ready, then a nudge, then the end.
                ended: {
                  always: [
                    {
                      guard: "capped",
                      target: "spendCap",
                      actions: assign({
                        cap: ({ context }) =>
                          Option.getOrElse(
                            Option.flatMap(context.turn, (turn) => turn.spendCap),
                            () => "spend cap",
                          ),
                      }),
                    },
                    { guard: "repeated", target: "repeating" },
                    { guard: "readied", target: "readying" },
                    { guard: "nudgeLeft", target: "nudging" },
                    { target: "unready" },
                  ],
                },
                repeating: {
                  invoke: {
                    src: "record",
                    input: ({ context }) => ({
                      run: context.run,
                      fact: {
                        type: "task.repeated",
                        task: context.task.id,
                        reason: Option.getOrElse(context.repeated, () => "repetition"),
                      },
                    }),
                    onDone: {
                      target: "#task.live.work.quiet",
                      actions: assign({ prompt: "attempt" as const, nudges: 0 }),
                    },
                    onError: { target: "#task.live.work.failing", actions: "countFailure" },
                  },
                },
                readying: {
                  invoke: {
                    src: "ready",
                    input: ({ context }) => ({ run: context.run, task: context.task, attempt: "ready" }),
                    onDone: { target: "#task.live.work.quiet", actions: assign({ failures: 0 }) },
                    onError: [
                      { guard: "failureLeft", target: "#task.live.work.retrying", actions: "countFailure" },
                      { target: "#task.live.work.failing", actions: "countFailure" },
                    ],
                  },
                },
                nudging: {
                  invoke: {
                    src: "record",
                    input: ({ context }) => ({
                      run: context.run,
                      fact: {
                        type: "task.nudged",
                        task: context.task.id,
                        nudge: context.nudges === 0 ? (1 as const) : (2 as const),
                        reason: TaskWorkers.NO_READY,
                      },
                    }),
                    onDone: {
                      target: "#task.live.work.quiet",
                      actions: assign({ nudges: ({ context }) => context.nudges + 1, prompt: "nudge" as const }),
                    },
                    onError: { target: "#task.live.work.failing", actions: "countFailure" },
                  },
                },
                unready: {
                  invoke: {
                    src: "unready",
                    input: ({ context }) => ({ run: context.run, task: context.task, spec: context.spec }),
                    onDone: { target: "#task.live.work.quiet", actions: assign({ failures: 0 }) },
                    onError: [
                      { guard: "failureLeft", target: "#task.live.work.retrying", actions: "countFailure" },
                      { target: "#task.live.work.failing", actions: "countFailure" },
                    ],
                  },
                },
              },
            },
            // The verifier round (AD-8): ask, collect, ask once more for missing ids, collect; a second session when
            // the first gave no verdict.
            verifying: {
              initial: "preparing",
              entry: assign({ round: 1, verdicts: [], asking: Option.none(), missingAsked: false }),
              states: {
                preparing: {
                  invoke: {
                    src: "prepareRound",
                    input: ({ context }) => ({ run: context.run, task: context.task, spec: context.spec }),
                    onDone: {
                      target: "asked",
                      actions: assign(({ context, event }) =>
                        Option.match(event.output, {
                          onNone: () => ({}),
                          onSome: (round) => ({
                            judge: round.judge,
                            directory: round.directory,
                            role: round.role,
                            about: round.about,
                            failures: context.failures,
                          }),
                        }),
                      ),
                    },
                    onError: [
                      { guard: "failureLeft", target: "#task.live.work.retrying", actions: "countFailure" },
                      { target: "#task.live.work.failing", actions: "countFailure" },
                    ],
                  },
                },
                asked: {
                  always: [{ guard: "noJudge", target: "finishing" }, { target: "ask" }],
                },
                ask: {
                  entry: assign({ verdicts: [], asking: Option.none(), missingAsked: false }),
                  invoke: {
                    src: "verifierPrompt",
                    input: ({ context }) => ({
                      run: context.run,
                      directory: context.directory,
                      session: Option.none(),
                      title: `${context.task.id} ${context.role}${context.round > 1 ? " (again)" : ""}`,
                      text: TaskSessions.judgeMessage({
                        role: context.role,
                        kind: "task",
                        unit: context.task.id,
                        judge: context.judge,
                        about: context.about,
                      }),
                      owner: context.owner,
                    }),
                    onDone: {
                      target: "collect",
                      actions: assign({
                        failures: 0,
                        asking: ({ event }) => Option.map(event.output, (turn) => turn.session),
                      }),
                    },
                    onError: [
                      { guard: "failureLeft", target: "#task.live.work.retrying", actions: "countFailure" },
                      { target: "#task.live.work.failing", actions: "countFailure" },
                    ],
                  },
                },
                collect: {
                  always: [{ guard: "askMissing", target: "askMissing" }, { target: "restoring" }],
                },
                askMissing: {
                  entry: assign({ missingAsked: true }),
                  invoke: {
                    src: "verifierPrompt",
                    input: ({ context }) => ({
                      run: context.run,
                      directory: context.directory,
                      session: context.asking,
                      title: `${context.task.id} ${context.role}`,
                      text: TaskSessions.judgeMissingMessage(missing(context)),
                      owner: context.owner,
                    }),
                    onDone: { target: "restoring", actions: assign({ failures: 0 }) },
                    onError: [
                      { guard: "failureLeft", target: "#task.live.work.retrying", actions: "countFailure" },
                      { target: "#task.live.work.failing", actions: "countFailure" },
                    ],
                  },
                },
                // Whatever the judge left in its directory goes, so it reaches neither a proof nor a builder commit.
                restoring: {
                  invoke: {
                    src: "restore",
                    input: ({ context }) => ({ run: context.run, directory: context.directory }),
                    onDone: [
                      { guard: "verdicts", target: "finishing" },
                      { guard: "anotherRound", target: "ask", actions: assign({ round: 2 }) },
                      { target: "noVerdict" },
                    ],
                    onError: [
                      { guard: "failureLeft", target: "#task.live.work.retrying", actions: "countFailure" },
                      { target: "#task.live.work.failing", actions: "countFailure" },
                    ],
                  },
                },
                finishing: {
                  invoke: {
                    src: "finishRound",
                    input: ({ context }) => ({
                      run: context.run,
                      task: context.task,
                      spec: context.spec,
                      verdicts: context.verdicts,
                    }),
                    onDone: { target: "#task.live.work.quiet", actions: assign({ failures: 0 }) },
                    onError: [
                      { guard: "failureLeft", target: "#task.live.work.retrying", actions: "countFailure" },
                      { target: "#task.live.work.failing", actions: "countFailure" },
                    ],
                  },
                },
                noVerdict: {
                  invoke: {
                    src: "record",
                    input: ({ context }) => ({
                      run: context.run,
                      fact: { type: "task.failed", task: context.task.id, reason: "no verdict" },
                    }),
                    onDone: "#task.live.work.quiet",
                    onError: { target: "#task.live.work.failing", actions: "countFailure" },
                  },
                },
              },
            },
            // A worker failed: its phase's work starts again after a pause.
            retrying: {
              after: { retry: { target: "start", reenter: true } },
            },
            // The third worker failure in a row ends the task (SV6).
            failing: {
              invoke: {
                src: "record",
                input: ({ context }) => ({
                  run: context.run,
                  fact: { type: "task.failed", task: context.task.id, reason: `harness error: ${context.error}` },
                }),
                onDone: "quiet",
                onError: "quiet",
              },
            },
            quiet: {},
          },
        },
        // The task wall clock: one delayed transition from the latest building entry (SV22).
        clock: {
          initial: "init",
          on: {
            "unit.moved": {
              guard: ({ context, event }) =>
                event.latest &&
                event.entry > context.entry &&
                has(event.tags, "building") &&
                Option.isSome(wallClock(context)),
              target: ".on",
              reenter: true,
              actions: assign({
                clockLeft: ({ context }) =>
                  Option.match(wallClock(context), { onNone: () => 0, onSome: Duration.toMillis }),
              }),
            },
          },
          states: {
            init: {
              always: [
                {
                  guard: ({ context }) =>
                    Option.isSome(wallClock(context)) &&
                    (context.phase === "building" || context.phase === "proving" || context.phase === "verifying"),
                  target: "on",
                },
                { target: "off" },
              ],
            },
            off: {},
            on: { after: { wallClock: { actions: raise({ type: "clock.expired" }) } } },
          },
        },
      },
    },
    // The clock expired: the work stopped when `live` exited, which cancels a turn in flight.
    expired: {
      invoke: {
        src: "record",
        input: ({ context }) => ({
          run: context.run,
          fact: {
            type: "task.failed",
            task: context.task.id,
            reason: `wall clock: the task took over ${Option.match(wallClock(context), { onNone: () => 0, onSome: minutes })} min`,
          },
        }),
        onDone: "ended",
        onError: "ended",
      },
    },
    ended: {},
  },
})

export type TaskSupervisor = ActorRefFrom<typeof machine>

export * as TaskSupervisor from "./task"
