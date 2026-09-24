import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import type { TablesRelationalConfig } from "drizzle-orm/_relations"
import { EffectDrizzleError } from "drizzle-orm/effect-core/errors"
import type { MigrationMeta } from "drizzle-orm/migrator"
import type { AnyRelations } from "drizzle-orm/relations"
import { type SQL, sql } from "drizzle-orm/sql/sql"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import type { SQLiteSession } from "drizzle-orm/sqlite-core/session"
import { GET_VERSION_FOR, MIGRATIONS_TABLE_VERSIONS, type UpgradeResult } from "./utils"

/** @internal */
export type SQLiteMigrationTableRow = { id: number | null; hash: string; created_at: number }

type AsyncSQLiteDatabaseWithSession = BaseSQLiteDatabase<"async", unknown, Record<string, unknown>> & {
  session: {
    all<T>(query: SQL): Promise<T[]>
  }
  transaction<T>(transaction: (tx: { run(query: SQL): Promise<unknown> }) => Promise<T>): Promise<T>
}

type SQLiteMigrationBackfillEntry = {
  name: string
  selector:
    | { column: "id"; value: number }
    | { column: "created_at"; value: number }
    | { column: "hash"; value: string }
}

const migrationUpgradeError = (cause: unknown) =>
  new EffectDrizzleError({
    message: Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message) ? cause.message : String(cause),
    cause,
  })

function unmatchedMigrationError(unmatched: SQLiteMigrationTableRow[]) {
  return new Error(
    `While upgrading your database migrations table we found ${unmatched.length} (${unmatched
      .map((it) => `[id: ${it.id}, created_at: ${it.created_at}]`)
      .join(
        ", ",
      )}) migrations in the database that do not match any local migration. This means that some migrations were applied to the database but are missing from the local environment`,
  )
}

/** @internal */
export function prepareSQLiteMigrationBackfill(
  dbRows: SQLiteMigrationTableRow[],
  localMigrations: MigrationMeta[],
): SQLiteMigrationBackfillEntry[] {
  const sortedLocalMigrations = [...localMigrations].sort((a, b) =>
    a.folderMillis !== b.folderMillis ? a.folderMillis - b.folderMillis : (a.name ?? "").localeCompare(b.name ?? ""),
  )
  const byMillis = new Map<number, MigrationMeta[]>()
  const byHash = new Map<string, MigrationMeta>()
  for (const migration of sortedLocalMigrations) {
    if (!byMillis.has(migration.folderMillis)) {
      byMillis.set(migration.folderMillis, [])
    }
    byMillis.get(migration.folderMillis)!.push(migration)
    byHash.set(migration.hash, migration)
  }

  const toApply: SQLiteMigrationBackfillEntry[] = []
  const unmatched: SQLiteMigrationTableRow[] = []

  for (const dbRow of dbRows) {
    const stringified = String(dbRow.created_at)
    const millis = Number(stringified.substring(0, stringified.length - 3) + "000")
    const candidates = byMillis.get(millis)

    const matchedByMillis = candidates?.length === 1 ? candidates[0] : undefined
    const matchedByCandidateHash =
      candidates && candidates.length > 1
        ? candidates.find((candidate) => candidate.hash && dbRow.hash && candidate.hash === dbRow.hash)
        : undefined
    const matchedByHash = matchedByMillis || matchedByCandidateHash ? undefined : byHash.get(dbRow.hash)
    const matched = matchedByMillis ?? matchedByCandidateHash ?? matchedByHash

    if (matched) {
      toApply.push({
        name: matched.name,
        selector:
          dbRow.id !== null
            ? { column: "id", value: dbRow.id }
            : matchedByMillis
              ? { column: "created_at", value: dbRow.created_at }
              : { column: "hash", value: dbRow.hash },
      })
      continue
    }

    unmatched.push(dbRow)
  }

  if (unmatched.length > 0) {
    throw unmatchedMigrationError(unmatched)
  }

  return toApply
}

/** @internal */
export function buildSQLiteMigrationBackfillStatements(
  migrationsTable: string,
  backfillEntries: SQLiteMigrationBackfillEntry[],
) {
  const table = sql`${sql.identifier(migrationsTable)}`
  const statements: SQL[] = [
    sql`ALTER TABLE ${table} ADD COLUMN ${sql.identifier("name")} text`,
    sql`ALTER TABLE ${table} ADD COLUMN ${sql.identifier("applied_at")} TEXT`,
  ]

  for (const backfillEntry of backfillEntries) {
    const updateQuery = sql`UPDATE ${table} SET ${sql.identifier("name")} = ${backfillEntry.name}, ${sql.identifier(
      "applied_at",
    )} = NULL WHERE`

    updateQuery.append(sql` ${sql.identifier(backfillEntry.selector.column)} = ${backfillEntry.selector.value}`)

    statements.push(updateQuery)
  }

  return statements
}

/**
 * Detects the current version of the migrations table schema and upgrades it if needed.
 *
 * Version 0: Original schema (id, hash, created_at)
 * Version 1: Extended schema (id, hash, created_at, name, applied_at)
 */
export const upgradeSyncIfNeeded = Effect.fn("upgradeSyncIfNeeded")(function* (
  migrationsTable: string,
  session: SQLiteSession<"sync", unknown, Record<string, unknown>, AnyRelations, TablesRelationalConfig>,
  localMigrations: MigrationMeta[],
) {
  const tableExists = yield* Effect.try({
    try: () => session.all(sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${migrationsTable}`),
    catch: migrationUpgradeError,
  })

  if (tableExists.length === 0) {
    return { newDb: true } satisfies UpgradeResult
  }

  // Table exists, check table shape
  const rows = yield* Effect.try({
    try: () =>
      session.all<{ column_name: string }>(sql`SELECT name as column_name FROM pragma_table_info(${migrationsTable})`),
    catch: migrationUpgradeError,
  })

  const version = GET_VERSION_FOR.sqlite(rows.map((r) => r.column_name))

  for (let v = version; v < MIGRATIONS_TABLE_VERSIONS.sqlite; v++) {
    const upgradeFn = upgradeSyncFunctions[v]
    if (!upgradeFn) {
      return yield* new EffectDrizzleError({
        message: `No upgrade path from migration table version ${v} to ${v + 1}`,
        cause: { version: v },
      })
    }
    yield* upgradeFn(migrationsTable, session, localMigrations)
  }

  return { newDb: false } satisfies UpgradeResult
})

const upgradeSyncFunctions: Record<
  number,
  (
    migrationsTable: string,
    session: SQLiteSession<"sync", unknown, Record<string, unknown>, AnyRelations, TablesRelationalConfig>,
    localMigrations: MigrationMeta[],
  ) => Effect.Effect<void, EffectDrizzleError>
> = {
  /**
   * Upgrade from version 0 to version 1:
   * 1. Read all existing DB migrations
   * 2. Sort localMigrations ASC by millis and if the same - sort by name
   * 3. Match each DB row to a local migration
   * If multiple migrations share the same second, use hash matching as a tiebreaker
   * Not implemented for now -> If hash matching fails, fall back to serial id ordering
   * 5. Create extra column and backfill names for matched migrations
   */
  0: (migrationsTable, session, localMigrations) =>
    Effect.gen(function* () {
      const table = sql`${sql.identifier(migrationsTable)}`
      const dbRows = yield* Effect.try({
        try: () => session.all<SQLiteMigrationTableRow>(sql`SELECT id, hash, created_at FROM ${table} ORDER BY id ASC`),
        catch: migrationUpgradeError,
      })
      const statements = yield* Effect.try({
        try: () =>
          buildSQLiteMigrationBackfillStatements(
            migrationsTable,
            prepareSQLiteMigrationBackfill(dbRows, localMigrations),
          ),
        catch: migrationUpgradeError,
      })

      yield* Effect.try({
        try: () =>
          session.transaction((tx) => {
            for (const statement of statements) {
              tx.run(statement)
            }
          }),
        catch: migrationUpgradeError,
      })
    }),
}

/**
 * Detects the current version of the migrations table schema and upgrades it if needed.
 *
 * Version 0: Original schema (id, hash, created_at)
 * Version 1: Extended schema (id, hash, created_at, name, applied_at)
 */
export const upgradeAsyncIfNeeded = Effect.fn("upgradeAsyncIfNeeded")(function* (
  migrationsTable: string,
  db: AsyncSQLiteDatabaseWithSession,
  localMigrations: MigrationMeta[],
) {
  // Check if the table exists at all
  const tableExists = yield* Effect.tryPromise({
    try: () => db.session.all(sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${migrationsTable}`),
    catch: migrationUpgradeError,
  })

  if (tableExists.length === 0) {
    return { newDb: true } satisfies UpgradeResult
  }

  const rows = yield* Effect.tryPromise({
    try: () =>
      db.session.all<{ column_name: string }>(sql`SELECT name as column_name FROM pragma_table_info(${migrationsTable})`),
    catch: migrationUpgradeError,
  })

  const version = GET_VERSION_FOR.sqlite(rows.map((r) => r.column_name))

  for (let v = version; v < MIGRATIONS_TABLE_VERSIONS.sqlite; v++) {
    const upgradeFn = upgradeAsyncFunctions[v]
    if (!upgradeFn) {
      return yield* new EffectDrizzleError({
        message: `No upgrade path from migration table version ${v} to ${v + 1}`,
        cause: { version: v },
      })
    }
    yield* upgradeFn(migrationsTable, db, localMigrations)
  }

  return { newDb: false } satisfies UpgradeResult
})

const upgradeAsyncFunctions: Record<
  number,
  (
    migrationsTable: string,
    db: AsyncSQLiteDatabaseWithSession,
    localMigrations: MigrationMeta[],
  ) => Effect.Effect<void, EffectDrizzleError>
> = {
  /**
   * Upgrade from version 0 to version 1:
   * 1. Read all existing DB migrations
   * 2. Sort localMigrations ASC by millis and if the same - sort by name
   * 3. Match each DB row to a local migration
   * If multiple migrations share the same second, use hash matching as a tiebreaker
   * Not implemented for now -> If hash matching fails, fall back to serial id ordering
   * 5. Create extra column and backfill names for matched migrations
   */
  0: (migrationsTable, db, localMigrations) =>
    Effect.gen(function* () {
      const table = sql`${sql.identifier(migrationsTable)}`
      const dbRows = yield* Effect.tryPromise({
        try: () =>
          db.session.all<SQLiteMigrationTableRow>(sql`SELECT id, hash, created_at FROM ${table} ORDER BY id ASC`),
        catch: migrationUpgradeError,
      })
      const statements = yield* Effect.try({
        try: () =>
          buildSQLiteMigrationBackfillStatements(
            migrationsTable,
            prepareSQLiteMigrationBackfill(dbRows, localMigrations),
          ),
        catch: migrationUpgradeError,
      })

      // drizzle-orm's async transaction takes a Promise-returning callback, so the
      // statements run as one Effect that is bridged into that Promise.
      yield* Effect.tryPromise({
        try: () =>
          db.transaction((tx) =>
            Effect.runPromise(
              Effect.forEach(
                statements,
                (statement) => Effect.tryPromise({ try: () => tx.run(statement), catch: migrationUpgradeError }),
                { discard: true },
              ),
            ),
          ),
        catch: migrationUpgradeError,
      })
    }),
}
