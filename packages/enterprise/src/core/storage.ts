import { AwsClient } from "aws4fetch"
import { lazy } from "@opencode-ai/core/util/lazy"
import { Effect, Option, Schema } from "effect"

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

  function s3(): Adapter {
    const bucket = process.env.OPENCODE_STORAGE_BUCKET!
    const region = process.env.OPENCODE_STORAGE_REGION || "us-east-1"
    const client = new AwsClient({
      region,
      accessKeyId: process.env.OPENCODE_STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: process.env.OPENCODE_STORAGE_SECRET_ACCESS_KEY!,
    })
    return createAdapter(client, `https://s3.${region}.amazonaws.com`, bucket)
  }

  function r2() {
    const accountId = process.env.OPENCODE_STORAGE_ACCOUNT_ID!
    const client = new AwsClient({
      accessKeyId: process.env.OPENCODE_STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: process.env.OPENCODE_STORAGE_SECRET_ACCESS_KEY!,
    })
    return createAdapter(client, `https://${accountId}.r2.cloudflarestorage.com`, process.env.OPENCODE_STORAGE_BUCKET!)
  }

  const s3Adapter = lazy(s3)
  const r2Adapter = lazy(r2)

  const adapter = Effect.suspend(() => {
    const type = process.env.OPENCODE_STORAGE_ADAPTER
    if (type === "r2") return Effect.succeed(r2Adapter())
    if (type === "s3") return Effect.succeed(s3Adapter())
    return Effect.fail(new NotConfiguredError())
  })

  function resolve(key: ReadonlyArray<string>) {
    return key.join("/") + ".json"
  }

  export function read<T>(key: ReadonlyArray<string>) {
    return Effect.gen(function* () {
      const storage = yield* adapter
      const result = yield* storage.read(resolve(key))
      if (Option.isNone(result) || result.value === "") return Option.none<T>()
      return Option.some(JSON.parse(result.value) as T)
    })
  }

  export function write<T>(key: ReadonlyArray<string>, value: T) {
    return Effect.flatMap(adapter, (storage) => storage.write(resolve(key), JSON.stringify(value)))
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

  export function update<T>(key: ReadonlyArray<string>, fn: (draft: T) => void) {
    return Effect.gen(function* () {
      const val = yield* read<T>(key)
      if (Option.isNone(val)) return yield* new NotFoundError({ key })
      fn(val.value)
      yield* write(key, val.value)
      return val.value
    })
  }
}
