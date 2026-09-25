import { Message, Model, Part, Session, SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { Array, Config, Crypto, Effect, HashMap, Match, Option, Order, Predicate, Schema, String } from "effect"
import { WebCrypto } from "./crypto"
import { Storage } from "./storage"

export namespace Share {
  export const ID = Schema.String.pipe(Schema.brand("Share.ID"))
  export type ID = typeof ID.Type

  export const Info = Schema.Struct({
    id: ID,
    secret: Schema.String,
    sessionID: Schema.String,
  }).annotate({ identifier: "Share.Info" })
  export type Info = typeof Info.Type

  // The client syncs its own session records. The share service stores them as they arrive and
  // checks only their outer shape: an object for a record, an array for a list.
  const SessionData = Schema.declare((input: unknown): input is Session => Predicate.isObject(input), {
    identifier: "Share.SessionData",
  })
  const MessageData = Schema.declare((input: unknown): input is Message => Predicate.isObject(input), {
    identifier: "Share.MessageData",
  })
  const PartData = Schema.declare((input: unknown): input is Part => Predicate.isObject(input), {
    identifier: "Share.PartData",
  })
  const DiffData = Schema.declare((input: unknown): input is SnapshotFileDiff[] => Array.isArray(input), {
    identifier: "Share.DiffData",
  })
  const ModelData = Schema.declare((input: unknown): input is Model[] => Array.isArray(input), {
    identifier: "Share.ModelData",
  })

  export const Data = Schema.Union([
    Schema.Struct({ type: Schema.Literal("session"), data: SessionData }),
    Schema.Struct({ type: Schema.Literal("message"), data: MessageData }),
    Schema.Struct({ type: Schema.Literal("part"), data: PartData }),
    Schema.Struct({ type: Schema.Literal("session_diff"), data: DiffData }),
    Schema.Struct({ type: Schema.Literal("model"), data: ModelData }),
  ]).annotate({ identifier: "Share.Data" })
  export type Data = typeof Data.Type

  const CreateInput = Schema.Struct({ sessionID: Schema.String }).annotate({ identifier: "Share.CreateInput" })
  const Credentials = Schema.Struct({ id: ID, secret: Schema.String }).annotate({ identifier: "Share.Credentials" })
  const AdminInput = Schema.Struct({ id: ID }).annotate({ identifier: "Share.AdminInput" })
  const SyncInput = Schema.Struct({ share: Credentials, data: Schema.Array(Data) }).annotate({
    identifier: "Share.SyncInput",
  })

  export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Enterprise.ShareNotFoundError", { id: ID }) {
    override get message() {
      return `Share not found: ${this.id}`
    }
  }

  export class InvalidSecretError extends Schema.TaggedError<InvalidSecretError>()(
    "Enterprise.ShareInvalidSecretError",
    { id: ID },
  ) {
    override get message() {
      return `Share secret invalid: ${this.id}`
    }
  }

  export class AlreadyExistsError extends Schema.TaggedError<AlreadyExistsError>()(
    "Enterprise.ShareAlreadyExistsError",
    { id: ID },
  ) {
    override get message() {
      return `Share already exists: ${this.id}`
    }
  }

  export const Errors = {
    NotFound: NotFoundError,
    InvalidSecret: InvalidSecretError,
    AlreadyExists: AlreadyExistsError,
  }

  const DataList = Schema.Array(Data)

  export const Snapshot = Schema.Struct({ data: DataList }).annotate({ identifier: "Share.Snapshot" })

  const Compaction = Schema.Struct({
    event: Schema.OptionFromOptionalKey(Schema.String),
    data: DataList,
  }).annotate({ identifier: "Share.Compaction" })

  const key = Match.type<Data>().pipe(
    Match.discriminatorsExhaustive("type")({
      session: () => "session",
      message: (item) => `message/${item.data.id}`,
      part: (item) => `part/${item.data.messageID}/${item.data.id}`,
      session_diff: () => "session_diff",
      model: () => "model",
    }),
  )

  // Keys sort with localeCompare, as the stored snapshots always did.
  const byKey = Order.make<string>((self, that) => String.localeCompare(that)(self))

  // A later item replaces an earlier one with the same key.
  function merge(...items: ReadonlyArray<ReadonlyArray<Data>>) {
    const latest = HashMap.fromIterable(items.flat().map((item): [string, Data] => [key(item), item]))
    return Array.sortWith(HashMap.toEntries(latest), ([id]) => id, byKey).map(([, item]) => item)
  }

  const readSnapshot = (shareID: string) =>
    Storage.read(Snapshot, ["share_snapshot", shareID]).pipe(Effect.map(Option.map((snapshot) => snapshot.data)))

  const writeSnapshot = (shareID: string, data: ReadonlyArray<Data>) =>
    Storage.write(Snapshot, ["share_snapshot", shareID], { data })

  const legacy = Effect.fnUntraced(function* (shareID: string) {
    const compaction = Option.getOrElse(
      yield* Storage.read(Compaction, ["share_compaction", shareID]),
      (): typeof Compaction.Type => ({ event: Option.none(), data: [] }),
    )
    const list = (yield* Storage.list({
      prefix: ["share_event", shareID],
      before: Option.getOrUndefined(compaction.event),
    })).toReversed()
    if (list.length === 0) {
      if (compaction.data.length > 0) yield* writeSnapshot(shareID, compaction.data)
      return compaction.data
    }

    const events = yield* Effect.forEach(list, (event) => Storage.read(DataList, event), { concurrency: "unbounded" })
    const next = merge(
      compaction.data,
      events.flatMap((item) => Option.getOrElse(item, () => [])),
    )

    yield* Effect.all(
      [
        Storage.write(Compaction, ["share_compaction", shareID], {
          event: Option.fromNullishOr(list.at(-1)?.at(-1)),
          data: next,
        }),
        writeSnapshot(shareID, next),
      ],
      { concurrency: "unbounded", discard: true },
    )
    return next
  })

  // Fails with NotFound when no share has this id.
  const existing = (id: ID) =>
    get(id).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new NotFoundError({ id })),
          onSome: Effect.succeed,
        }),
      ),
    )

  const authorize = Effect.fnUntraced(function* (credentials: typeof Credentials.Type) {
    const share = yield* existing(credentials.id)
    if (share.secret !== credentials.secret) return yield* new InvalidSecretError({ id: credentials.id })
    return share
  })

  export const create = Effect.fn("Share.create")(function* (input: typeof CreateInput.Encoded) {
    const body = yield* Schema.decodeUnknownEffect(CreateInput)(input)
    const random = yield* Crypto.Crypto
    const nodeEnv = yield* readEnvSnapshot(Config.option(Config.String("NODE_ENV")))
    const isTest = Option.contains(nodeEnv, "test") || body.sessionID.startsWith("test_")
    const info: Info = {
      id: ID.make((isTest ? "test_" : "") + body.sessionID.slice(-8)),
      sessionID: body.sessionID,
      secret: yield* random.randomUUIDv4,
    }
    const exists = yield* get(info.id)
    if (Option.isSome(exists)) return yield* new AlreadyExistsError({ id: info.id })
    yield* Effect.all([Storage.write(Info, ["share", info.id], info), writeSnapshot(info.id, [])], {
      concurrency: "unbounded",
      discard: true,
    })
    return info
  }, Effect.provide(WebCrypto.layer))

  export const get = Effect.fn("Share.get")(function* (id: string) {
    return yield* Storage.read(Info, ["share", id])
  })

  export const remove = Effect.fn("Share.remove")(function* (input: typeof Credentials.Encoded) {
    const body = yield* Schema.decodeUnknownEffect(Credentials)(input)
    yield* authorize(body)
    yield* Storage.remove(["share", body.id])
    const groups = yield* Effect.all(
      [
        Storage.list({ prefix: ["share_snapshot", body.id] }),
        Storage.list({ prefix: ["share_compaction", body.id] }),
        Storage.list({ prefix: ["share_event", body.id] }),
        Storage.list({ prefix: ["share_data", body.id] }),
      ],
      { concurrency: "unbounded" },
    )
    yield* Effect.forEach(groups.flat(), (item) => Storage.remove(item), { discard: true })
  })

  export const removeAdmin = Effect.fn("Share.removeAdmin")(function* (input: typeof AdminInput.Encoded) {
    const body = yield* Schema.decodeUnknownEffect(AdminInput)(input)
    const share = yield* existing(body.id)
    yield* remove({ id: share.id, secret: share.secret })
  })

  export const sync = Effect.fn("Share.sync")(function* (input: typeof SyncInput.Encoded) {
    const body = yield* Schema.decodeUnknownEffect(SyncInput)(input)
    yield* authorize(body.share)
    const current = yield* data(body.share.id)
    yield* writeSnapshot(body.share.id, merge(current, body.data))
  })

  export const data = Effect.fn("Share.data")(function* (shareID: string) {
    const snapshot = yield* readSnapshot(shareID)
    if (Option.isSome(snapshot)) return snapshot.value
    return yield* legacy(shareID)
  })

  export const syncOld = Effect.fn("Share.syncOld")(function* (input: typeof SyncInput.Encoded) {
    const body = yield* Schema.decodeUnknownEffect(SyncInput)(input)
    yield* authorize(body.share)
    const shareID = body.share.id
    const write = Match.type<Data>().pipe(
      Match.discriminatorsExhaustive("type")({
        session: (item) => Storage.write(SessionData, ["share_data", shareID, "session"], item.data),
        message: (item) => Storage.write(MessageData, ["share_data", shareID, "message", item.data.id], item.data),
        part: (item) =>
          Storage.write(PartData, ["share_data", shareID, "part", item.data.messageID, item.data.id], item.data),
        session_diff: (item) => Storage.write(DiffData, ["share_data", shareID, "session_diff"], item.data),
        model: (item) => Storage.write(ModelData, ["share_data", shareID, "model"], item.data),
      }),
    )
    yield* Effect.forEach(body.data, write, { concurrency: "unbounded", discard: true })
  })
}
