import { Effect, Option, Predicate } from "effect"
import { TableEngine } from "@/task/engine-table"
import type { Engine } from "./model"
import type { Harness } from "./selector"

// The engine registry: the harness option picks the engine, and only the engine. O1 folds through the transition
// table; O2's xstate engine is loaded on demand, so O1 builds and runs without it.

const XSTATE = "@/task/engine-xstate"

const isEngine = (value: unknown): value is Engine =>
  Predicate.hasProperty(value, "name") &&
  (value.name === "table" || value.name === "xstate") &&
  Predicate.hasProperty(value, "initial") &&
  Predicate.isFunction(value.initial) &&
  Predicate.hasProperty(value, "apply") &&
  Predicate.isFunction(value.apply)

// The first export of the module that is an engine named `xstate`.
const xstate = Effect.tryPromise({
  try: (): Promise<unknown> => import(XSTATE),
  catch: (cause) => cause,
}).pipe(
  Effect.map((module) =>
    Predicate.isObject(module)
      ? Option.fromNullishOr(
          Object.values(module).find((value): value is Engine => isEngine(value) && value.name === "xstate"),
        )
      : Option.none<Engine>(),
  ),
  Effect.catch(() => Effect.succeed(Option.none<Engine>())),
)

/** The engine of a harness option; none for an option without an in-core engine (O3), or when O2's is missing. */
export const forHarness = (harness: Harness): Effect.Effect<Option.Option<Engine>> => {
  if (harness === "o1") return Effect.succeed(Option.some(TableEngine))
  if (harness === "o2") return xstate
  return Effect.succeed(Option.none())
}

export * as TaskEngines from "./engines"
