import { AwsClient } from "aws4fetch"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { Config, Effect, Option, Redacted, Schema } from "effect"

export namespace Storage {
  export class StorageError extends Schema.TaggedError<StorageError>()("Enterprise.StorageError", {
    operation: Schema.Literals(["read", "write", "remove", "list"]),
    path: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    override get message() {
      return `Failed to ${this.operation} ${this.path}: ${this.reason}`
    }
  }

  export class NotConfiguredError extends Schema.TaggedError<NotConfiguredError>()(
    "Enterprise.StorageNotConfiguredError",
    {},
  ) {
    override get message() {
      return "No storage adapter configured"
    }
  }

  export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Enterprise.StorageNotFoundError", {
    key: Schema.Array(Schema.String),
  }) {
    override get message() {
      return "Not found"
    }
  }

  type Operation = StorageError["operation"]

  export interface Adapter {
    read(path: string): Effect.Effect<Option.Option<string>, StorageError>
    write(path: string, value: string): Effect.Effect<void, StorageError>
    remove(path: string): Effect.Effect<void, StorageError>
    list(options?: {
      prefix?: string
      limit?: number
      after?: string
      before?: string
    }): Effect.Effect<string[], StorageError>
  }

  // A request or body read that rejects fails with the reason that the platform gives.
  const failure = (operation: Operation, path: string, cause: unknown) =>
    new StorageError({ operation, path, reason: cause instanceof Error ? cause.message : "request failed", cause })

  function createAdapter(client: AwsClient, endpoint: string, bucket: string): Adapter {
    const base = `${endpoint}/${bucket}`
    const request = (operation: Operation, path: string, url: string, init?: RequestInit) =>
      Effect.tryPromise({ try: () => client.fetch(url, init), catch: (cause) => failure(operation, path, cause) })
    const text = (operation: Operation, path: string, response: Response) =>
      Effect.tryPromise({ try: () => response.text(), catch: (cause) => failure(operation, path, cause) })
    // A response outside the 2xx range fails with its status code.
    const check = (operation: Operation, path: string, response: Response) =>
      response.ok
        ? Effect.succeed(response)
        : Effect.fail(new StorageError({ operation, path, reason: `${response.status}` }))

    return {
      read: (path) =>
        Effect.gen(function* () {
          const response = yield* request("read", path, `${base}/${path}`)
          if (response.status === 404) return Option.none()
          yield* check("read", path, response)
          return Option.some(yield* text("read", path, response))
        }),

      write: (path, value) =>
        Effect.gen(function* () {
          const response = yield* request("write", path, `${base}/${path}`, {
            method: "PUT",
            body: value,
            headers: {
              "Content-Type": "application/json",
            },
          })
          yield* check("write", path, response)
        }),

      remove: (path) =>
        Effect.gen(function* () {
          const response = yield* request("remove", path, `${base}/${path}`, {
            method: "DELETE",
          })
          yield* check("remove", path, response)
        }),

      list: (options) =>
        Effect.gen(function* () {
          const prefix = options?.prefix || ""
          const params = new URLSearchParams({ "list-type": "2", prefix })
          if (options?.limit) params.set("max-keys", options.limit.toString())
          if (options?.after) {
            const afterPath = prefix + options.after + ".json"
            params.set("start-after", afterPath)
          }
          const response = yield* request("list", prefix, `${base}?${params}`)
          yield* check("list", prefix, response)
          const xml = yield* text("list", prefix, response)
          const keys = Array.from(xml.matchAll(/<Key>([^<]+)<\/Key>/g), (match) => match[1])
          if (options?.before) {
            const beforePath = prefix + options.before + ".json"
            return keys.filter((key) => key < beforePath)
          }
          return keys
        }),
    }
  }

  const Credentials = Config.all({
    accessKeyId: Config.String("OPENCODE_STORAGE_ACCESS_KEY_ID"),
    secretAccessKey: Config.Redacted("OPENCODE_STORAGE_SECRET_ACCESS_KEY"),
  })

  const S3Config = Config.all({
    credentials: Credentials,
    bucket: Config.String("OPENCODE_STORAGE_BUCKET"),
    // An empty region falls back to us-east-1, as a missing one does.
    region: Config.String("OPENCODE_STORAGE_REGION").pipe(
      Config.map((region) => region || "us-east-1"),
      Config.withDefault("us-east-1"),
    ),
  })

  const R2Config = Config.all({
    credentials: Credentials,
    bucket: Config.String("OPENCODE_STORAGE_BUCKET"),
    accountId: Config.String("OPENCODE_STORAGE_ACCOUNT_ID"),
  })

  const s3 = Effect.gen(function* () {
    const config = yield* readEnvSnapshot(S3Config)
    const client = new AwsClient({
      region: config.region,
      accessKeyId: config.credentials.accessKeyId,
      secretAccessKey: Redacted.value(config.credentials.secretAccessKey),
    })
    return createAdapter(client, `https://s3.${config.region}.amazonaws.com`, config.bucket)
  })

  const r2 = Effect.gen(function* () {
    const config = yield* readEnvSnapshot(R2Config)
    const client = new AwsClient({
      accessKeyId: config.credentials.accessKeyId,
      secretAccessKey: Redacted.value(config.credentials.secretAccessKey),
    })
    return createAdapter(client, `https://${config.accountId}.r2.cloudflarestorage.com`, config.bucket)
  })

  // Each operation builds its adapter from a fresh snapshot of the environment (see readEnvSnapshot).
  const adapter = Effect.gen(function* () {
    const type = yield* readEnvSnapshot(Config.option(Config.String("OPENCODE_STORAGE_ADAPTER")))
    if (Option.contains(type, "r2")) return yield* r2
    if (Option.contains(type, "s3")) return yield* s3
    return yield* new NotConfiguredError()
  })

  function resolve(key: ReadonlyArray<string>) {
    return key.join("/") + ".json"
  }

  export function read<A>(schema: Schema.Codec<A, unknown>, key: ReadonlyArray<string>) {
    return Effect.gen(function* () {
      const storage = yield* adapter
      const text = yield* storage.read(resolve(key))
      if (Option.isNone(text) || text.value === "") return Option.none()
      return Option.some(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text.value))
    })
  }

  export function write<A>(schema: Schema.Codec<A, unknown>, key: ReadonlyArray<string>, value: A) {
    return Effect.gen(function* () {
      const storage = yield* adapter
      const text = yield* Schema.encodeEffect(Schema.fromJsonString(schema))(value)
      yield* storage.write(resolve(key), text)
    })
  }

  export function remove(key: ReadonlyArray<string>) {
    return Effect.flatMap(adapter, (storage) => storage.remove(resolve(key)))
  }

  export function list(options?: { prefix?: ReadonlyArray<string>; limit?: number; after?: string; before?: string }) {
    return Effect.gen(function* () {
      const storage = yield* adapter
      const p = options?.prefix ? options.prefix.join("/") + (options.prefix.length ? "/" : "") : ""
      const result = yield* storage.list({
        prefix: p,
        limit: options?.limit,
        after: options?.after,
        before: options?.before,
      })
      return result.map((x) => x.replace(/\.json$/, "").split("/"))
    })
  }

  export function update<A>(schema: Schema.Codec<A, unknown>, key: ReadonlyArray<string>, fn: (draft: A) => void) {
    return Effect.gen(function* () {
      const val = yield* read(schema, key)
      if (Option.isNone(val)) return yield* new NotFoundError({ key })
      fn(val.value)
      yield* write(schema, key, val.value)
      return val.value
    })
  }
}
