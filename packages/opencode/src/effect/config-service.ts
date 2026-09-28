import { Config, Context, Effect, Layer } from "effect"

type ConfigMap = Record<string, Config.Config<unknown>>

/**
 * The service shape inferred from an object of Effect `Config` definitions.
 */
export type Shape<Fields extends ConfigMap> = {
  readonly [Key in keyof Fields]: Config.Success<Fields[Key]>
}

/**
 * A Context service class with generated layers for config-backed services.
 */
export type ServiceClass<Self, Id extends string, Service> = Context.ServiceClass<Self, Id, Service> & {
  /** Provide already-parsed config, useful in tests. */
  readonly configLayer: (input: Service) => Layer.Layer<Self>
  /** Parse config once from the active Effect ConfigProvider and provide the service. */
  readonly layer: Layer.Layer<Self, Config.ConfigError>
}

/**
 * Create a Context service whose implementation is derived from Effect `Config`.
 *
 * This keeps Effect `Config` as the source of truth for env names, defaults, and
 * validation while generating a typed service plus convenient production/test
 * layers.
 *
 * ```ts
 * class ServerAuthConfig extends ConfigService.Service<ServerAuthConfig>()(
 *   "@opencode/ServerAuthConfig",
 *   {
 *     password: Config.String("OPENCODE_SERVER_PASSWORD").pipe(Config.option),
 *     username: Config.String("OPENCODE_SERVER_USERNAME").pipe(Config.withDefault("opencode")),
 *   },
 * ) {}
 *
 * const live = ServerAuthConfig.layer
 * const test = ServerAuthConfig.configLayer({ password: Option.some("secret"), username: "kit" })
 * ```
 */
export const Service =
  <Self>() =>
  <const Id extends string, const Fields extends ConfigMap>(
    id: Id,
    fields: Fields,
  ): ServiceClass<Self, Id, Shape<Fields>> => {
    // eslint-disable-next-line effect/require-service-identifier -- (d) the identifier is the caller's string literal, passed through this factory's typed `Id extends string` parameter; the rule accepts only an inline literal.
    const tag = Context.Service<Self, Shape<Fields>>()(id)
    return Object.assign(tag, {
      configLayer: (input: Shape<Fields>) => Layer.succeed(tag, tag.of(input)),
      // Fresh, so each use site parses config from its own ConfigProvider instead of sharing a memoized build.
      layer: Layer.fresh(
        Layer.effect(
          tag,
          Effect.gen(function* () {
            const config = yield* Config.all(fields)
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) Config.all returns a conditional type (tuple, iterable, or record) that TypeScript cannot resolve for the generic Fields; for a record input it is exactly Shape<Fields>.
            return tag.of(config as Shape<Fields>)
          }),
        ),
      ),
    })
  }

export * as ConfigService from "./config-service"
