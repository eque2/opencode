import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Config, Effect, Layer, Option, Record, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

// Stored auth data is a JSON object keyed by provider. Each value decodes as Info on its own,
// so one malformed entry does not hide the others.
const StoredAuth = Schema.Record(Schema.String, Schema.Json)
type StoredAuth = typeof StoredAuth.Type
const decodeStored = Schema.decodeUnknownOption(StoredAuth)
const decodeStoredJson = Schema.decodeUnknownOption(Schema.fromJsonString(StoredAuth))

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    const all = Effect.fn("Auth.all")(function* () {
      // Hosts and tests set OPENCODE_AUTH_CONTENT between reads, so each read takes a fresh env snapshot.
      const content = yield* readEnvSnapshot(Config.option(Config.String("OPENCODE_AUTH_CONTENT")))
      const inline = content.pipe(
        Option.filter((value) => value !== ""),
        Option.flatMap(decodeStoredJson),
      )
      const data: StoredAuth = Option.isSome(inline)
        ? inline.value
        : yield* fsys.readJson(file).pipe(
            Effect.map((value) => Option.getOrElse(decodeStored(value), () => ({}))),
            Effect.orElseSucceed(() => ({})),
          )
      return Record.getSomes(Record.map(data, (value) => decode(value)))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Auth from "."
