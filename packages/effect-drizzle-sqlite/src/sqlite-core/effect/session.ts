import * as Cause from "effect/Cause"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { EffectCacheShape } from "drizzle-orm/cache/core/cache-effect"
import { NoopCache, strategyFor } from "drizzle-orm/cache/core/cache"
import type { WithCacheConfig } from "drizzle-orm/cache/core/types"
import { MigratorInitError } from "drizzle-orm/effect-core/errors"
import {
  EffectDrizzleError,
  EffectDrizzleQueryError,
  EffectTransactionRollbackError,
} from "drizzle-orm/effect-core/errors"
import type { EffectLoggerShape } from "drizzle-orm/effect-core/logger"
import type { QueryEffectHKTBase, QueryEffectKind } from "drizzle-orm/effect-core/query-effect"
import { entityKind, is } from "drizzle-orm/entity"
import type { MigrationConfig, MigrationMeta } from "drizzle-orm/migrator"
import { getMigrationsToRun } from "drizzle-orm/migrator.utils"
import type {
  AnyRelations,
  EmptyRelations,
  RelationalQueryMapperConfig,
  RelationalRowsMapper,
} from "drizzle-orm/relations"
import { makeJitRqbMapper } from "drizzle-orm/relations"
import type { PreparedQuery } from "drizzle-orm/session"
import { fillPlaceholders, type Query, type SQL, sql } from "drizzle-orm/sql/sql"
import type { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core/dialect"
import type { SelectedFieldsOrdered } from "drizzle-orm/sqlite-core/query-builders/select.types"
import type { PreparedQueryConfig, SQLiteExecuteMethod, SQLiteTransactionConfig } from "drizzle-orm/sqlite-core/session"
import { upgradeIfNeeded } from "../../up-migrations/effect-sqlite"
import { assertUnreachable, makeDefaultQueryMapper, makeJitQueryMapper, type RowsMapper } from "drizzle-orm/utils"
import { SQLiteEffectDatabase } from "./db"

type MigrationConfigWithInit = MigrationConfig & { init?: boolean }

type SQLiteEffectExecuteMethod = SQLiteExecuteMethod | "values"

export interface SQLiteEffectQueryMetadata {
  type: "select" | "update" | "delete" | "insert"
  tables: string[]
}

export interface SQLiteEffectPreparedQueryOptions<TIsRqbV2 extends boolean = false> {
  readonly queryMetadata?: SQLiteEffectQueryMetadata
  readonly cacheConfig?: WithCacheConfig
  readonly fields?: SelectedFieldsOrdered
  readonly useJitMappers?: boolean
  readonly customResultMapper?: (
    rows: TIsRqbV2 extends true ? Record<string, unknown>[] : unknown[][],
    mapColumnValue?: (value: unknown) => unknown,
  ) => unknown
  readonly isRqbV2Query?: TIsRqbV2
  readonly rqbConfig?: RelationalQueryMapperConfig
  readonly isInTransaction?: Effect.Effect<boolean>
}

export interface SQLiteEffectPrepareQueryOptions {
  readonly fields?: SelectedFieldsOrdered
  readonly customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown
  readonly queryMetadata?: SQLiteEffectQueryMetadata
  readonly cacheConfig?: WithCacheConfig
}

export interface SQLiteEffectPrepareRelationalQueryOptions {
  readonly fields?: SelectedFieldsOrdered
  readonly customResultMapper: (
    rows: Record<string, unknown>[],
    mapColumnValue?: (value: unknown) => unknown,
  ) => unknown
  readonly config: RelationalQueryMapperConfig
}

export class SQLiteEffectPreparedQuery<
  T extends PreparedQueryConfig,
  TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  TIsRqbV2 extends boolean = false,
> implements PreparedQuery
{
  static readonly [entityKind]: string = "SQLiteEffectPreparedQuery"

  /** @internal */
  joinsNotNullableMap?: Record<string, boolean>
  private jitMapper?: RowsMapper<any> | RelationalRowsMapper<any>
  private cacheConfig: Option.Option<WithCacheConfig>
  private effectExecuteMethod: SQLiteExecuteMethod
  private queryMetadata?: SQLiteEffectQueryMetadata
  private fields?: SelectedFieldsOrdered
  private useJitMappers?: boolean
  private customResultMapper?: (
    rows: TIsRqbV2 extends true ? Record<string, unknown>[] : unknown[][],
    mapColumnValue?: (value: unknown) => unknown,
  ) => unknown
  private isRqbV2Query?: TIsRqbV2
  private rqbConfig?: RelationalQueryMapperConfig
  private isInTransaction: Effect.Effect<boolean>

  constructor(
    private executor: (
      params: unknown[],
      executeMethod: SQLiteEffectExecuteMethod,
    ) => Effect.Effect<unknown, unknown, unknown>,
    protected query: Query,
    private logger: EffectLoggerShape,
    private cache: EffectCacheShape,
    executeMethod: SQLiteExecuteMethod,
    options: SQLiteEffectPreparedQueryOptions<TIsRqbV2> = {},
  ) {
    this.effectExecuteMethod = executeMethod
    this.queryMetadata = options.queryMetadata
    this.fields = options.fields
    this.useJitMappers = options.useJitMappers
    this.customResultMapper = options.customResultMapper
    this.isRqbV2Query = options.isRqbV2Query
    this.rqbConfig = options.rqbConfig
    this.isInTransaction = options.isInTransaction ?? Effect.succeed(false)
    const cacheConfig =
      cache.strategy() === "all" && options.cacheConfig === undefined
        ? { enabled: true, autoInvalidate: true }
        : options.cacheConfig
    this.cacheConfig = Option.fromNullishOr(cacheConfig).pipe(Option.filter((config) => config.enabled))
  }

  run(placeholderValues?: Record<string, unknown>): QueryEffectKind<TEffectHKT, T["run"]>
  run(placeholderValues?: Record<string, unknown>): any {
    return this.executeWithCache<T["run"]>(placeholderValues, "run")
  }

  all(placeholderValues?: Record<string, unknown>): QueryEffectKind<TEffectHKT, T["all"]>
  all(placeholderValues?: Record<string, unknown>): any {
    if (this.isRqbV2Query) return this.allRqbV2(placeholderValues)

    if (!this.fields && !this.customResultMapper) {
      return this.executeWithCache<T["all"]>(placeholderValues, "all")
    }

    return this.executeWithCache<T["values"], T["all"]>(
      placeholderValues,
      "values",
      (rows) => this.mapAllResult(rows) as T["all"],
    )
  }

  get(placeholderValues?: Record<string, unknown>): QueryEffectKind<TEffectHKT, T["get"]>
  get(placeholderValues?: Record<string, unknown>): any {
    if (this.isRqbV2Query) return this.getRqbV2(placeholderValues)

    if (!this.fields && !this.customResultMapper) {
      return this.executeWithCache<T["get"]>(placeholderValues, "get")
    }

    return this.executeWithCache<T["values"], T["get"]>(
      placeholderValues,
      "values",
      (rows) => this.mapGetResult(rows) as T["get"],
    )
  }

  values(placeholderValues?: Record<string, unknown>): QueryEffectKind<TEffectHKT, T["values"]>
  values(placeholderValues?: Record<string, unknown>): any {
    return this.executeWithCache<T["values"]>(placeholderValues, "values")
  }

  execute(placeholderValues?: Record<string, unknown>): QueryEffectKind<TEffectHKT, T["execute"]>
  execute(placeholderValues?: Record<string, unknown>): any {
    return this[this.effectExecuteMethod](placeholderValues) as QueryEffectKind<TEffectHKT, T["execute"]>
  }

  mapRunResult(result: unknown, _isFromBatch?: boolean): unknown {
    return result
  }

  mapAllResult(rows: unknown, isFromBatch?: boolean): unknown {
    if (isFromBatch) {
      rows = Array.isArray(rows) ? rows : []
    }

    if (!this.fields && !this.customResultMapper) {
      return rows
    }

    if (this.isRqbV2Query) {
      return this.useJitMappers
        ? (this.jitMapper =
            (this.jitMapper as RelationalRowsMapper<T["all"]>) ?? makeJitRqbMapper<T["all"]>(this.rqbConfig!))(
            rows as Record<string, unknown>[],
          )
        : (this.customResultMapper as (rows: Record<string, unknown>[]) => unknown)(rows as Record<string, unknown>[])
    }

    if (this.customResultMapper) {
      return (this.customResultMapper as (rows: unknown[][]) => unknown)(rows as unknown[][]) as T["all"]
    }

    return this.useJitMappers
      ? (this.jitMapper =
          (this.jitMapper as RowsMapper<T["all"]>) ??
          makeJitQueryMapper<T["all"]>(this.fields!, this.joinsNotNullableMap))(rows as unknown[][])
      : makeDefaultQueryMapper<T["all"]>(this.fields!, this.joinsNotNullableMap)(rows as unknown[][])
  }

  mapGetResult(rows: unknown, isFromBatch?: boolean): unknown {
    if (isFromBatch) {
      rows = Array.isArray(rows) ? rows : []
    }

    if (!this.fields && !this.customResultMapper) {
      return Array.isArray(rows) ? rows[0] : rows
    }

    const row = Array.isArray(rows) ? rows[0] : rows
    if (!row) return undefined

    if (this.isRqbV2Query) {
      return this.useJitMappers
        ? (this.jitMapper =
            (this.jitMapper as RelationalRowsMapper<T["get"][]>) ?? makeJitRqbMapper<T["get"][]>(this.rqbConfig!))([
            row as Record<string, unknown>,
          ])
        : (this.customResultMapper as (rows: Record<string, unknown>[]) => unknown)([row as Record<string, unknown>])
    }

    if (this.customResultMapper) {
      return (this.customResultMapper as (rows: unknown[][]) => unknown)([row as unknown[]]) as T["get"]
    }

    return this.useJitMappers
      ? (this.jitMapper =
          (this.jitMapper as RowsMapper<T["get"][]>) ??
          makeJitQueryMapper<T["get"][]>(this.fields!, this.joinsNotNullableMap))([row as unknown[]])[0]
      : makeDefaultQueryMapper<T["get"][]>(this.fields!, this.joinsNotNullableMap)([row as unknown[]])[0]
  }

  private allRqbV2(placeholderValues?: Record<string, unknown>) {
    return this.executeWithCache<unknown[], T["all"]>(
      placeholderValues,
      "all",
      (rows) => this.mapAllResult(rows) as T["all"],
    )
  }

  private getRqbV2(placeholderValues?: Record<string, unknown>) {
    return this.executeWithCache<unknown, T["get"] | undefined>(placeholderValues, "get", (row) =>
      Option.fromUndefinedOr(row).pipe(
        Option.map((value) => this.mapGetResult(value) as T["get"]),
        Option.getOrUndefined,
      ),
    )
  }

  private executeWithCache<A, B = A>(
    placeholderValues: Record<string, unknown> | undefined,
    executeMethod: SQLiteEffectExecuteMethod,
    mapResult?: (result: A) => B,
  ) {
    return Effect.gen({ self: this }, function* () {
      const params = fillPlaceholders(this.query.params, placeholderValues ?? {})

      yield* this.logger.logQuery(this.query.sql, params)

      return yield* this.queryWithCache(
        this.query.sql,
        params,
        Effect.suspend(() => this.executor(params, executeMethod) as Effect.Effect<A, unknown, unknown>),
        mapResult,
      )
    })
  }

  private mapCachedResult<A, B>(result: A, mapResult: ((result: A) => B) | undefined) {
    if (!mapResult) return Effect.succeed(result as unknown as B)
    return Effect.try({
      try: () => mapResult(result),
      catch: (cause) => new EffectDrizzleError({ message: "Failed to map query result", cause }),
    })
  }

  private queryWithCache<A, E, R, B = A>(
    queryString: string,
    params: unknown[],
    query: Effect.Effect<A, E, R>,
    mapResult?: (result: A) => B,
  ) {
    return Effect.gen({ self: this }, function* () {
      if (this.queryMetadata?.type === "select" && Option.isSome(this.cacheConfig) && (yield* this.isInTransaction)) {
        return yield* this.mapCachedResult(yield* query, mapResult)
      }

      const cacheStrat: Awaited<ReturnType<typeof strategyFor>> = !is(this.cache.cache, NoopCache)
        ? yield* Effect.tryPromise(() =>
            strategyFor(queryString, params, this.queryMetadata, Option.getOrUndefined(this.cacheConfig)),
          )
        : { type: "skip" as const }

      if (cacheStrat.type === "skip") {
        return yield* this.mapCachedResult(yield* query, mapResult)
      }

      if (cacheStrat.type === "invalidate") {
        const result = yield* query
        yield* this.cache.onMutate({ tables: cacheStrat.tables })
        return yield* this.mapCachedResult(result, mapResult)
      }

      if (cacheStrat.type === "try") {
        if (yield* this.isInTransaction) {
          return yield* this.mapCachedResult(yield* query, mapResult)
        }

        const { tables, key, isTag, autoInvalidate, config } = cacheStrat
        const fromCache: any[] | undefined = yield* this.cache.get(key, tables, isTag, autoInvalidate)

        if (typeof fromCache !== "undefined") {
          return yield* this.mapCachedResult(fromCache as unknown as A, mapResult)
        }

        const result = yield* query

        yield* this.cache.put(key, result, autoInvalidate ? tables : [], isTag, config)

        return yield* this.mapCachedResult(result, mapResult)
      }

      assertUnreachable(cacheStrat)
    }).pipe(
      Effect.catch((e) => {
        return Effect.fail(new EffectDrizzleQueryError({ query: queryString, params, cause: Cause.fail(e) }))
      }),
    )
  }

  getQuery(): Query {
    return this.query
  }

  mapResult(response: unknown, isFromBatch?: boolean) {
    switch (this.effectExecuteMethod) {
      case "run": {
        return this.mapRunResult(response, isFromBatch)
      }
      case "all": {
        return this.mapAllResult(response, isFromBatch)
      }
      case "get": {
        return this.mapGetResult(response, isFromBatch)
      }
    }
  }
}

export abstract class SQLiteEffectSession<
  TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  TRunResult = unknown,
  TRelations extends AnyRelations = EmptyRelations,
> {
  static readonly [entityKind]: string = "SQLiteEffectSession"

  constructor(readonly dialect: SQLiteAsyncDialect) {}

  abstract prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    executeMethod: SQLiteExecuteMethod,
    options?: SQLiteEffectPrepareQueryOptions,
  ): SQLiteEffectPreparedQuery<T, TEffectHKT>

  prepareOneTimeQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    executeMethod: SQLiteExecuteMethod,
    options?: SQLiteEffectPrepareQueryOptions,
  ): SQLiteEffectPreparedQuery<T, TEffectHKT> {
    return this.prepareQuery(query, executeMethod, options)
  }

  abstract prepareRelationalQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    executeMethod: SQLiteExecuteMethod,
    options: SQLiteEffectPrepareRelationalQueryOptions,
  ): SQLiteEffectPreparedQuery<T, TEffectHKT, true>

  prepareOneTimeRelationalQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    executeMethod: SQLiteExecuteMethod,
    options: SQLiteEffectPrepareRelationalQueryOptions,
  ): SQLiteEffectPreparedQuery<T, TEffectHKT, true> {
    return this.prepareRelationalQuery(query, executeMethod, options)
  }

  run(query: SQL): QueryEffectKind<TEffectHKT, TRunResult>
  run(query: SQL): any {
    return this.prepareQuery<PreparedQueryConfig & { run: TRunResult; execute: TRunResult }>(
      this.dialect.sqlToQuery(query),
      "run",
    ).run()
  }

  all<T = unknown>(query: SQL): QueryEffectKind<TEffectHKT, T[]>
  all<T = unknown>(query: SQL): any {
    return this.prepareQuery<PreparedQueryConfig & { all: T[]; execute: T[] }>(
      this.dialect.sqlToQuery(query),
      "all",
    ).all()
  }

  get<T = unknown>(query: SQL): QueryEffectKind<TEffectHKT, T | undefined>
  get<T = unknown>(query: SQL): any {
    return this.prepareQuery<PreparedQueryConfig & { get: T | undefined; execute: T | undefined }>(
      this.dialect.sqlToQuery(query),
      "get",
    ).get()
  }

  values<T extends unknown[] = unknown[]>(query: SQL): QueryEffectKind<TEffectHKT, T[]>
  values<T extends unknown[] = unknown[]>(query: SQL): any {
    return this.prepareQuery<PreparedQueryConfig & { values: T[]; execute: T[] }>(
      this.dialect.sqlToQuery(query),
      "all",
    ).values()
  }

  count(query: SQL): QueryEffectKind<TEffectHKT, number>
  count(query: SQL): any {
    return this.values<[number]>(query).pipe(Effect.map((result) => result[0]?.[0] ?? 0))
  }

  abstract transaction<A, E, R>(
    transaction: (tx: SQLiteEffectTransaction<TEffectHKT, TRunResult, TRelations>) => Effect.Effect<A, E, R>,
    config?: SQLiteTransactionConfig,
  ): Effect.Effect<A, E | SqlError, R>
}

export abstract class SQLiteEffectTransaction<
  TEffectHKT extends QueryEffectHKTBase,
  TRunResult,
  TRelations extends AnyRelations = EmptyRelations,
> extends SQLiteEffectDatabase<TEffectHKT, TRunResult, TRelations> {
  static override readonly [entityKind]: string = "SQLiteEffectTransaction"

  constructor(
    dialect: SQLiteAsyncDialect,
    session: SQLiteEffectSession<TEffectHKT, TRunResult, TRelations>,
    protected relations: TRelations,
  ) {
    super(dialect, session, relations)
  }

  rollback() {
    return new EffectTransactionRollbackError()
  }
}

export const migrate = Effect.fn("migrate")(function* <TEffectHKT extends QueryEffectHKTBase>(
  migrations: MigrationMeta[],
  session: SQLiteEffectSession<TEffectHKT>,
  config: string | MigrationConfigWithInit,
) {
  const migrationsTable =
    typeof config === "string" ? "__drizzle_migrations" : (config.migrationsTable ?? "__drizzle_migrations")

  const { newDb } = yield* upgradeIfNeeded(migrationsTable, session, migrations)

  if (newDb) {
    yield* session.run(sql`
		CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsTable)} (
			id INTEGER PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric,
			name text,
			applied_at TEXT
		)
	`)
  }

  const dbMigrations = yield* session.all<{ id: number; hash: string; created_at: string; name: string | null }>(
    sql`SELECT id, hash, created_at, name FROM ${sql.identifier(migrationsTable)}`,
  )

  if (typeof config === "object" && config.init) {
    if (dbMigrations.length) {
      return yield* new MigratorInitError({ exitCode: "databaseMigrations" })
    }

    if (migrations.length > 1) {
      return yield* new MigratorInitError({ exitCode: "localMigrations" })
    }

    const [migration] = migrations
    if (!migration) return

    const appliedAt = DateTime.formatIso(yield* DateTime.now)
    yield* session.run(
      sql`insert into ${sql.identifier(
        migrationsTable,
      )} ("hash", "created_at", "name", "applied_at") values(${migration.hash}, ${migration.folderMillis}, ${migration.name}, ${appliedAt})`,
    )

    return
  }

  const migrationsToRun = getMigrationsToRun({ localMigrations: migrations, dbMigrations })
  if (migrationsToRun.length === 0) return

  yield* session.transaction((tx) =>
    Effect.gen(function* () {
      for (const migration of migrationsToRun) {
        for (const stmt of migration.sql) {
          yield* tx.run(sql.raw(stmt))
        }
        const appliedAt = DateTime.formatIso(yield* DateTime.now)
        yield* tx.run(
          sql`insert into ${sql.identifier(
            migrationsTable,
          )} ("hash", "created_at", "name", "applied_at") values(${migration.hash}, ${migration.folderMillis}, ${migration.name}, ${appliedAt})`,
        )
      }
    }),
  )
})
