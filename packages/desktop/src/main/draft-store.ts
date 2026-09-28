import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-sqlite"
import { blob, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Effect, Fiber, MutableHashMap, MutableHashSet, Option, Predicate, Schema } from "effect"

const documents = sqliteTable("document", {
  key: text().primaryKey(),
  value: text().notNull(),
})
const blobs = sqliteTable("blob", {
  id: text().primaryKey(),
  data: blob({ mode: "buffer" }).notNull(),
})

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export function createDesktopDraftStore(filename: string) {
  const native = new DatabaseSync(filename)
  native.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS document (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS blob (id TEXT PRIMARY KEY, data BLOB NOT NULL);",
  )
  const db = drizzle({ client: native })
  const used = MutableHashSet.empty<string>()
  db.select({ value: documents.value })
    .from(documents)
    .all()
    .forEach(({ value }) => Option.map(decodeJson(value), (parsed) => collectBlobIds(parsed, used)))
  db.select({ id: blobs.id })
    .from(blobs)
    .all()
    .filter(({ id }) => !MutableHashSet.has(used, id))
    .forEach(({ id }) => db.delete(blobs).where(eq(blobs.id, id)).run())
  const pending = MutableHashMap.empty<string, Option.Option<string>>()
  let timer: Option.Option<Fiber.Fiber<void>> = Option.none()
  const write = () => {
    const writes = [...pending]
    MutableHashMap.clear(pending)
    db.transaction((tx) => {
      writes.forEach(([key, value]) =>
        Option.match(value, {
          onNone: () => tx.delete(documents).where(eq(documents.key, key)).run(),
          onSome: (text) =>
            tx
              .insert(documents)
              .values({ key, value: text })
              .onConflictDoUpdate({ target: documents.key, set: { value: text } })
              .run(),
        }),
      )
    })
  }
  const flush = () => {
    if (Option.isSome(timer)) Effect.runFork(Fiber.interrupt(timer.value))
    timer = Option.none()
    write()
  }
  const schedule = () => {
    if (Option.isSome(timer)) return
    timer = Option.some(
      Effect.runFork(
        Effect.sleep("500 millis").pipe(
          Effect.andThen(
            Effect.sync(() => {
              timer = Option.none()
              write()
            }),
          ),
        ),
      ),
    )
  }
  return {
    get: (key: string) =>
      Option.getOrNull(
        Option.getOrElse(MutableHashMap.get(pending, key), () =>
          Option.fromNullishOr(
            db.select({ value: documents.value }).from(documents).where(eq(documents.key, key)).get()?.value,
          ),
        ),
      ),
    set(key: string, value: string) {
      MutableHashMap.set(pending, key, Option.some(value))
      schedule()
    },
    delete(key: string) {
      MutableHashMap.set(pending, key, Option.none())
      schedule()
    },
    putBlob(data: Uint8Array) {
      const id = createHash("sha256").update(data).digest("hex")
      db.insert(blobs)
        .values({ id, data: Buffer.from(data) })
        .onConflictDoNothing()
        .run()
      return id
    },
    getBlob: (id: string) =>
      Option.getOrNull(
        Option.fromNullishOr(db.select({ data: blobs.data }).from(blobs).where(eq(blobs.id, id)).get()?.data),
      ),
    flush,
    close() {
      flush()
      native.close()
    },
  }
}

// Mirrors the JSON.parse reviver walk: every nested value with a `blob.id` string marks that blob as used.
function collectBlobIds(value: unknown, used: MutableHashSet.MutableHashSet<string>): void {
  if (Array.isArray(value)) return value.forEach((item) => collectBlobIds(item, used))
  if (!Predicate.isObject(value)) return
  const blob = value.blob
  if (Predicate.isObject(blob) && typeof blob.id === "string") MutableHashSet.add(used, blob.id)
  Object.values(value).forEach((item) => collectBlobIds(item, used))
}
