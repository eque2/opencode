import * as Effect from "effect/Effect"
import { Column } from "drizzle-orm/column"
import { EffectDrizzleError } from "drizzle-orm/effect-core/errors"
import { is } from "drizzle-orm/entity"
import type { JoinNullability } from "drizzle-orm/query-builders/select.types"
import { Param, SQL } from "drizzle-orm/sql/sql"
import type { SelectedFieldsOrdered } from "drizzle-orm/sqlite-core/query-builders/select.types"
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core/query-builders/update"
import type { SQLiteTable } from "drizzle-orm/sqlite-core/table"
import { SQLiteViewBase } from "drizzle-orm/sqlite-core/view-base"
import { Subquery } from "drizzle-orm/subquery"
import { Table } from "drizzle-orm/table"
import type { UpdateSet } from "drizzle-orm/utils"
import { ViewBaseConfig } from "drizzle-orm/view-common"
import { EffectDrizzleBuilderError } from "./errors"

const TableSymbol = (
  Table as unknown as {
    Symbol: { Columns: symbol; IsAlias: symbol; Name: symbol; BaseName: symbol }
  }
).Symbol

export function getTableColumnsRuntime(table: SQLiteTable) {
  return (table as unknown as Record<symbol, Record<string, Column>>)[TableSymbol.Columns]
}

export function getViewSelectedFieldsRuntime(view: SQLiteViewBase) {
  return (view as unknown as Record<symbol, { selectedFields: Record<string, unknown>; name: string }>)[ViewBaseConfig]
}

/**
 * Probes whether this runtime allows the Function constructor that drizzle-orm
 * makeJitQueryMapper uses. Succeeds with false when JIT is off or the probe fails.
 */
export const jitCompatCheck = Effect.fn("jitCompatCheck")(function* (isEnabled: boolean | undefined) {
  if (!isEnabled) return false
  return yield* Effect.try({
    try: () => new Function("input", '"use strict"; return input;')(true) === true,
    catch: (cause) => new EffectDrizzleError({ message: "JIT query mappers are unavailable in this runtime", cause }),
  }).pipe(Effect.orElseSucceed(() => false))
})

export function orderSelectedFields(
  fields: Record<string, unknown>,
  pathPrefix?: string[],
): SelectedFieldsOrdered {
  return Object.entries(fields).flatMap(([name, field]) => {
    const path = pathPrefix ? [...pathPrefix, name] : [name]
    if (is(field, Column) || is(field, SQL) || is(field, SQL.Aliased) || is(field, Subquery)) {
      return [{ path, field }] as SelectedFieldsOrdered
    }
    if (is(field, Table)) return orderSelectedFields(getTableColumnsRuntime(field as SQLiteTable), path)
    return orderSelectedFields(field as Record<string, unknown>, path)
  }) as SelectedFieldsOrdered
}

export function mapUpdateSet<TTable extends SQLiteTable>(table: TTable, values: SQLiteUpdateSetSource<TTable>) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined)
  // eslint-disable-next-line effect/no-throw-use-effect -- drizzle-orm builder API (update set() / onConflictDoUpdate()) returns synchronously; its contract throws at build time
  if (entries.length === 0) throw new EffectDrizzleBuilderError({ message: "No values to set" })

  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      is(value, SQL) || is(value, Column) ? value : new Param(value, getTableColumnsRuntime(table)[key]),
    ]),
  ) as UpdateSet
}

export function getTableLikeName(table: SQLiteTable | Subquery | SQLiteViewBase | SQL) {
  if (is(table, Subquery)) return table._.alias
  if (is(table, SQLiteViewBase)) return getViewSelectedFieldsRuntime(table).name
  if (is(table, SQL)) return undefined
  return (table as unknown as Record<symbol, string | boolean>)[
    (table as unknown as Record<symbol, string | boolean>)[TableSymbol.IsAlias]
      ? TableSymbol.Name
      : TableSymbol.BaseName
  ] as string
}

export type { JoinNullability }
