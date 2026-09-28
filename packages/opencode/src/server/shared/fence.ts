import { Database } from "@opencode-ai/core/database/database"
import { inArray } from "drizzle-orm"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { Workspace } from "@/control-plane/workspace"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Array as Arr, Effect, Option, Predicate, Schema } from "effect"

export const HEADER = "x-opencode-sync"
export type State = Record<string, number>

export function load(db: Database.Interface["db"], ids?: string[]) {
  return Effect.gen(function* () {
    const rows = yield* (
      ids?.length
        ? db.select().from(EventSequenceTable).where(inArray(EventSequenceTable.aggregate_id, ids)).all()
        : db.select().from(EventSequenceTable).all()
    ).pipe(Effect.orDie)

    return Object.fromEntries(rows.map((row) => [row.aggregate_id, row.seq]))
  })
}

export function diff(prev: State, next: State) {
  return Object.fromEntries(
    Arr.dedupe([...Object.keys(prev), ...Object.keys(next)])
      .map((id) => [id, next[id] ?? -1] as const)
      .filter(([id, seq]) => {
        return (prev[id] ?? -1) !== seq
      }),
  )
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export function parse(headers: Headers): State | undefined {
  return Option.fromNullishOr(headers.get(HEADER)).pipe(
    Option.filter((raw) => raw.length > 0),
    Option.flatMap(decodeJson),
    Option.filter(Predicate.isObjectOrArray),
    Option.map((data) =>
      Object.fromEntries(
        Object.entries(data).filter((entry): entry is [string, number] => {
          return typeof entry[0] === "string" && Number.isInteger(entry[1])
        }),
      ),
    ),
    // The workspace routing middleware reads an absent fence as `undefined`.
    Option.getOrUndefined,
  )
}

export function wait(workspaceID: WorkspaceV2.ID, state: State, signal?: AbortSignal) {
  return Effect.gen(function* () {
    yield* Effect.logInfo("waiting for state", { workspaceID, state })
    yield* Workspace.Service.use((workspace) => workspace.waitForSync(workspaceID, state, signal))
    yield* Effect.logInfo("state fully synced", { workspaceID, state })
  })
}
