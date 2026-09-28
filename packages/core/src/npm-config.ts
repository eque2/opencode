export * as NpmConfig from "./npm-config"

import { fileURLToPath } from "url"
// @ts-expect-error npm does not publish types for this internal config API.
import Config from "@npmcli/config"
// @ts-expect-error npm does not publish types for this internal config API.
import { definitions, flatten, nerfDarts, shorthands } from "@npmcli/config/lib/definitions/index.js"
import { Effect, Predicate, Schema } from "effect"

const npmPath = fileURLToPath(new URL("..", import.meta.url))

/** The npm configuration for a directory could not be read. `load` recovers with an empty configuration. */
export class LoadError extends Schema.TaggedError<LoadError>()("NpmConfig.LoadError", {
  dir: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const load = (dir: string) =>
  Effect.gen(function* () {
    const config = yield* Effect.try({
      try: () =>
        new Config({
          npmPath,
          cwd: dir,
          env: { ...process.env },
          argv: [process.execPath, process.execPath],
          execPath: process.execPath,
          platform: process.platform,
          definitions,
          flatten,
          nerfDarts,
          shorthands,
          warn: false,
        }),
      catch: (cause) => new LoadError({ dir, cause }),
    })
    yield* Effect.tryPromise({ try: () => config.load(), catch: (cause) => new LoadError({ dir, cause }) })
    // @npmcli/config has no published types, so check that the flat options are an object before use.
    const flat: unknown = config.flat
    return Predicate.isObject(flat) ? flat : {}
  }).pipe(Effect.orElseSucceed((): Record<string, unknown> => ({})))

export const registry = (dir: string) =>
  load(dir).pipe(
    Effect.map((config) => {
      const registry = typeof config.registry === "string" ? config.registry : "https://registry.npmjs.org"
      return registry.endsWith("/") ? registry.slice(0, -1) : registry
    }),
  )
