import { Duration, Option, Predicate } from "effect"
import { type ActorRefFrom, assign, fromEffect, setup } from "@jambudipa/xstate-effect"
import type { SessionID } from "@/session/schema"
import type { BlendModel } from "@/task/blend/model"
import type { TaskHooks } from "../hooks"
import type { Verdict } from "../model"
import type { Unstamped } from "../recorder"
import { TaskSessions } from "../sessions"
import { TaskWorkers } from "../workers"
import type { SpecReloaded, UnitMoved } from "./task"

// The scenario supervisor (spine AD-8): one actor per scenario while the scenario is in `verifying`. It runs the
// scenario's judge round in the root checkout (ask, collect, ask once more for a missing verdict, collect; a second
// session when the first gives none) and records `scenario.verified`, the only fact it records. It owns the judge
// session's hooks. The batch proof of the `ready` scenarios belongs to the run supervisor.

export interface Input {
  readonly run: TaskWorkers.Run
  readonly scenario: BlendModel.Scenario
  /** This supervisor's system id, `scenario:<runID>:<scenarioId>`: the owner of the judge sessions it claims. */
  readonly owner: string
  /** The unit at spawn: its newest entry and its tags. */
  readonly entry: number
  readonly tags: ReadonlyArray<string>
}

interface Context {
  readonly run: TaskWorkers.Run
  readonly scenario: BlendModel.Scenario
  readonly owner: string
  readonly entry: number
  readonly tags: ReadonlyArray<string>
  /** The verdicts for this scenario the judge recorded in the current session. */
  readonly verdicts: ReadonlyArray<Verdict>
  /** Whether the judge called `verdict` at all in the current session. */
  readonly answered: boolean
  readonly round: number
  readonly asking: Option.Option<SessionID>
  readonly missingAsked: boolean
  readonly failures: number
  readonly error: string
}

type Event = UnitMoved | SpecReloaded | TaskHooks.HookEvent

/** Worker failures in a row that reject the scenario with `harness error: …` (SV6). */
export const MAX_FAILURES = 3

const RETRY_DELAY = Duration.seconds(1)

const message = (error: unknown) =>
  TaskSessions.oneLine(Predicate.hasProperty(error, "message") ? String(error.message) : String(error)).slice(0, 600)

const verdictOf = (context: Context): Verdict =>
  TaskWorkers.latestVerdicts(context.verdicts).at(-1) ?? {
    id: context.scenario.id,
    verdict: "rejected",
    reason: "no verdict",
  }

const recordFact = (input: { readonly run: TaskWorkers.Run; readonly fact: Unstamped }) =>
  TaskWorkers.record(input.run, input.fact)

/** The scenario supervisor's logic; the run supervisor spawns it as `scenario:<runID>:<scenarioId>`. */
export const machine = setup({
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- xstate reads `types` for its type parameters only
  types: {} as { context: Context; events: Event; input: Input },
  actors: {
    judge: fromEffect(
      ({ input }: { input: { run: TaskWorkers.Run } & Parameters<typeof TaskWorkers.scenarioJudge>[1] }) =>
        TaskWorkers.scenarioJudge(input.run, input),
    ),
    restore: fromEffect(({ input }: { input: { run: TaskWorkers.Run } }) =>
      TaskWorkers.restore(input.run, input.run.directory),
    ),
    record: fromEffect(({ input }: { input: Parameters<typeof recordFact>[0] }) => recordFact(input)),
  },
  actions: {
    // A worker failed: one more failure in a row, and its message for the `harness error` reason.
    countFailure: assign(({ context, event }) => ({
      failures: context.failures + 1,
      error: "error" in event ? message(event.error) : "a worker failed",
    })),
  },
  delays: { retry: Duration.toMillis(RETRY_DELAY) },
  guards: {
    fresh: ({ context, event }) => event.type === "unit.moved" && event.latest && event.entry > context.entry,
    verifying: ({ context }) => context.tags.includes("verifying"),
    judged: ({ context }) => context.verdicts.length > 0,
    askMissing: ({ context }) => context.answered && context.verdicts.length === 0 && !context.missingAsked,
    anotherRound: ({ context }) => context.round < 2,
    failureLeft: ({ context }) => context.failures + 1 < MAX_FAILURES,
  },
}).createMachine({
  id: "scenario",
  context: ({ input }) => ({
    run: input.run,
    scenario: input.scenario,
    owner: input.owner,
    entry: input.entry,
    tags: input.tags,
    verdicts: [],
    answered: false,
    round: 1,
    asking: Option.none(),
    missingAsked: false,
    failures: 0,
    error: "",
  }),
  initial: "start",
  on: {
    "unit.moved": {
      guard: "fresh",
      target: ".start",
      reenter: true,
      actions: assign(({ event }) => ({ entry: event.entry, tags: event.tags })),
    },
    "spec.reloaded": {
      actions: assign({
        scenario: ({ context, event }) =>
          event.spec.scenarios.find((item) => item.id === context.scenario.id) ?? context.scenario,
      }),
    },
    "hook.verdicts": {
      actions: assign({
        answered: true,
        verdicts: ({ context, event }) => [
          ...context.verdicts,
          ...event.verdicts.filter((verdict) => verdict.id === context.scenario.id),
        ],
      }),
    },
  },
  states: {
    start: {
      always: [{ guard: "verifying", target: "judging" }, { target: "quiet" }],
    },
    judging: {
      initial: "ask",
      entry: assign({ round: 1 }),
      states: {
        ask: {
          entry: assign({ verdicts: [], answered: false, missingAsked: false, asking: Option.none() }),
          invoke: {
            src: "judge",
            input: ({ context }) => ({
              run: context.run,
              scenario: context.scenario,
              session: Option.none(),
              attempt: context.round,
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
              { guard: "failureLeft", target: "#scenario.retrying", actions: "countFailure" },
              { target: "#scenario.failing", actions: "countFailure" },
            ],
          },
        },
        collect: {
          always: [{ guard: "askMissing", target: "askMissing" }, { target: "restoring" }],
        },
        // The judge called `verdict` without this scenario's id: asked once more, in the same session.
        askMissing: {
          entry: assign({ missingAsked: true }),
          invoke: {
            src: "judge",
            input: ({ context }) => ({
              run: context.run,
              scenario: context.scenario,
              session: context.asking,
              attempt: context.round,
              owner: context.owner,
            }),
            onDone: { target: "restoring", actions: assign({ failures: 0 }) },
            onError: [
              { guard: "failureLeft", target: "#scenario.retrying", actions: "countFailure" },
              { target: "#scenario.failing", actions: "countFailure" },
            ],
          },
        },
        // Whatever the judge left in the root checkout goes.
        restoring: {
          invoke: {
            src: "restore",
            input: ({ context }) => ({ run: context.run }),
            onDone: [
              { guard: "judged", target: "verified" },
              { guard: "anotherRound", target: "ask", actions: assign({ round: 2 }) },
              { target: "verified" },
            ],
            onError: [
              { guard: "failureLeft", target: "#scenario.retrying", actions: "countFailure" },
              { target: "#scenario.failing", actions: "countFailure" },
            ],
          },
        },
        // The latest verdict, or a rejection with "no verdict" after two sessions gave none.
        verified: {
          invoke: {
            src: "record",
            input: ({ context }) => ({
              run: context.run,
              fact: { type: "scenario.verified", verdict: verdictOf(context) },
            }),
            onDone: "#scenario.quiet",
            onError: { target: "#scenario.failing", actions: "countFailure" },
          },
        },
      },
    },
    retrying: {
      after: { retry: { target: "start", reenter: true } },
    },
    // The third worker failure in a row rejects the scenario (SV6).
    failing: {
      invoke: {
        src: "record",
        input: ({ context }) => ({
          run: context.run,
          fact: {
            type: "scenario.verified",
            verdict: { id: context.scenario.id, verdict: "rejected", reason: `harness error: ${context.error}` },
          },
        }),
        onDone: "quiet",
        onError: "quiet",
      },
    },
    quiet: {},
  },
})

export type ScenarioSupervisor = ActorRefFrom<typeof machine>

export * as ScenarioSupervisor from "./scenario"
