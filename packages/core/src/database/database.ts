export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer, Option } from "effect"
import { Global } from "../global"
import { FlagConfig, truthyConfig } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

/**
 * The database file. OPENCODE_DB wins when set: ":memory:", an absolute path, or a file name under the data
 * directory. Otherwise the release channels and OPENCODE_DISABLE_CHANNEL_DB share opencode.db, and each other
 * channel has its own file. Both variables are optional, so a ConfigError is a defect.
 */
export const path: Effect.Effect<string> = Effect.gen(function* () {
  const configured = yield* FlagConfig.OPENCODE_DB
  if (Option.isSome(configured)) {
    const file = configured.value
    if (file === ":memory:" || isAbsolute(file)) return file
    return join(Global.Path.data, file)
  }
  if (["latest", "beta", "prod"].includes(InstallationChannel) || (yield* truthyConfig("OPENCODE_DISABLE_CHANNEL_DB")))
    return join(Global.Path.data, "opencode.db")
  return join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}).pipe(Effect.orDie)

export const node = makeGlobalNode({ service: Service, layer: Layer.unwrap(Effect.map(path, layerFromPath)), deps: [] })
