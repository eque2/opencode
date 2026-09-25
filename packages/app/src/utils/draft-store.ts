import type { AsyncStorage } from "@solid-primitives/storage"
import { Data, Deferred, Effect, MutableHashMap, MutableHashSet, Option, Predicate, Schema } from "effect"

export type BlobReference = { id: string; url: string }

/** The Promise-shaped storage that a platform supplies. The desktop renderer passes its IPC calls here. */
type Driver = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
  putBlob(blob: Blob): Promise<string>
  getBlob(id: string): Promise<Blob | null>
}

export type DraftStore = AsyncStorage & { putBlob(blob: Blob): Promise<BlobReference> }

/** A storage call, a blob read, or a JSON step failed. `cause` holds the original rejection. */
class DraftStoreError extends Data.TaggedError("App.DraftStoreError")<{ readonly cause: unknown }> {}

/** The same storage, with each call as an Effect and each absent value as an Option. */
type EffectDriver = {
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, DraftStoreError>
  readonly set: (key: string, value: string) => Effect.Effect<void, DraftStoreError>
  readonly remove: (key: string) => Effect.Effect<void, DraftStoreError>
  readonly putBlob: (blob: Blob) => Effect.Effect<string, DraftStoreError>
  readonly getBlob: (id: string) => Effect.Effect<Option.Option<Blob>, DraftStoreError>
}

const urls = MutableHashMap.empty<string, string>()

const JsonText = Schema.fromJsonString(Schema.Unknown)
const readJson = Schema.decodeUnknownOption(JsonText)

const parseJson = (text: string) =>
  Schema.decodeEffect(JsonText)(text).pipe(Effect.mapError((cause) => new DraftStoreError({ cause })))

const printJson = (value: unknown) =>
  Schema.encodeEffect(JsonText)(value).pipe(Effect.mapError((cause) => new DraftStoreError({ cause })))

const attempt = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => new DraftStoreError({ cause }) })

/** Runs a program at a Promise boundary. A failure rejects with the original cause, as the async code did. */
const run = <A>(program: Effect.Effect<A, DraftStoreError>) =>
  Effect.runPromise(program.pipe(Effect.mapError((error) => error.cause)))

function blobUrl(id: string, blob: Blob) {
  return Option.getOrElse(MutableHashMap.get(urls, id), () => {
    const url = URL.createObjectURL(blob)
    MutableHashMap.set(urls, id, url)
    return url
  })
}

const fetchBlob = (url: string) =>
  attempt(() => fetch(url)).pipe(Effect.flatMap((response) => attempt(() => response.blob())))

const blobID = (blob: Blob) =>
  attempt(() => blob.arrayBuffer()).pipe(
    Effect.flatMap((buffer) => attempt(() => crypto.subtle.digest("SHA-256", buffer))),
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    ),
  )

export function createBlobReference(blob: Blob): Promise<BlobReference> {
  return run(blobID(blob).pipe(Effect.map((id) => ({ id, url: blobUrl(id, blob) }))))
}

type DraftObject = { readonly [x: PropertyKey]: unknown }

/** Rebuilds an object from its entries, each one mapped at the same time. */
const mapEntries = (value: DraftObject, f: (entry: unknown) => Effect.Effect<unknown, DraftStoreError>) =>
  Effect.forEach(
    Object.entries(value),
    ([key, entry]) => Effect.map(f(entry), (next): [string, unknown] => [key, next]),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)))

function makeDraftStore(driver: EffectDriver): DraftStore {
  const versions = MutableHashMap.empty<string, number>()

  /** Starts a change of `key` and returns its version. Only the latest version of a key may write it. */
  const nextVersion = (key: string) => {
    const version = Option.getOrElse(MutableHashMap.get(versions, key), () => 0) + 1
    MutableHashMap.set(versions, key, version)
    return version
  }

  const encode = (value: unknown): Effect.Effect<unknown, DraftStoreError> => {
    if (Array.isArray(value)) return Effect.forEach(value, encode, { concurrency: "unbounded" })
    if (!Predicate.isObject(value)) return Effect.succeed(value)
    if (value.type === "image" && Predicate.isString(value.dataUrl)) {
      const { dataUrl: _, ...rest } = value
      return fetchBlob(value.dataUrl).pipe(
        Effect.flatMap((blob) => driver.putBlob(blob)),
        Effect.map((id) => ({ ...rest, blob: { id } })),
      )
    }
    const ref = value.blob
    if (Predicate.isObjectOrArray(ref)) {
      if (Predicate.hasProperty(ref, "id") && Predicate.isString(ref.id) && ref.id.startsWith("data:")) {
        return fetchBlob(ref.id).pipe(
          Effect.flatMap((data) => driver.putBlob(data)),
          Effect.map((id) => ({ ...value, blob: { id } })),
        )
      }
      // A reference with no id kept an undefined id, which JSON writes as an empty object.
      return Effect.succeed({ ...value, blob: Predicate.hasProperty(ref, "id") ? { id: ref.id } : {} })
    }
    return mapEntries(value, encode)
  }

  const decode = (value: unknown): Effect.Effect<unknown, DraftStoreError> => {
    if (Array.isArray(value)) return Effect.forEach(value, decode, { concurrency: "unbounded" })
    if (!Predicate.isObject(value)) return Effect.succeed(value)
    const ref = value.blob
    if (Predicate.hasProperty(ref, "id") && Predicate.isString(ref.id)) {
      const id = ref.id
      return driver.getBlob(id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => mapEntries(value, decode),
            onSome: (blob) => Effect.succeed({ ...value, blob: { id, url: blobUrl(id, blob) } }),
          }),
        ),
      )
    }
    return mapEntries(value, decode)
  }

  return {
    getItem: (key) =>
      run(
        driver.get(key).pipe(
          Effect.flatMap((stored) =>
            Effect.transposeOption(
              Option.map(stored, (text) => parseJson(text).pipe(Effect.flatMap(decode), Effect.flatMap(printJson))),
            ),
          ),
          Effect.map(Option.getOrNull),
        ),
      ),
    setItem: (key, value) => {
      const version = nextVersion(key)
      return run(
        parseJson(value).pipe(
          Effect.flatMap(encode),
          Effect.flatMap(printJson),
          Effect.flatMap((encoded) =>
            Option.contains(MutableHashMap.get(versions, key), version) ? driver.set(key, encoded) : Effect.void,
          ),
        ),
      )
    },
    removeItem: (key) => {
      nextVersion(key)
      return run(driver.remove(key))
    },
    putBlob: (blob) => run(driver.putBlob(blob).pipe(Effect.map((id) => ({ id, url: blobUrl(id, blob) })))),
  }
}

export function createDraftStore(driver: Driver): DraftStore {
  return makeDraftStore({
    get: (key) => attempt(() => driver.get(key)).pipe(Effect.map(Option.fromNullishOr)),
    set: (key, value) => attempt(() => driver.set(key, value)),
    remove: (key) => attempt(() => driver.remove(key)),
    putBlob: (blob) => attempt(() => driver.putBlob(blob)),
    getBlob: (id) => attempt(() => driver.getBlob(id)).pipe(Effect.map(Option.fromNullishOr)),
  })
}

/** The blob ids that a stored draft references at any depth, as the old JSON reviver collected them. */
const blobReferences = (value: unknown): ReadonlyArray<string> => {
  const nested = Predicate.isObjectOrArray(value) ? Object.values(value).flatMap(blobReferences) : []
  if (Predicate.hasProperty(value, "blob") && Predicate.hasProperty(value.blob, "id") && Predicate.isString(value.blob.id))
    return [...nested, value.blob.id]
  return nested
}

/** The blob ids that the stored drafts reference, or none when a stored draft does not parse. */
const referencedBlobs = (documents: ReadonlyArray<unknown>) =>
  Option.map(Option.all(documents.map((document) => readJson(document))), (values) =>
    MutableHashSet.fromIterable(values.flatMap(blobReferences)),
  )

const isBlob = (value: unknown): value is Blob => value instanceof Blob

export function createBrowserDraftStore(): DraftStore {
  const request = indexedDB.open("opencode-drafts", 1)
  request.addEventListener("upgradeneeded", () => {
    request.result.createObjectStore("documents")
    request.result.createObjectStore("blobs")
  })
  const opened = Deferred.makeUnsafe<IDBDatabase, DraftStoreError>()
  request.addEventListener("success", () => {
    const database = request.result
    const transaction = database.transaction(["documents", "blobs"], "readwrite")
    const documents = transaction.objectStore("documents").getAll()
    documents.addEventListener("success", () => {
      // A stored draft that does not parse keeps every blob, as the parse error that stopped this sweep did.
      const referenced = referencedBlobs(documents.result)
      if (Option.isNone(referenced)) return
      const used = referenced.value
      const blobs = transaction.objectStore("blobs").openKeyCursor()
      blobs.addEventListener("success", () => {
        const cursor = blobs.result
        if (!cursor) return
        if (!(Predicate.isString(cursor.key) && MutableHashSet.has(used, cursor.key))) cursor.delete()
        cursor.continue()
      })
    })
    const done = () => Deferred.doneUnsafe(opened, Effect.succeed(database))
    transaction.addEventListener("complete", done)
    transaction.addEventListener("abort", done)
  })
  request.addEventListener("error", () =>
    Deferred.doneUnsafe(opened, Effect.fail(new DraftStoreError({ cause: request.error }))),
  )
  const connection = Deferred.await(opened)
  // Each request and its listeners start in one step, so no event can fire before its listener exists.
  const read = (store: string, key: string) =>
    Effect.flatMap(connection, (db) =>
      Effect.callback<unknown, DraftStoreError>((resume) => {
        const result = db.transaction(store).objectStore(store).get(key)
        result.addEventListener("success", () => resume(Effect.succeed(result.result)))
        result.addEventListener("error", () => resume(Effect.fail(new DraftStoreError({ cause: result.error }))))
      }),
    )
  const write = (store: string, change: (objects: IDBObjectStore) => void) =>
    Effect.flatMap(connection, (db) =>
      Effect.callback<void, DraftStoreError>((resume) => {
        const transaction = db.transaction(store, "readwrite")
        change(transaction.objectStore(store))
        transaction.addEventListener("complete", () => resume(Effect.void))
        transaction.addEventListener("error", () =>
          resume(Effect.fail(new DraftStoreError({ cause: transaction.error }))),
        )
      }),
    )
  return makeDraftStore({
    get: (key) => read("documents", key).pipe(Effect.map(Option.liftPredicate(Predicate.isString))),
    set: (key, value) => write("documents", (objects) => objects.put(value, key)),
    remove: (key) => write("documents", (objects) => objects.delete(key)),
    putBlob: (blob) => blobID(blob).pipe(Effect.tap((id) => write("blobs", (objects) => objects.put(blob, id)))),
    getBlob: (id) => read("blobs", id).pipe(Effect.map(Option.liftPredicate(isBlob))),
  })
}

/** Reads a blob as a data URL. */
const readDataUrl = (data: Blob) =>
  Effect.callback<string, DraftStoreError>((resume) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => resume(Effect.fail(new DraftStoreError({ cause: reader.error }))))
    reader.addEventListener("load", () => resume(Effect.succeed(Predicate.isString(reader.result) ? reader.result : "")))
    reader.readAsDataURL(data)
  })

export function blobDataUrl(blob: BlobReference, mime: string): Promise<string> {
  return run(
    fetchBlob(blob.url).pipe(
      Effect.flatMap(readDataUrl),
      Effect.map((value) => `data:${mime};base64,${value.slice(value.indexOf(",") + 1)}`),
    ),
  )
}

export function createLegacyBlobReference(dataUrl: string): BlobReference {
  return { id: dataUrl, url: dataUrl }
}
