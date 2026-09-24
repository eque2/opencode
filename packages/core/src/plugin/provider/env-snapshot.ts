import { Config, ConfigProvider, Effect } from "effect"

/**
 * Reads a Config from a fresh snapshot of the process environment.
 *
 * The ambient ConfigProvider copies process.env once per process. Provider plugins read the
 * environment each time they build an SDK, and hosts and tests change it between builds, so
 * each read takes a new snapshot. Empty strings stay values, so an empty variable still wins
 * over a configured option, as the former `process.env.X ?? option` reads did.
 *
 * Optional and defaulted configs cannot fail on a missing variable, so a ConfigError here is a
 * defect.
 */
export const readEnvSnapshot = <A>(config: Config.Config<A>): Effect.Effect<A> =>
  Effect.suspend(() => config.parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))).pipe(Effect.orDie)
