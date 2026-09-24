import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import { Column } from "drizzle-orm/column"
import { EffectDrizzleError } from "drizzle-orm/effect-core/errors"
import { is } from "drizzle-orm/entity"
import type { JoinNullability } from "drizzle-orm/query-builders/select.types"
import { getViewName, Param, SQL } from "drizzle-orm/sql/sql"
import type { SelectedFieldsOrdered } from "drizzle-orm/sqlite-core/query-builders/select.types"
import type { SQLiteTable } from "drizzle-orm/sqlite-core/table"
import { SQLiteViewBase } from "drizzle-orm/sqlite-core/view-base"
import { Subquery } from "drizzle-orm/subquery"
import { getTableName, Table } from "drizzle-orm/table"
import { getTableColumns, type UpdateSet } from "drizzle-orm/utils"
import { EffectDrizzleBuilderError } from "./errors"

// drizzle-orm keeps these table fields under registry symbols (Table.Symbol in drizzle-orm/table.js),
// which the rc.2 declarations do not expose.
const TableBaseName = Symbol.for("drizzle:BaseName")
const TableIsAlias = Symbol.for("drizzle:IsAlias")

/**
 * Probes whether this runtime allows the Function constructor that drizzle-orm
 * makeJitQueryMapper uses. Succeeds with false when JIT is off or the probe fails.
 */
export const jitCompatCheck = Effect.fn("jitCompatCheck")(function* (isEnabled: boolean | undefined) {
  if (!isEnabled) return false
  return yield* Effect.try({
    // oxlint-disable-next-line typescript-eslint/no-implied-eval -- deliberate probe: drizzle-orm makeJitQueryMapper builds its mappers with the Function constructor, and this checks that the runtime allows it
    try: () => new Function("input", '"use strict"; return input;')(true) === true,
    catch: (cause) => new EffectDrizzleError({ message: "JIT query mappers are unavailable in this runtime", cause }),
  }).pipe(Effect.orElseSucceed(() => false))
})

export function orderSelectedFields(fields: object, pathPrefix?: string[]): SelectedFieldsOrdered {
  return Object.entries(fields).flatMap(([name, field]): SelectedFieldsOrdered => {
    const path = pathPrefix ? [...pathPrefix, name] : [name]
    if (is(field, Column) || is(field, SQL) || is(field, SQL.Aliased) || is(field, Subquery)) {
      return [{ path, field }]
    }
    if (is(field, Table)) return orderSelectedFields(getTableColumns(field), path)
    if (Predicate.isObjectKeyword(field)) return orderSelectedFields(field, path)
    return []
  })
}

export function mapUpdateSet(table: SQLiteTable, values: object): UpdateSet {
  const columns = getTableColumns(table)
  const entries = Object.entries(values).filter(([, value]) => value !== undefined)
  // eslint-disable-next-line effect/no-throw-use-effect -- drizzle-orm builder API (update set() / onConflictDoUpdate()) returns synchronously; its contract throws at build time
  if (entries.length === 0) throw new EffectDrizzleBuilderError({ message: "No values to set" })

  return Object.fromEntries(
    entries.map(([key, value]) => [key, is(value, SQL) || is(value, Column) ? value : new Param(value, columns[key])]),
  )
}

export function getTableLikeName(table: SQLiteTable | Subquery | SQLiteViewBase | SQL): string | undefined {
  if (is(table, Subquery)) return table._.alias
  if (is(table, SQLiteViewBase)) return getViewName(table)
  if (is(table, SQL)) return undefined
  if (TableIsAlias in table && table[TableIsAlias]) return getTableName(table)
  if (TableBaseName in table && Predicate.isString(table[TableBaseName])) return table[TableBaseName]
  return undefined
}

export type { JoinNullability }
