export * as Sqlite from "./sqlite"

import { Context } from "effect"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"

/**
 * The sync drizzle database that both drivers provide: drizzle-orm/bun-sqlite and drizzle-orm/node-sqlite both
 * return a subclass of BaseSQLiteDatabase<"sync", ...>. Their run() result differs (void for bun, node:sqlite
 * StatementResultingChanges for node), so the shared service leaves it unknown.
 */
export type DrizzleClient = BaseSQLiteDatabase<"sync", unknown>
export class Native extends Context.Service<Native, unknown>()("@opencode-ai/core/database/SqliteNative") {}
export class Drizzle extends Context.Service<Drizzle, DrizzleClient>()("@opencode-ai/core/database/SqliteDrizzle") {}
