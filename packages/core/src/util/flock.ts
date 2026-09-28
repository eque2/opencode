import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { NodeFileSystem } from "@effect/platform-node"
import { Clock, DateTime, Duration, Effect, Fiber, FileSystem, Option, Predicate, Random, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Hash } from "./hash"

export type FlockGlobal = {
  state: string
}

export namespace Flock {
  let global: Option.Option<FlockGlobal> = Option.none()

  export function setGlobal(g: FlockGlobal) {
    global = Option.some(g)
  }

  export class GlobalNotSetError extends Schema.TaggedError<GlobalNotSetError>()("Flock.GlobalNotSetError", {
    message: Schema.String,
  }) {}

  export class LockTimeoutError extends Schema.TaggedError<LockTimeoutError>()("Flock.LockTimeoutError", {
    key: Schema.String,
    message: Schema.String,
  }) {}

  export class LockCompromisedError extends Schema.TaggedError<LockCompromisedError>()("Flock.LockCompromisedError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {}

  export class LockOwnerError extends Schema.TaggedError<LockOwnerError>()("Flock.LockOwnerError", {
    message: Schema.String,
  }) {}

  export class FileSystemError extends Schema.TaggedError<FileSystemError>()("Flock.FileSystemError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {}

  export type LockError = GlobalNotSetError | LockTimeoutError | LockCompromisedError | LockOwnerError | FileSystemError

  // Defaults for callers that do not provide timing options.
  const defaultOpts = {
    staleMs: 60_000,
    timeoutMs: 5 * 60_000,
    baseDelayMs: 100,
    maxDelayMs: 2_000,
  }

  export interface WaitEvent {
    key: string
    attempt: number
    delay: number
    waited: number
  }

  export type Wait = (input: WaitEvent) => void | Promise<void>

  export interface Options {
    dir?: string
    signal?: AbortSignal
    staleMs?: number
    timeoutMs?: number
    baseDelayMs?: number
    maxDelayMs?: number
    onWait?: Wait
  }

  type Opts = {
    staleMs: number
    timeoutMs: number
    baseDelayMs: number
    maxDelayMs: number
  }

  type Handle = {
    token: string
    lockDir: string
    metaPath: string
    heartbeatPath: string
    staleMs: number
  }

  export interface Lease {
    release: () => Promise<void>
    [Symbol.asyncDispose]: () => Promise<void>
  }

  const LockMeta = Schema.Struct({
    token: Schema.String,
    pid: Schema.Number,
    hostname: Schema.String,
    createdAt: Schema.String,
  }).annotate({ identifier: "Flock.LockMeta" })

  const LockOwner = Schema.Struct({ token: Schema.String }).annotate({ identifier: "Flock.LockOwner" })

  const encodeMeta = Schema.encodeEffect(Schema.fromJsonString(LockMeta, { space: 2 }))
  const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))
  const decodeOwner = Schema.decodeUnknownOption(LockOwner)

  // Node reports the errno code on the PlatformError cause; the lock protocol branches on exact codes.
  const hasCode = (error: PlatformError, codes: ReadonlyArray<string>) =>
    Predicate.hasProperty(error.cause, "code") &&
    Predicate.isString(error.cause.code) &&
    codes.includes(error.cause.code)

  const isMissing = (error: PlatformError) => hasCode(error, ["ENOENT", "ENOTDIR"])

  // Keep the Node message (for example "EACCES: permission denied, mkdir ...") that callers show to users.
  const fileSystemError = (error: PlatformError) =>
    new FileSystemError({ message: Predicate.isError(error.cause) ? error.cause.message : error.message, cause: error })

  const mtimeMs = (info: FileSystem.File.Info) =>
    Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() })

  const root = Effect.suspend(() =>
    Option.match(global, {
      onNone: () => Effect.fail(new GlobalNotSetError({ message: "Flock global not set" })),
      onSome: (value) => Effect.succeed(path.join(value.state, "locks")),
    }),
  )

  const stats = Effect.fnUntraced(function* (file: string) {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.stat(file).pipe(
      Effect.map(Option.some),
      Effect.catchIf(isMissing, () => Effect.succeedNone),
      Effect.mapError(fileSystemError),
    )
  })

  const removeTree = Effect.fnUntraced(function* (target: string) {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.remove(target, { recursive: true, force: true }).pipe(Effect.mapError(fileSystemError))
  })

  /** Atomic mkdir: true when this call created `dir`, false when it failed with one of `taken`. */
  const makeExclusiveDir = Effect.fnUntraced(function* (dir: string, taken: ReadonlyArray<string>) {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.makeDirectory(dir, { mode: 0o700 }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => hasCode(error, taken),
        () => Effect.succeed(false),
      ),
      Effect.mapError(fileSystemError),
    )
  })

  const isStale = Effect.fnUntraced(function* (handle: Handle) {
    // Stale detection allows automatic recovery after crashed owners.
    const now = yield* Clock.currentTimeMillis
    const heartbeat = yield* stats(handle.heartbeatPath)
    if (Option.isSome(heartbeat)) return now - mtimeMs(heartbeat.value) > handle.staleMs

    const meta = yield* stats(handle.metaPath)
    if (Option.isSome(meta)) return now - mtimeMs(meta.value) > handle.staleMs

    const dir = yield* stats(handle.lockDir)
    return Option.exists(dir, (info) => now - mtimeMs(info) > handle.staleMs)
  })

  const clearStaleBreaker = Effect.fnUntraced(function* (breakerPath: string, staleMs: number) {
    const breaker = yield* stats(breakerPath)
    const now = yield* Clock.currentTimeMillis
    if (Option.exists(breaker, (info) => now - mtimeMs(info) > staleMs)) yield* Effect.ignore(removeTree(breakerPath))
    return false
  })

  const claimBreaker = Effect.fnUntraced(function* (breakerPath: string, staleMs: number) {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.makeDirectory(breakerPath, { mode: 0o700 }).pipe(
      Effect.as(true),
      Effect.catch((error) => {
        if (hasCode(error, ["EEXIST"])) return clearStaleBreaker(breakerPath, staleMs)
        if (isMissing(error)) return Effect.succeed(false)
        return Effect.fail(fileSystemError(error))
      }),
    )
  })

  const breakStaleLock = Effect.fnUntraced(function* (handle: Handle) {
    if (!(yield* isStale(handle))) return false

    const breakerPath = handle.lockDir + ".breaker"
    if (!(yield* claimBreaker(breakerPath, handle.staleMs))) return false

    return yield* Effect.gen(function* () {
      // Breaker ownership ensures only one contender performs stale cleanup.
      if (!(yield* isStale(handle))) return false
      yield* removeTree(handle.lockDir)
      return yield* makeExclusiveDir(handle.lockDir, ["EEXIST", "ENOTEMPTY"])
    }).pipe(Effect.ensuring(Effect.ignore(removeTree(breakerPath))))
  })

  const writeExclusive = Effect.fnUntraced(function* (file: string, content: string, lockDir: string, message: string) {
    const fs = yield* FileSystem.FileSystem
    return yield* fs
      .writeFileString(file, content, { flag: "wx" })
      .pipe(
        Effect.catch((cause) =>
          removeTree(lockDir).pipe(Effect.andThen(Effect.fail(new LockCompromisedError({ message, cause })))),
        ),
      )
  })

  const tryAcquireLockDir = Effect.fnUntraced(function* (lockDir: string, staleMs: number) {
    const handle: Handle = {
      token: randomUUID(),
      lockDir,
      metaPath: path.join(lockDir, "meta.json"),
      heartbeatPath: path.join(lockDir, "heartbeat"),
      staleMs,
    }

    const created = yield* makeExclusiveDir(lockDir, ["EEXIST"])
    if (!created && !(yield* breakStaleLock(handle))) return Option.none<Handle>()

    yield* writeExclusive(
      handle.heartbeatPath,
      "",
      lockDir,
      "Lock acquired but heartbeat already existed (possible compromise).",
    )

    const meta = yield* encodeMeta({
      token: handle.token,
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: DateTime.formatIso(yield* DateTime.now),
    }).pipe(Effect.orDie)
    yield* writeExclusive(
      handle.metaPath,
      meta,
      lockDir,
      "Lock acquired but meta.json already existed (possible compromise).",
    )

    return Option.some(handle)
  })

  const jitter = Effect.fnUntraced(function* (ms: number) {
    const j = Math.floor(ms * 0.3)
    return Math.max(0, ms + (yield* Random.nextIntBetween(-j, j)))
  })

  // A Wait callback may return a Promise; its failure rejects the acquire, as before.
  const notify = (onWait: Option.Option<Wait>, event: WaitEvent) =>
    Option.match(onWait, {
      onNone: () => Effect.void,
      onSome: (wait) =>
        Effect.sync(() => wait(event)).pipe(
          Effect.flatMap((result) => (Predicate.isPromise(result) ? Effect.promise(() => result) : Effect.void)),
        ),
    })

  const waitForLockDir = Effect.fnUntraced(function* (
    lockDir: string,
    input: { key: string; onWait: Option.Option<Wait> },
    opts: Opts,
  ) {
    const stop = (yield* Clock.currentTimeMillis) + opts.timeoutMs
    let attempt = 0
    let waited = 0
    let delay = opts.baseDelayMs

    while (true) {
      const lock = yield* tryAcquireLockDir(lockDir, opts.staleMs)
      if (Option.isSome(lock)) return lock.value

      if ((yield* Clock.currentTimeMillis) > stop) {
        return yield* new LockTimeoutError({ key: input.key, message: `Timed out waiting for lock: ${input.key}` })
      }

      attempt += 1
      const ms = yield* jitter(delay)
      yield* notify(input.onWait, { key: input.key, attempt, delay: ms, waited })
      yield* Effect.sleep(Duration.millis(ms))
      waited += ms
      delay = Math.min(opts.maxDelayMs, Math.floor(delay * 1.7))
    }
  })

  const acquireHandle = Effect.fnUntraced(function* (key: string, input: Options) {
    const opts: Opts = {
      staleMs: input.staleMs ?? defaultOpts.staleMs,
      timeoutMs: input.timeoutMs ?? defaultOpts.timeoutMs,
      baseDelayMs: input.baseDelayMs ?? defaultOpts.baseDelayMs,
      maxDelayMs: input.maxDelayMs ?? defaultOpts.maxDelayMs,
    }
    const dir = yield* Option.match(Option.fromUndefinedOr(input.dir), {
      onNone: () => root,
      onSome: (value) => Effect.succeed(value),
    })

    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError(fileSystemError))
    return yield* waitForLockDir(
      path.join(dir, Hash.fast(key) + ".lock"),
      { key, onWait: Option.fromUndefinedOr(input.onWait) },
      opts,
    )
  })

  // Heartbeat prevents long critical sections from being evicted as stale.
  const heartbeat = (handle: Handle) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const now = DateTime.toDateUtc(yield* DateTime.now)
      return yield* fs.utimes(handle.heartbeatPath, now, now)
    }).pipe(Effect.ignore, Effect.delay(Duration.millis(Math.max(100, Math.floor(handle.staleMs / 3)))), Effect.forever)

  const releaseHandle = Effect.fnUntraced(function* (handle: Handle) {
    const fs = yield* FileSystem.FileSystem
    const raw = yield* fs
      .readFileString(handle.metaPath)
      .pipe(
        Effect.mapError((error) =>
          isMissing(error)
            ? new LockCompromisedError({ message: "Refusing to release: lock is compromised (metadata missing)." })
            : fileSystemError(error),
        ),
      )
    const json = yield* decodeJson(raw).pipe(
      Effect.mapError(
        (cause) =>
          new LockCompromisedError({ message: "Refusing to release: lock is compromised (metadata invalid).", cause }),
      ),
    )

    // Token check prevents deleting a lock that was re-acquired by another process.
    if (!Option.exists(decodeOwner(json), (meta) => meta.token === handle.token)) {
      return yield* new LockOwnerError({ message: "Refusing to release: lock token mismatch (not the owner)." })
    }

    return yield* removeTree(handle.lockDir)
  })

  // Scoped lock: the heartbeat fiber stops before the release finalizer runs.
  const scoped = (key: string, input: Options) =>
    Effect.acquireRelease(
      acquireHandle(key, input).pipe(Effect.withSpan("Flock.acquire", { attributes: { key } })),
      (handle) => releaseHandle(handle).pipe(Effect.withSpan("Flock.release"), Effect.orDie),
    ).pipe(Effect.tap((handle) => Effect.forkScoped(heartbeat(handle))))

  // The Promise API serves callers outside Effect; each call runs on the Node filesystem.
  const run = <A>(effect: Effect.Effect<A, LockError, FileSystem.FileSystem>, signal?: AbortSignal) =>
    Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)), { signal })

  export function acquire(key: string, input: Options = {}): Promise<Lease> {
    return run(
      Effect.gen(function* () {
        const handle = yield* acquireHandle(key, input)
        const beat = yield* Effect.forkDetach(heartbeat(handle))
        const release = () => run(Fiber.interrupt(beat).pipe(Effect.andThen(releaseHandle(handle))))
        return { release, [Symbol.asyncDispose]: release } satisfies Lease
      }),
      input.signal,
    )
  }

  export function withLock<T>(key: string, fn: () => Promise<T>, input: Options = {}): Promise<T> {
    return run(Effect.scoped(scoped(key, input).pipe(Effect.andThen(Effect.promise(() => fn())))), input.signal)
  }

  export const effect = Effect.fn("Flock.effect")(
    function* (key: string, input: Options = {}) {
      yield* scoped(key, input)
    },
    Effect.orDie,
    Effect.provide(NodeFileSystem.layer),
  )
}
