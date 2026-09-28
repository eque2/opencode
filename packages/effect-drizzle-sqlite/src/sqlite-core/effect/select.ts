import type * as Effect from "effect/Effect"
import * as Effectable from "effect/Effectable"
import type { CacheConfig } from "drizzle-orm/cache/core/types"
import type { QueryEffectHKTBase } from "drizzle-orm/effect-core/query-effect"
import { entityKind, is } from "drizzle-orm/entity"
import type {
  BuildSubquerySelection,
  GetSelectTableName,
  GetSelectTableSelection,
  JoinNullability,
  SelectMode,
  SelectResult,
} from "drizzle-orm/query-builders/select.types"
import { SQL } from "drizzle-orm/sql/sql"
import type { ColumnsSelection, SQLWrapper } from "drizzle-orm/sql/sql"
import type { SQLiteDialect } from "drizzle-orm/sqlite-core/dialect"
import { SQLiteSelectQueryBuilderBase } from "drizzle-orm/sqlite-core/query-builders/select"
import type {
  SelectedFields,
  SQLiteSelectConfig,
  SQLiteSelectHKTBase,
} from "drizzle-orm/sqlite-core/query-builders/select.types"
import type { SQLiteTable } from "drizzle-orm/sqlite-core/table"
import { SQLiteViewBase } from "drizzle-orm/sqlite-core/view-base"
import { Subquery } from "drizzle-orm/subquery"
import { type Assume, getTableColumns, getViewSelectedFields } from "drizzle-orm/utils"
import { orderSelectedFields } from "../../internal/drizzle-utils"
import { EffectDrizzleBuilderError } from "../../internal/errors"
import type { SQLiteEffectPreparedQuery, SQLiteEffectSession } from "./session"

export type SQLiteEffectSelectPrepareConfig<T extends AnySQLiteEffectSelect> = {
  type: "async"
  run: T["_"]["runResult"]
  all: T["_"]["result"]
  get: T["_"]["result"][number] | undefined
  values: any[][]
  execute: T["_"]["result"]
}

export type SQLiteEffectSelectPrepare<
  T extends AnySQLiteEffectSelect,
  TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
> = SQLiteEffectPreparedQuery<SQLiteEffectSelectPrepareConfig<T>, TEffectHKT>

export class SQLiteEffectSelectBuilder<
  TSelection extends SelectedFields | undefined,
  TRunResult,
  TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
> {
  static readonly [entityKind]: string = "SQLiteEffectSelectBuilder"

  private fields: TSelection
  private session: SQLiteEffectSession<TEffectHKT, TRunResult, any> | undefined
  private dialect: SQLiteDialect
  private withList: Subquery[] | undefined
  private distinct: boolean | undefined

  constructor(config: {
    fields: TSelection
    session: SQLiteEffectSession<TEffectHKT, TRunResult, any> | undefined
    dialect: SQLiteDialect
    withList?: Subquery[]
    distinct?: boolean
  }) {
    this.fields = config.fields
    this.session = config.session
    this.dialect = config.dialect
    this.withList = config.withList
    this.distinct = config.distinct
  }

  from<TFrom extends SQLiteTable | Subquery | SQLiteViewBase | SQL>(
    source: TFrom,
  ): SQLiteEffectSelectBase<
    GetSelectTableName<TFrom>,
    TRunResult,
    TSelection extends undefined ? GetSelectTableSelection<TFrom> : TSelection,
    TSelection extends undefined ? "single" : "partial",
    GetSelectTableName<TFrom> extends string ? Record<GetSelectTableName<TFrom>, "not-null"> : {},
    false,
    never,
    SelectResult<
      TSelection extends undefined ? GetSelectTableSelection<TFrom> : TSelection,
      TSelection extends undefined ? "single" : "partial",
      GetSelectTableName<TFrom> extends string ? Record<GetSelectTableName<TFrom>, "not-null"> : {}
    >[],
    BuildSubquerySelection<
      TSelection extends undefined ? GetSelectTableSelection<TFrom> : TSelection,
      GetSelectTableName<TFrom> extends string ? Record<GetSelectTableName<TFrom>, "not-null"> : {}
    >,
    TEffectHKT
  > {
    const isPartialSelect = !!this.fields

    let fields: SQLiteSelectConfig["fields"]
    if (this.fields) {
      fields = this.fields
    } else if (is(source, Subquery)) {
      // The subquery is a selection proxy: reading a key returns the aliased field.
      fields = Object.fromEntries(Object.keys(source._.selectedFields).map((key) => [key, Reflect.get(source, key)]))
    } else if (is(source, SQLiteViewBase)) {
      fields = getViewSelectedFields(source)
    } else if (is(source, SQL)) {
      fields = {}
    } else {
      fields = getTableColumns(source)
    }

    return new SQLiteEffectSelectBase({
      table: source,
      fields,
      isPartialSelect,
      session: this.session,
      dialect: this.dialect,
      withList: this.withList,
      distinct: this.distinct,
    })
  }
}

export interface SQLiteEffectSelectHKT<TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase>
  extends SQLiteSelectHKTBase {
  _type: SQLiteEffectSelectBase<
    this["tableName"],
    this["runResult"],
    Assume<this["selection"], ColumnsSelection>,
    this["selectMode"],
    Assume<this["nullabilityMap"], Record<string, JoinNullability>>,
    this["dynamic"],
    this["excludedMethods"],
    Assume<this["result"], any[]>,
    Assume<this["selectedFields"], ColumnsSelection>,
    TEffectHKT
  >
}

export class SQLiteEffectSelectBase<
    TTableName extends string | undefined,
    TRunResult,
    TSelection extends ColumnsSelection,
    TSelectMode extends SelectMode = "single",
    TNullabilityMap extends Record<string, JoinNullability> = TTableName extends string
      ? Record<TTableName, "not-null">
      : {},
    TDynamic extends boolean = false,
    TExcludedMethods extends string = never,
    TResult extends any[] = SelectResult<TSelection, TSelectMode, TNullabilityMap>[],
    TSelectedFields extends ColumnsSelection = BuildSubquerySelection<TSelection, TNullabilityMap>,
    TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  >
  extends Effectable.Mixin(SQLiteSelectQueryBuilderBase)<
    SQLiteEffectSelectHKT<TEffectHKT>,
    TTableName,
    "async",
    TRunResult,
    TSelection,
    TSelectMode,
    TNullabilityMap,
    TDynamic,
    TExcludedMethods,
    TResult,
    TSelectedFields
  >
  implements SQLWrapper
{
  static override readonly [entityKind]: string = "SQLiteEffectSelect"

  private effectSession: SQLiteEffectSession<TEffectHKT, TRunResult, any> | undefined

  constructor(config: {
    table: SQLiteSelectConfig["table"]
    fields: SQLiteSelectConfig["fields"]
    isPartialSelect: boolean
    session: SQLiteEffectSession<TEffectHKT, TRunResult, any> | undefined
    dialect: SQLiteDialect
    withList: Subquery[] | undefined
    distinct: boolean | undefined
  }) {
    // eslint-disable-next-line effect/no-undefined-use-option -- (a) drizzle-orm SQLiteSelectQueryBuilderBase constructor declares the required key session: SQLiteSession | undefined and only stores it; SQLiteEffectSession is not a SQLiteSession, so the base gets undefined and the Effect session lives in effectSession
    super({ ...config, session: undefined })
    this.effectSession = config.session
  }

  /** @internal */
  getSQL(): SQL {
    return this.dialect.buildSelectQuery(this._.config)
  }

  /** @internal */
  _prepare(isOneTimeQuery = true): SQLiteEffectSelectPrepare<this, TEffectHKT> {
    const session = this.effectSession
    if (!session) {
      // eslint-disable-next-line effect/no-throw-use-effect -- (a) mirrors drizzle-orm SQLiteSelectBase.prepare(): SQLiteSelectPrepare<this>, a synchronous signature; upstream _prepare throws this same message when the builder has no session
      throw new EffectDrizzleBuilderError({
        message: "Cannot execute a query on a query builder. Please use a database instance instead.",
      })
    }
    const query = session[isOneTimeQuery ? "prepareOneTimeQuery" : "prepareQuery"]<
      SQLiteEffectSelectPrepareConfig<this>
    >(this.dialect.sqlToQuery(this.getSQL()), "all", {
      fields: orderSelectedFields(this._.config.fields),
      queryMetadata: {
        type: "select",
        tables: [...this.usedTables],
      },
      cacheConfig: this.cacheConfig,
    })
    query.joinsNotNullableMap = this.joinsNotNullableMap
    return query
  }

  $withCache(config?: { config?: CacheConfig; tag?: string; autoInvalidate?: boolean } | false) {
    this.cacheConfig =
      config === undefined
        ? { config: {}, enabled: true, autoInvalidate: true }
        : config === false
          ? { enabled: false }
          : { enabled: true, autoInvalidate: true, ...config }
    return this
  }

  prepare(): SQLiteEffectSelectPrepare<this, TEffectHKT> {
    return this._prepare(false)
  }

  run: ReturnType<this["prepare"]>["run"] = (placeholderValues) => {
    return this._prepare().run(placeholderValues)
  }

  all: ReturnType<this["prepare"]>["all"] = (placeholderValues) => {
    return this._prepare().all(placeholderValues)
  }

  get: ReturnType<this["prepare"]>["get"] = (placeholderValues) => {
    return this._prepare().get(placeholderValues)
  }

  values: ReturnType<this["prepare"]>["values"] = (placeholderValues) => {
    return this._prepare().values(placeholderValues)
  }

  execute: ReturnType<this["prepare"]>["execute"] = (placeholderValues) => {
    return this._prepare().execute(placeholderValues)
  }

  asEffect(): Effect.Effect<TResult, TEffectHKT["error"], TEffectHKT["context"]> {
    return this.execute()
  }
}

export type AnySQLiteEffectSelect = SQLiteEffectSelectBase<any, any, any, any, any, any, any, any, any, any>
