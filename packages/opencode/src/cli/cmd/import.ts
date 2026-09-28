import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { CliError, effectCmd } from "../effect-cmd"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { InstanceRef } from "@/effect/instance-ref"
import { ShareNext } from "@/share/share-next"
import { EOL } from "os"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Array as Arr, Clock, Effect, HashMap, Option, Schema } from "effect"
import type { InstanceContext } from "@/project/instance-context"

const decodeMessageInfo = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

// Share records pass through to the SessionV1 decoders below, so only the keys used for grouping are typed.
const Fields = Schema.Record(Schema.String, Schema.Json)

const ShareSession = Schema.Struct({ type: Schema.Literal("session"), data: Fields }).annotate({
  identifier: "ShareSession",
  description: "The session record of a share",
})
const ShareMessage = Schema.Struct({
  type: Schema.Literal("message"),
  data: Schema.StructWithRest(Schema.Struct({ id: SessionV1.MessageID }), [Fields]),
}).annotate({ identifier: "ShareMessage", description: "A message record of a share" })
const SharePart = Schema.Struct({
  type: Schema.Literal("part"),
  data: Schema.StructWithRest(Schema.Struct({ messageID: SessionV1.MessageID }), [Fields]),
}).annotate({ identifier: "SharePart", description: "A message part record of a share" })
const ShareOther = Schema.Struct({ type: Schema.Literals(["session_diff", "model"]), data: Schema.Json }).annotate({
  identifier: "ShareOther",
  description: "A share record that import does not store",
})

/** Discriminated union returned by the ShareNext API (GET /api/shares/:id/data) */
export const ShareData = Schema.Union([ShareSession, ShareMessage, SharePart, ShareOther]).annotate({
  identifier: "ShareData",
  description: "One record of the flat array that the ShareNext data API returns",
})
export type ShareData = typeof ShareData.Type

// Records of an unknown type are skipped, as the untyped grouping skipped them.
const decodeShareItem = Schema.decodeUnknownOption(ShareData)
const decodeShareJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Json)))

const ExportFile = Schema.Struct({
  info: Fields,
  messages: Schema.Array(Schema.Struct({ info: Schema.Json, parts: Schema.Array(Schema.Json) })),
}).annotate({ identifier: "ExportFile", description: "A session export written by `opencode export`" })
const decodeExportFile = Schema.decodeUnknownOption(ExportFile)

/** Extract share ID from a share URL like https://opncd.ai/share/abc123 */
export function parseShareUrl(url: string): Option.Option<string> {
  const match = url.match(/^https?:\/\/[^/]+\/share\/([a-zA-Z0-9_-]+)$/)
  return match ? Option.some(match[1]) : Option.none()
}

export function shouldAttachShareAuthHeaders(shareUrl: string, accountBaseUrl: string): boolean {
  if (!URL.canParse(shareUrl) || !URL.canParse(accountBaseUrl)) return false
  return new URL(shareUrl).origin === new URL(accountBaseUrl).origin
}

export function formatImportFileError(file: string, error: FSUtil.Error) {
  if (error._tag === "PlatformError") {
    if (error.reason._tag === "NotFound") return `File not found: ${file}`
    if (error.reason._tag === "PermissionDenied") return `Failed to read file: Permission denied`
    return `Failed to read file: ${error.message}`
  }

  const detail = error.cause instanceof Error ? error.cause.message : error.message
  return `Invalid JSON in ${file}: ${detail}`
}

/**
 * Transform ShareNext API response (flat array) into the nested structure for local file storage.
 *
 * The API returns a flat array: [session, message, message, part, part, ...]
 * Local storage expects: { info: session, messages: [{ info: message, parts: [part, ...] }, ...] }
 *
 * This groups parts by their messageID to reconstruct the hierarchy before writing to disk.
 */
export function transformShareData(shareData: ReadonlyArray<ShareData>) {
  const sessionItem = shareData.find((d) => d.type === "session")
  if (!sessionItem) return Option.none()

  const messages = shareData.flatMap((item) => (item.type === "message" ? [item.data] : []))
  const parts = shareData.flatMap((item) => (item.type === "part" ? [item.data] : []))
  // A repeated message ID keeps its first position and its last record.
  const latest = HashMap.fromIterable(messages.map((msg) => [msg.id, msg] as const))
  const ordered = Arr.getSomes(Arr.dedupe(messages.map((msg) => msg.id)).map((id) => HashMap.get(latest, id)))
  if (ordered.length === 0) return Option.none()

  const partsByMessage = HashMap.fromIterable(Object.entries(Arr.groupBy(parts, (part) => part.messageID)))
  return Option.some({
    info: sessionItem.data,
    messages: ordered.map((msg) => ({
      info: msg,
      parts: Option.getOrElse(HashMap.get(partsByMessage, msg.id), () => []),
    })),
  })
}

export const ImportCommand = effectCmd({
  command: "import <file>",
  describe: "import session data from JSON file or URL",
  builder: (yargs) =>
    yargs.positional("file", {
      describe: "path to JSON file or share URL",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.import")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* runImport(args.file, ctx)
  }),
})

const runImport = Effect.fn("Cli.import.body")(function* (file: string, ctx: InstanceContext) {
  const { db } = yield* Database.Service

  const isUrl = file.startsWith("http://") || file.startsWith("https://")
  const exportData = isUrl ? yield* fetchShare(file) : yield* readExportFile(file)

  if (Option.isNone(exportData)) return
  const data = exportData.value

  const decoded = Schema.decodeUnknownSync(Session.Info)({
    ...data.info,
    projectID: ctx.project.id,
    directory: ctx.directory,
    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
  })
  // Session.Info is the mutable view of the schema type, so copy the decoded readonly arrays.
  const info: Session.Info = {
    ...decoded,
    summary: decoded.summary && { ...decoded.summary, diffs: decoded.summary.diffs?.slice() },
    permission: decoded.permission?.slice(),
  }
  const row = Session.toRow(info)
  yield* db
    .insert(SessionTable)
    .values(row)
    .onConflictDoUpdate({
      target: SessionTable.id,
      set: { project_id: row.project_id, directory: row.directory, path: row.path },
    })
    .run()
    .pipe(Effect.orDie)

  for (const msg of data.messages) {
    const msgInfo = decodeMessageInfo(msg.info)
    const { id, sessionID: _, ...msgData } = msgInfo
    yield* db
      .insert(MessageTable)
      .values({
        id,
        session_id: row.id,
        time_created: msgInfo.time?.created ?? (yield* Clock.currentTimeMillis),
        data: msgData,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

    for (const part of msg.parts) {
      const partInfo = decodePart(part)
      const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
      yield* db
        .insert(PartTable)
        .values({
          id: partId,
          message_id: messageID,
          session_id: row.id,
          data: partData,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }
  }

  process.stdout.write(`Imported session: ${decoded.id}`)
  process.stdout.write(EOL)
})

// Reads an export file. None means the failure was already printed.
const readExportFile = Effect.fn("Cli.import.readFile")(function* (file: string) {
  const fs = yield* FSUtil.Service
  const content = yield* fs
    .readJson(file)
    .pipe(Effect.mapError((error) => new CliError({ message: formatImportFileError(file, error) })))
  const exportFile = decodeExportFile(content)
  // A file that is not an export (for example JSON null) keeps the old message.
  if (Option.isNone(exportFile)) {
    process.stdout.write(`Failed to read session data`)
    process.stdout.write(EOL)
  }
  return exportFile
})

// Fetches and groups a share. None means the failure was already printed.
const fetchShare = Effect.fn("Cli.import.fetchShare")(function* (file: string) {
  const share = yield* ShareNext.Service
  const found = parseShareUrl(file)
  if (Option.isNone(found)) {
    const baseUrl = yield* Effect.orDie(share.url())
    process.stdout.write(`Invalid URL format. Expected: ${baseUrl}/share/<slug>`)
    process.stdout.write(EOL)
    return Option.none()
  }
  const slug = found.value

  const baseUrl = new URL(file).origin
  const req = yield* Effect.orDie(share.request())
  const headers = shouldAttachShareAuthHeaders(file, req.baseUrl) ? req.headers : {}

  const tryFetch = (url: string) =>
    Effect.tryPromise({
      try: () => fetch(url, { headers }),
      catch: (e) =>
        new CliError({
          message: `Failed to fetch share data: ${e instanceof Error ? e.message : String(e)}`,
        }),
    })

  const dataPath = req.api.data(slug)
  const legacyPath = `/api/share/${slug}/data`
  const first = yield* tryFetch(`${baseUrl}${dataPath}`)
  const response = !first.ok && dataPath !== legacyPath ? yield* tryFetch(`${baseUrl}${legacyPath}`) : first

  if (!response.ok) {
    process.stdout.write(`Failed to fetch share data: ${response.statusText}`)
    process.stdout.write(EOL)
    return Option.none()
  }

  const invalid = () => new CliError({ message: "Share data was not valid JSON" })
  const text = yield* Effect.tryPromise({ try: () => response.text(), catch: invalid })
  const records = yield* decodeShareJson(text).pipe(Effect.mapError(invalid))
  const transformed = transformShareData(Arr.getSomes(records.map((record) => decodeShareItem(record))))

  if (Option.isNone(transformed)) {
    process.stdout.write(`Share not found or empty: ${slug}`)
    process.stdout.write(EOL)
  }
  return transformed
})
