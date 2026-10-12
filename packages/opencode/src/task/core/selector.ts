import { Config, Effect } from "effect"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"

// Which task harness the server runs. `OPENCODE_TASK_HARNESS=o1|o2|o3` selects one; unset (or any other value)
// means none, and opencode behaves exactly as without the harness. Read from a fresh snapshot of the environment,
// as `@/task/limits` reads `OPENCODE_TASK_LIMITS`.

export type Harness = "o1" | "o2" | "o3"

/** The environment variable that selects the harness. */
export const variable = "OPENCODE_TASK_HARNESS"

const harnesses: ReadonlyArray<Harness> = ["o1", "o2", "o3"]

/** The harness a value names, or undefined. */
export const select = (value: string): Harness | undefined => harnesses.find((harness) => harness === value)

/** The harness `OPENCODE_TASK_HARNESS` selects. */
export const selected: Effect.Effect<Harness | undefined> = readEnvSnapshot(
  Config.String(variable).pipe(Config.withDefault("")),
).pipe(Effect.map(select))

/** True when an in-core harness (O1 or O2) runs: the `task` command, its agents, tools and repetition stop. */
export const inCore: Effect.Effect<boolean> = selected.pipe(
  Effect.map((harness) => harness === "o1" || harness === "o2"),
)

export * as TaskSelector from "./selector"
