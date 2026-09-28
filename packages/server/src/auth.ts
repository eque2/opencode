export * as ServerAuth from "./auth"

import { Config as EffectConfig, ConfigProvider, Context, Effect, Layer, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
}

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        return Config.of(
          yield* EffectConfig.all({
            password: EffectConfig.String("OPENCODE_SERVER_PASSWORD").pipe(EffectConfig.option),
            username: EffectConfig.String("OPENCODE_SERVER_USERNAME").pipe(EffectConfig.withDefault("opencode")),
          }),
        )
      }),
    )
  }
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

const ClientEnv = EffectConfig.all({
  password: EffectConfig.Redacted("OPENCODE_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.String("OPENCODE_SERVER_USERNAME").pipe(EffectConfig.option),
})

// Clients read the environment at each call, because hosts and tests change it at run time.
// Each read parses a fresh provider that keeps empty strings, as the former `process.env.X ??`
// reads did. Optional configs cannot fail on a missing variable, so a ConfigError is a defect.
const readClientEnv = Effect.suspend(() =>
  ClientEnv.parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
).pipe(Effect.orDie)

export const header = Effect.fn("ServerAuth.header")(function* (credentials?: Credentials) {
  const env = yield* readClientEnv
  const password = Option.fromNullishOr(credentials?.password).pipe(
    Option.orElse(() => Option.map(env.password, Redacted.value)),
    Option.filter((value) => value !== ""),
  )
  if (Option.isNone(password)) return undefined

  const username = Option.fromNullishOr(credentials?.username).pipe(
    Option.orElse(() => env.username),
    Option.getOrElse(() => "opencode"),
  )
  return `Basic ${Buffer.from(`${username}:${password.value}`).toString("base64")}`
})

export const headers = Effect.fn("ServerAuth.headers")(function* (credentials?: Credentials) {
  const authorization = yield* header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
})
