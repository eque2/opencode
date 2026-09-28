import { Clock, Config, Effect, Option } from "effect"

type Fields = Record<string, string | number | boolean | undefined>

// OPENCODE_ACP_PROFILE=1 turns profiling on. The optional variable cannot fail, so a ConfigError is a defect.
const enabled = Config.String("OPENCODE_ACP_PROFILE").pipe(
  Config.option,
  Config.map((value) => Option.contains(value, "1")),
  Effect.orDie,
)

/** Logs the time since the process started. */
export const mark = Effect.fnUntraced(function* (name: string, fields?: Fields) {
  if (!(yield* enabled)) return
  const now = yield* Clock.currentTimeMillis
  yield* write(`${name}.mark`, now - performance.timeOrigin, fields)
})

/** Logs the time since `startedAt`, a Clock.currentTimeMillis reading. */
export const duration = Effect.fnUntraced(function* (name: string, startedAt: number, fields?: Fields) {
  if (!(yield* enabled)) return
  const now = yield* Clock.currentTimeMillis
  yield* write(name, now - startedAt, fields)
})

/** Logs how long the Effect runs, whether it succeeds or not. */
export const measure =
  (name: string, fields?: Fields) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if (!(yield* enabled)) return yield* self
      const started = yield* Clock.currentTimeMillis
      return yield* self.pipe(Effect.ensuring(duration(name, started, fields)))
    })

function write(name: string, durationMs: number, fields?: Fields) {
  const extra = fields
    ? Object.entries(fields)
        .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
    : ""
  return Effect.logInfo(`[acp-profile] ${name} ${Math.round(durationMs)}ms${extra ? ` ${extra}` : ""}`)
}

export * as ACPProfile from "./profile"
