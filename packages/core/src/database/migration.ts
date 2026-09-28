export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Clock, Effect, HashSet, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "session")) return yield* applyOnly(db, migrations)
      if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx)
          yield* tx.run(
            sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
          )
          yield* Effect.forEach(migrations, (migration) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              return yield* tx.run(
                sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${now})`,
              )
            }),
          )
        }),
      )
    }),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    const recorded = yield* completedIDs(db)
    // Existing installs used Drizzle's migration journal. Seed the new
    // journal once so TypeScript migrations don't replay old SQL.
    const completed =
      HashSet.size(recorded) === 0 &&
      (yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`))
        ? yield* seedLegacyJournal(db, input).pipe(Effect.andThen(completedIDs(db)))
        : recorded

    yield* Effect.forEach(
      input.filter((migration) => !HashSet.has(completed, migration.id)),
      (migration) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* migration.up(tx)
            const now = yield* Clock.currentTimeMillis
            yield* tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${now})`,
            )
          }),
        ),
      { discard: true },
    )
  })
}

function completedIDs(db: Database) {
  return db
    .all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)
    .pipe(Effect.map((rows) => HashSet.fromIterable(rows.map((row) => row.id))))
}

function seedLegacyJournal(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    const named = (yield* db.all<{ name: string }>(
      sql`SELECT name FROM pragma_table_info('__drizzle_migrations')`,
    )).some((column) => column.name === "name")

    if (named) {
      const now = yield* Clock.currentTimeMillis
      return yield* db.run(sql`
        INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
        SELECT name, ${now}
        FROM ${sql.identifier("__drizzle_migrations")}
        WHERE name IS NOT NULL
      `)
    }

    const entries = yield* db.all<{ created_at: number; prefix: string | null }>(sql`
      SELECT created_at, strftime('%Y%m%d%H%M%S', created_at / 1000, 'unixepoch') AS prefix
      FROM ${sql.identifier("__drizzle_migrations")}
      WHERE created_at IS NOT NULL
    `)

    return yield* Effect.forEach(
      entries,
      (entry) => {
        const migration = input.find((item) => item.id.startsWith(`${entry.prefix}_`))
        if (!migration) {
          return Effect.die(
            new Error(`Legacy migration timestamp ${entry.created_at} does not match any known migration`),
          )
        }
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            db.run(sql`
              INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
              VALUES (${migration.id}, ${now})
            `),
          ),
        )
      },
      { discard: true },
    )
  })
}
