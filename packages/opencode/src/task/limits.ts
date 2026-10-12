import { Config, Duration, Effect, Option } from "effect"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"

// The liveness bounds that every task-harness option uses. One source, so no option can run with
// looser bounds than another. `live` is for a real model run; `scripted` is for tests and replays.

/** The two bound sets. */
export type Mode = "live" | "scripted"

/** One set of liveness bounds. */
export interface Limits {
  readonly mode: Mode
  /** A model stream that sends nothing for this long is stalled. */
  readonly streamIdle: Duration.Duration
  /** One proof command (a test run, a gate, a git call) may run this long. */
  readonly proofTimeout: Duration.Duration
  /** After SIGTERM to a process group, wait this long, then send SIGKILL. */
  readonly cancelDeadline: Duration.Duration
  /** The wall clock of one task. Live only. */
  readonly taskWallClock: Option.Option<Duration.Duration>
  /** The wall clock of one live run. Live only. */
  readonly runWallClock: Option.Option<Duration.Duration>
  /** The repetition detector trips at this many identical calls. */
  readonly repetitionLimit: number
}

export const live: Limits = {
  mode: "live",
  streamIdle: Duration.seconds(300),
  proofTimeout: Duration.seconds(600),
  cancelDeadline: Duration.seconds(5),
  taskWallClock: Option.some(Duration.minutes(10)),
  runWallClock: Option.some(Duration.minutes(30)),
  repetitionLimit: 3,
}

export const scripted: Limits = {
  mode: "scripted",
  streamIdle: Duration.seconds(2),
  proofTimeout: Duration.seconds(5),
  cancelDeadline: Duration.seconds(1),
  taskWallClock: Option.none(),
  runWallClock: Option.none(),
  repetitionLimit: 3,
}

/** The environment variable that selects the bounds. */
export const variable = "OPENCODE_TASK_LIMITS"

/** `scripted` selects the scripted bounds. Any other value selects the live bounds. */
export const select = (value: string): Limits => (value === "scripted" ? scripted : live)

/** The bounds that `OPENCODE_TASK_LIMITS` selects, read from a fresh snapshot of the environment. */
export const load: Effect.Effect<Limits> = readEnvSnapshot(Config.String(variable).pipe(Config.withDefault(""))).pipe(
  Effect.map(select),
)

export * as TaskLimits from "./limits"
