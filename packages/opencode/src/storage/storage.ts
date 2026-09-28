import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Clock, Effect, Exit, Layer, Option, RcMap, Schema, Context, TxReentrantLock } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Git } from "@/git"

type Migration = (dir: string, fs: FSUtil.Interface, git: Git.Interface) => Effect.Effect<void, FSUtil.Error>

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  message: Schema.String,
}) {
  static isInstance(input: unknown): input is NotFoundError {
    return input instanceof NotFoundError
  }
}

export type Error = FSUtil.Error | NotFoundError

const RootFile = Schema.Struct({
  path: Schema.optional(
    Schema.Struct({
      root: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "Storage.RootFile", description: "The worktree root in a legacy message file" })

// Legacy files do not guarantee the "ses"/"msg" prefixes that SessionID and
// MessageID check, so these brands mark the ids without a prefix check.
const LegacySessionID = Schema.String.pipe(Schema.brand("Storage.LegacySessionID"))
const LegacyMessageID = Schema.String.pipe(Schema.brand("Storage.LegacyMessageID"))

const SessionFile = Schema.Struct({
  id: LegacySessionID,
}).annotate({ identifier: "Storage.SessionFile", description: "The id of a legacy session info file" })

const MessageFile = Schema.Struct({
  id: LegacyMessageID,
}).annotate({ identifier: "Storage.MessageFile", description: "The id of a legacy message file" })

const DiffFile = Schema.Struct({
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
}).annotate({ identifier: "Storage.DiffFile", description: "The line counts of one legacy session diff" })

const SummaryFile = Schema.Struct({
  id: LegacySessionID,
  projectID: Schema.String,
  summary: Schema.Struct({ diffs: Schema.Array(DiffFile) }),
}).annotate({ identifier: "Storage.SummaryFile", description: "A legacy session file that holds inline diffs" })

const decodeRoot = Schema.decodeUnknownOption(RootFile)
const decodeSession = Schema.decodeUnknownOption(SessionFile)
const decodeMessage = Schema.decodeUnknownOption(MessageFile)
const decodeSummary = Schema.decodeUnknownOption(SummaryFile)

// Storage files hold arbitrary JSON, pretty-printed with two spaces.
const encodeJsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
// A value that JSON cannot represent is a programming defect, as it was with JSON.stringify.
const jsonText = (value: unknown) => encodeJsonText(value).pipe(Effect.orDie)

export interface Interface {
  readonly remove: (key: string[]) => Effect.Effect<void, FSUtil.Error>
  readonly read: <T>(key: string[]) => Effect.Effect<T, Error>
  readonly update: <T>(key: string[], fn: (draft: T) => void) => Effect.Effect<T, Error>
  readonly write: <T>(key: string[], content: T) => Effect.Effect<void, FSUtil.Error>
  readonly list: (prefix: string[]) => Effect.Effect<string[][], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Storage") {}

function file(dir: string, key: string[]) {
  return path.join(dir, ...key) + ".json"
}

function missing(err: unknown) {
  if (!err || typeof err !== "object") return false
  if ("code" in err && err.code === "ENOENT") return true
  if ("reason" in err && err.reason && typeof err.reason === "object" && "_tag" in err.reason) {
    return err.reason._tag === "NotFound"
  }
  return false
}

function parseMigration(text: string) {
  const value = Number.parseInt(text, 10)
  return Number.isNaN(value) ? 0 : value
}

const MIGRATIONS: Migration[] = [
  Effect.fn("Storage.migration.1")(function* (dir: string, fs: FSUtil.Interface, git: Git.Interface) {
    const project = path.resolve(dir, "../project")
    if (!(yield* fs.isDir(project))) return
    const projectDirs = yield* fs.scan("*", {
      cwd: project,
      include: "all",
    })
    for (const projectDir of projectDirs) {
      const full = path.join(project, projectDir)
      if (!(yield* fs.isDir(full))) continue
      yield* Effect.logInfo(`migrating project ${projectDir}`)
      let projectID = projectDir
      let worktree = "/"

      if (projectID !== "global") {
        for (const msgFile of yield* fs.scan("storage/session/message/*/*.json", {
          cwd: full,
          absolute: true,
        })) {
          const root = decodeRoot(yield* fs.readJson(msgFile), { onExcessProperty: "ignore" }).pipe(
            Option.flatMapNullishOr((json) => json.path?.root),
            Option.filter((value) => value.length > 0),
          )
          if (Option.isNone(root)) continue
          worktree = root.value
          break
        }
        if (!worktree) continue
        if (!(yield* fs.isDir(worktree))) continue
        const result = yield* git.run(["rev-list", "--max-parents=0", "--all"], {
          cwd: worktree,
        })
        const [id] = result
          .text()
          .split("\n")
          .filter(Boolean)
          .map((x) => x.trim())
          .toSorted()
        if (!id) continue
        projectID = id
        const now = yield* Clock.currentTimeMillis

        yield* fs.writeWithDirs(
          path.join(dir, "project", projectID + ".json"),
          yield* jsonText({
            id,
            vcs: "git",
            worktree,
            time: {
              created: now,
              initialized: now,
            },
          }),
        )

        yield* Effect.logInfo(`migrating sessions for project ${projectID}`)
        for (const sessionFile of yield* fs.scan("storage/session/info/*.json", {
          cwd: full,
          absolute: true,
        })) {
          const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
          yield* Effect.logInfo("copying", { sessionFile, dest })
          const session = yield* fs.readJson(sessionFile)
          const info = decodeSession(session, { onExcessProperty: "ignore" })
          yield* fs.writeWithDirs(dest, yield* jsonText(session))
          if (Option.isNone(info)) continue
          yield* Effect.logInfo(`migrating messages for session ${info.value.id}`)
          for (const msgFile of yield* fs.scan(`storage/session/message/${info.value.id}/*.json`, {
            cwd: full,
            absolute: true,
          })) {
            const next = path.join(dir, "message", info.value.id, path.basename(msgFile))
            yield* Effect.logInfo("copying", {
              msgFile,
              dest: next,
            })
            const message = yield* fs.readJson(msgFile)
            const item = decodeMessage(message, { onExcessProperty: "ignore" })
            yield* fs.writeWithDirs(next, yield* jsonText(message))
            if (Option.isNone(item)) continue

            yield* Effect.logInfo(`migrating parts for message ${item.value.id}`)
            for (const partFile of yield* fs.scan(`storage/session/part/${info.value.id}/${item.value.id}/*.json`, {
              cwd: full,
              absolute: true,
            })) {
              const out = path.join(dir, "part", item.value.id, path.basename(partFile))
              const part = yield* fs.readJson(partFile)
              yield* Effect.logInfo("copying", {
                partFile,
                dest: out,
              })
              yield* fs.writeWithDirs(out, yield* jsonText(part))
            }
          }
        }
      }
    }
  }),
  Effect.fn("Storage.migration.2")(function* (dir: string, fs: FSUtil.Interface) {
    for (const item of yield* fs.scan("session/*/*.json", {
      cwd: dir,
      absolute: true,
    })) {
      const raw = yield* fs.readJson(item)
      const session = decodeSummary(raw, { onExcessProperty: "ignore" })
      if (Option.isNone(session)) continue
      const diffs = session.value.summary.diffs
      yield* fs.writeWithDirs(path.join(dir, "session_diff", session.value.id + ".json"), yield* jsonText(diffs))
      yield* fs.writeWithDirs(
        path.join(dir, "session", session.value.projectID, session.value.id + ".json"),
        yield* jsonText({
          ...(raw as Record<string, unknown>),
          summary: {
            additions: diffs.reduce((sum, x) => sum + x.additions, 0),
            deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          },
        }),
      )
    }
  }),
]

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const locks = yield* RcMap.make({
      lookup: () => TxReentrantLock.make(),
      idleTimeToLive: 0,
    })
    const state = yield* Effect.cached(
      Effect.gen(function* () {
        const dir = path.join(Global.Path.data, "storage")
        const marker = path.join(dir, "migration")
        const migration = yield* fs.readFileString(marker).pipe(
          Effect.map(parseMigration),
          Effect.catchIf(missing, () => Effect.succeed(0)),
          Effect.orElseSucceed(() => 0),
        )
        for (let i = migration; i < MIGRATIONS.length; i++) {
          yield* Effect.logInfo("running migration", { index: i })
          const step = MIGRATIONS[i]!
          const exit = yield* Effect.exit(step(dir, fs, git))
          if (Exit.isFailure(exit)) {
            yield* Effect.logError("failed to run migration", { index: i, cause: exit.cause })
            break
          }
          yield* fs.writeWithDirs(marker, String(i + 1))
        }
        return { dir }
      }),
    )

    const fail = (target: string): Effect.Effect<never, NotFoundError> =>
      Effect.fail(new NotFoundError({ message: `Resource not found: ${target}` }))

    const wrap = <A>(target: string, body: Effect.Effect<A, FSUtil.Error>) =>
      body.pipe(Effect.catchIf(missing, () => fail(target)))

    const writeJson = Effect.fnUntraced(function* (target: string, content: unknown) {
      yield* fs.writeWithDirs(target, yield* jsonText(content))
    })

    const withResolved = <A, E>(
      key: string[],
      fn: (target: string, rw: TxReentrantLock.TxReentrantLock) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | FSUtil.Error> =>
      Effect.scoped(
        Effect.gen(function* () {
          const target = file((yield* state).dir, key)
          return yield* fn(target, yield* RcMap.get(locks, target))
        }),
      )

    const remove: Interface["remove"] = Effect.fn("Storage.remove")(function* (key: string[]) {
      yield* withResolved(key, (target, rw) =>
        TxReentrantLock.withWriteLock(rw, fs.remove(target).pipe(Effect.catchIf(missing, () => Effect.void))),
      )
    })

    const read: Interface["read"] = <T>(key: string[]) =>
      Effect.gen(function* () {
        const value = yield* withResolved(key, (target, rw) =>
          TxReentrantLock.withReadLock(rw, wrap(target, fs.readJson(target))),
        )
        return value as T
      })

    const update: Interface["update"] = <T>(key: string[], fn: (draft: T) => void) =>
      Effect.gen(function* () {
        const value = yield* withResolved(key, (target, rw) =>
          TxReentrantLock.withWriteLock(
            rw,
            Effect.gen(function* () {
              const content = yield* wrap(target, fs.readJson(target))
              fn(content as T)
              yield* writeJson(target, content)
              return content
            }),
          ),
        )
        return value as T
      })

    const write: Interface["write"] = (key: string[], content: unknown) =>
      Effect.gen(function* () {
        yield* withResolved(key, (target, rw) => TxReentrantLock.withWriteLock(rw, writeJson(target, content)))
      })

    const list: Interface["list"] = Effect.fn("Storage.list")(function* (prefix: string[]) {
      const dir = (yield* state).dir
      const cwd = path.join(dir, ...prefix)
      const result = yield* fs
        .scan("**/*", {
          cwd,
          include: "file",
        })
        .pipe(Effect.catch(() => Effect.succeed<string[]>([])))
      return result
        .map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)])
        .toSorted((a, b) => a.join("/").localeCompare(b.join("/")))
    })

    return Service.of({
      remove,
      read,
      update,
      write,
      list,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, Git.node] })

export * as Storage from "./storage"
