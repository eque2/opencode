import { Database } from "bun:sqlite"
import os from "node:os"
import path from "node:path"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { Config, Effect, FileSystem, Option, Predicate, Schema } from "effect"
import type { EditorSelection } from "./context/editor"

const ZedEditorRowSchema = Schema.Struct({
  item_kind: Schema.String,
  editor_id: Schema.NullOr(Schema.Number),
  workspace_id: Schema.Number,
  workspace_paths: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  buffer_path: Schema.NullOr(Schema.String),
}).annotate({ identifier: "TuiEditorZed.EditorRow" })

const ZedSelectionRowSchema = Schema.Struct({
  selection_start: Schema.NullOr(Schema.Number),
  selection_end: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "TuiEditorZed.SelectionRow" })

const ZedEditorContentsSchema = Schema.Struct({
  contents: Schema.NullOr(Schema.String),
}).annotate({ identifier: "TuiEditorZed.EditorContents" })

const decodeZedEditorRow = Schema.decodeUnknownOption(ZedEditorRowSchema)
const decodeZedSelectionRow = Schema.decodeUnknownOption(ZedSelectionRowSchema)
const decodeZedEditorContents = Schema.decodeUnknownOption(ZedEditorContentsSchema)
// Zed stores the workspace paths as a JSON array. A value that is not a JSON array holds one path per line.
const decodeZedWorkspacePathList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Json)))

const utf8 = new TextEncoder()
const filesystem = LayerNode.compile(LayerNodePlatform.filesystem)

const ZedTerminalEnv = Config.all({
  zedTerm: Config.option(Config.String("ZED_TERM")),
  termProgram: Config.option(Config.String("TERM_PROGRAM")),
})
const ZedDbEnv = Config.option(Config.String("OPENCODE_ZED_DB"))

class ZedDatabaseError extends Schema.TaggedError<ZedDatabaseError>()("TuiEditorZed.DatabaseError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

type ZedEditorRow = Schema.Schema.Type<typeof ZedEditorRowSchema>
type ZedActiveEditorRow = ZedEditorRow & { item_kind: "Editor"; editor_id: number }

export type ZedSelectionResult =
  | { type: "selection"; selection: EditorSelection }
  | { type: "empty" }
  | { type: "unavailable" }

/** Reads the active Zed editor selection for `cwd` from the Zed database at `dbPath`. */
export function resolveZedSelection(dbPath: string, cwd = process.cwd()): Promise<ZedSelectionResult> {
  return Effect.runPromise(readZedSelection(dbPath, cwd))
}

/**
 * Reads the active Zed editor selection for `directory` from the database that resolveZedDbPath finds.
 * With no Zed database, the selection is unavailable.
 */
export const resolveActiveZedSelection = Effect.fn("TuiEditorZed.resolveActiveZedSelection")(function* (
  directory: string,
) {
  const dbPath = yield* resolveZedDbPath()
  if (Option.isNone(dbPath)) return { type: "unavailable" as const }
  return yield* readZedSelection(dbPath.value, directory)
})

const readZedSelection = Effect.fn("TuiEditorZed.readZedSelection")(function* (
  dbPath: string,
  cwd: string,
): Effect.fn.Return<ZedSelectionResult, never, FileSystem.FileSystem> {
  const active = yield* queryZedActiveEditor(dbPath, cwd)
  if (active.type !== "row") return active

  const row = active.row
  const filePath = row.buffer_path
  if (!filePath) return { type: "empty" }

  const selections = yield* queryZedEditorSelections(dbPath, row)
  if (selections.type !== "selections") return selections
  const byteRanges = selections.selections
    .flatMap((selection) => {
      if (Predicate.isNullish(selection.selection_start) || Predicate.isNullish(selection.selection_end)) return []
      return [
        {
          start: Math.min(selection.selection_start, selection.selection_end),
          end: Math.max(selection.selection_start, selection.selection_end),
        },
      ]
    })
    .sort((left, right) => left.start - right.start || left.end - right.end)
  if (byteRanges.length === 0) return { type: "unavailable" }

  // Zed keeps the buffer text of an editor in its database. Without it, the file on disk holds the text.
  const contents = yield* queryZedEditorContents(dbPath, row)
  const fs = yield* FileSystem.FileSystem
  const text =
    contents.type === "contents" && Predicate.isNotNull(contents.contents)
      ? Option.some(contents.contents)
      : yield* fs.readFileString(filePath).pipe(Effect.option)
  if (Option.isNone(text)) return { type: "unavailable" }

  const ranges = byteRanges.map((range) => {
    const startOffset = utf8ByteOffsetToStringIndex(text.value, range.start)
    const endOffset = utf8ByteOffsetToStringIndex(text.value, range.end)
    return {
      text: text.value.slice(startOffset, endOffset),
      selection: offsetsToSelection(text.value, startOffset, endOffset),
    }
  })

  return {
    type: "selection",
    selection: {
      filePath,
      source: "zed",
      ranges,
    },
  }
}, Effect.provide(filesystem))

// Opens the Zed database read-only for one query and closes it after the query.
function queryZedDatabase<A>(dbPath: string, query: (db: Database) => A) {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => new Database(dbPath, { readonly: true }),
      catch: (cause) => new ZedDatabaseError({ message: `Cannot open the Zed database ${dbPath}`, cause }),
    }),
    (db) =>
      Effect.try({
        try: () => query(db),
        catch: (cause) => new ZedDatabaseError({ message: `Cannot query the Zed database ${dbPath}`, cause }),
      }),
    (db) => Effect.sync(() => db.close()),
  )
}

function queryZedActiveEditor(dbPath: string, cwd: string) {
  return queryZedDatabase(dbPath, (db) =>
    db
      .query(
        `select
          i.kind as item_kind,
          e.item_id as editor_id,
          i.workspace_id as workspace_id,
          w.paths as workspace_paths,
          w.timestamp as timestamp,
          e.buffer_path as buffer_path
        from items i
        join panes p on p.pane_id = i.pane_id and p.workspace_id = i.workspace_id
        join workspaces w on w.workspace_id = i.workspace_id
        left join editors e on e.item_id = i.item_id and e.workspace_id = i.workspace_id
        where i.active = 1 and p.active = 1
        order by w.timestamp desc`,
      )
      .all(),
  ).pipe(
    Effect.map((raw) => {
      const rows = raw.flatMap((row) => {
        const parsed = decodeZedEditorRow(row)
        return Option.isSome(parsed) ? [parsed.value] : []
      })

      if (raw.length > 0 && rows.length === 0) return { type: "unavailable" as const }

      const row = rows
        .map((row) => ({ row, score: scoreZedWorkspace(row.workspace_paths, cwd) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || right.row.timestamp.localeCompare(left.row.timestamp))[0]?.row
      if (!row) return { type: "empty" as const }
      if (row.item_kind !== "Editor") return { type: "unavailable" as const }
      if (!isZedActiveEditorRow(row)) return { type: "empty" as const }
      return { type: "row" as const, row }
    }),
    Effect.orElseSucceed(() => ({ type: "unavailable" as const })),
  )
}

function queryZedEditorSelections(dbPath: string, row: ZedActiveEditorRow) {
  return queryZedDatabase(dbPath, (db) =>
    db
      .query(
        `select
          start as selection_start,
          end as selection_end
        from editor_selections
        where editor_id = $editorID and workspace_id = $workspaceID`,
      )
      .all({ $editorID: row.editor_id, $workspaceID: row.workspace_id }),
  ).pipe(
    Effect.map((raw) => {
      const selections = raw.flatMap((selection) => {
        const parsed = decodeZedSelectionRow(selection)
        return Option.isSome(parsed) ? [parsed.value] : []
      })

      if (raw.length > 0 && selections.length === 0) return { type: "unavailable" as const }
      return { type: "selections" as const, selections }
    }),
    Effect.orElseSucceed(() => ({ type: "unavailable" as const })),
  )
}

function queryZedEditorContents(dbPath: string, row: ZedActiveEditorRow) {
  return queryZedDatabase(dbPath, (db) =>
    db
      .query(
        `select contents
        from editors
        where item_id = $editorID and workspace_id = $workspaceID`,
      )
      .get({ $editorID: row.editor_id, $workspaceID: row.workspace_id }),
  ).pipe(
    Effect.map((value) => {
      const parsed = decodeZedEditorContents(value)
      if (Option.isNone(parsed)) return { type: "unavailable" as const }
      return { type: "contents" as const, contents: parsed.value.contents }
    }),
    Effect.orElseSucceed(() => ({ type: "unavailable" as const })),
  )
}

function isZedActiveEditorRow(row: ZedEditorRow): row is ZedActiveEditorRow {
  return row.item_kind === "Editor" && Predicate.isNotNull(row.editor_id)
}

/**
 * Finds the Zed database: OPENCODE_ZED_DB when it names a file, then the stable macOS and Linux locations.
 * A candidate that cannot be stated is skipped.
 */
export const resolveZedDbPath = Effect.fn("TuiEditorZed.resolveZedDbPath")(function* () {
  const fs = yield* FileSystem.FileSystem
  const configured = Option.filter(yield* readEnvSnapshot(ZedDbEnv), (item) => item.length > 0)
  const candidates = [
    ...Option.toArray(configured),
    path.join(os.homedir(), "Library", "Application Support", "Zed", "db", "0-stable", "db.sqlite"),
    path.join(os.homedir(), ".local", "share", "zed", "db", "0-stable", "db.sqlite"),
  ]

  for (const item of candidates) {
    const file = yield* fs.stat(item).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    )
    if (file) return Option.some(item)
  }
  return Option.none<string>()
}, Effect.provide(filesystem))

/** Reports whether opencode runs in a Zed terminal: ZED_TERM is "true", or TERM_PROGRAM is "zed" in any case. */
export const isZedTerminal = Effect.fn("TuiEditorZed.isZedTerminal")(function* () {
  const env = yield* readEnvSnapshot(ZedTerminalEnv)
  return (
    Option.exists(env.zedTerm, (value) => value === "true") ||
    Option.exists(env.termProgram, (value) => value.toLowerCase() === "zed")
  )
})

function scoreZedWorkspace(workspacePaths: string | null, cwd: string) {
  return zedWorkspacePaths(workspacePaths).reduce((score, item) => {
    if (pathContains(item, cwd)) return Math.max(score, path.resolve(item).length)
    return score
  }, 0)
}

function zedWorkspacePaths(value: string | null) {
  if (!value) return []
  return Option.match(decodeZedWorkspacePathList(value), {
    onSome: (items) => items.filter(Predicate.isString),
    onNone: () => value.split(/\r?\n/).filter(Boolean),
  })
}

export function offsetToPosition(text: string, offset: number) {
  const stringOffset = utf8ByteOffsetToStringIndex(text, offset)
  return offsetsToSelection(text, stringOffset, stringOffset).start
}

function utf8ByteOffsetToStringIndex(text: string, byteOffset: number) {
  if (byteOffset <= 0) return 0

  let bytes = 0
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) return text.length

    const nextIndex = index + (codePoint > 0xffff ? 2 : 1)
    bytes += utf8.encode(text.slice(index, nextIndex)).length
    if (bytes >= byteOffset) return nextIndex
    index = nextIndex
  }

  return text.length
}

function offsetsToSelection(text: string, startOffset: number, endOffset: number) {
  const start = Math.max(0, Math.min(startOffset, text.length))
  const end = Math.max(0, Math.min(endOffset, text.length))
  let line = 1
  let lineStart = 0
  let startPosition = position(line, lineStart, start)
  let endPosition = position(line, lineStart, end)

  for (let index = 0; index <= end; index++) {
    if (index === start) startPosition = position(line, lineStart, index)
    if (index === end) {
      endPosition = position(line, lineStart, index)
      break
    }
    if (text[index] === "\n") {
      line += 1
      lineStart = index + 1
    }
  }

  return { start: startPosition, end: endPosition }
}

function position(line: number, lineStart: number, offset: number) {
  return {
    line,
    character: offset - lineStart + 1,
  }
}

function pathContains(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
