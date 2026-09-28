import { MainLogger } from "electron-log"
import log from "electron-log/main.js"
import { app, crashReporter, netLog, shell } from "electron"
import { ZipWriter, BlobWriter, BlobReader } from "@zip.js/zip.js"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { NodeFileSystem } from "@effect/platform-node"
import { Array as Arr, Config, Data, DateTime, Effect, FileSystem, Option, Predicate, Result, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"

const MAX_LOG_AGE_DAYS = 7
const TAIL_LINES = 1000
const EXPORT_WINDOW = 24 * 60 * 60 * 1000
const MAX_EXPORT_FILE_SIZE = 50 * 1024 * 1024
const NET_LOG_SIZE = 20 * 1024 * 1024

class LoggingError extends Data.TaggedError("LoggingError")<{ readonly message: string; readonly cause: unknown }> {}

const loggingError = (cause: unknown) =>
  new LoggingError({ message: cause instanceof Error ? cause.message : String(cause), cause })

const encodeManifest = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

let root = ""
let run = ""
let netLogPath: string | undefined

let logger: MainLogger
export const getLogger = () => logger

// Creates the run folder before electron-log writes to it. A filesystem failure stops startup, as the thrown error did.
export const initLogging = Effect.gen(function* () {
  yield* initRunDirectory
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.file.resolvePathFn = (_vars, message) =>
    join(
      run,
      `${safeLogName(message?.scope ?? (message?.variables?.processType === "renderer" ? "renderer" : "main"))}.log`,
    )
  log.initialize({ preload: false, spyRendererConsole: true })
  initConsoleTransport()
  yield* cleanup
  logger = log
  return log
})

export const initCrashReporter = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = join(app.getPath("userData"), "Crashpad")
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)
  app.setPath("crashDumps", dir)
  crashReporter.start({ uploadToServer: false, compress: true })
  write("crash", "crash reporter started", { path: dir })
})

const startNetLogging = Effect.gen(function* () {
  if (netLog.currentlyLogging) return
  const path = join(run, "network.netlog")
  netLogPath = path
  yield* Effect.tryPromise({
    try: () => netLog.startLogging(path, { captureMode: "default", maxFileSize: NET_LOG_SIZE }),
    catch: loggingError,
  })
  write("network", "net log started", { path })
})

export function startNetLog() {
  return Effect.runPromise(startNetLogging)
}

export function exportDebugLogs() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const restartNetLog = netLog.currentlyLogging
      if (restartNetLog) {
        yield* Effect.tryPromise({ try: () => netLog.stopLogging(), catch: loggingError }).pipe(
          Effect.catch((error) => Effect.sync(() => write("network", "failed to stop net log", { error: error.cause }))),
        )
      }

      const now = yield* DateTime.now
      const output = join(app.getPath("downloads"), `opencode-debug-${stamp(now)}.zip`)
      return yield* Effect.gen(function* () {
        write("main", "exporting debug logs", { output })
        const serverLogs = yield* serverLogRoots
        const cutoff = DateTime.toEpochMillis(now) - EXPORT_WINDOW
        const manifestJson = yield* encodeManifest(manifest(now, serverLogs))
        const serverEntries = yield* Effect.forEach(serverLogs, (dir, i) => collect(dir, `server-${i + 1}`, cutoff))
        yield* writeZip(output, [
          { name: "manifest.json", data: Buffer.from(manifestJson) },
          ...(yield* collect(root, "desktop", cutoff)),
          ...serverEntries.flat(),
          ...(yield* collect(app.getPath("crashDumps"), "crashpad", cutoff)),
        ])
        shell.showItemInFolder(output)
        return output
      }).pipe(
        Effect.ensuring(
          restartNetLog
            ? startNetLogging.pipe(
                Effect.catch((error) =>
                  Effect.sync(() => write("network", "failed to restart net log", { error: error.cause })),
                ),
              )
            : Effect.void,
        ),
      )
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  )
}

export function write(
  name: string,
  message: string,
  extra?: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
) {
  if (extra === undefined) return writeMessage(name, message, level)
  if (!run) return
  log.scope(safeLogName(name))[level](message, extra)
}

// Writes a scoped line without the structured extra argument.
export function writeMessage(name: string, message: string, level: "info" | "warn" | "error" = "info") {
  if (!run) return
  log.scope(safeLogName(name))[level](message)
}

// Reads the last lines of the current log file. An unreadable file gives an empty string.
export const tail = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(log.transports.file.getFile().path, "utf8").pipe(
    Effect.map((contents) => {
      const lines = contents.split("\n")
      return lines.slice(Math.max(0, lines.length - TAIL_LINES)).join("\n")
    }),
    Effect.orElseSucceed(() => ""),
  )
})

const initRunDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  root = join(app.getPath("userData"), "logs")
  run = join(root, stamp(yield* DateTime.now))
  yield* fs.makeDirectory(run, { recursive: true }).pipe(Effect.orDie)
})

function stamp(now: DateTime.DateTime) {
  return DateTime.formatIso(now)
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
}

function safeLogName(name: string) {
  return name.replace(/[^a-z0-9_.-]/gi, "_") || "main"
}

const cleanup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = root || dirname(log.transports.file.getFile().path)
  const cutoff = DateTime.toEpochMillis(yield* DateTime.now) - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000

  // A file that disappears or cannot be removed is skipped; cleanup is best effort.
  // A folder that cannot be listed stops startup, as the thrown error did.
  const entries = yield* fs.readDirectory(dir).pipe(Effect.orDie)
  yield* Effect.forEach(
    entries,
    (entry) => {
      const file = join(dir, entry)
      return fs.stat(file).pipe(
        Effect.flatMap((info) =>
          modifiedBefore(info, cutoff) ? fs.remove(file, { recursive: true, force: true }) : Effect.void,
        ),
        Effect.ignore,
      )
    },
    { discard: true },
  )
})

// Node.js always reports mtime, so a missing value only comes from another backend and never counts as old.
const modifiedBefore = (info: FileSystem.File.Info, cutoff: number) =>
  Option.exists(info.mtime, (mtime) => mtime.getTime() < cutoff)

function manifest(now: DateTime.DateTime, serverLogs: ReadonlyArray<string>) {
  return {
    generated: DateTime.formatIso(now),
    version: app.getVersion(),
    name: app.getName(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
    uptime: process.uptime(),
    userData: app.getPath("userData"),
    logs: root,
    currentRun: run,
    crashDumps: app.getPath("crashDumps"),
    serverLogs,
    netLog: netLogPath,
  }
}

const serverLogRoots = Effect.gen(function* () {
  // An empty XDG_DATA_HOME falls back to the default, as the XDG spec requires.
  const xdgData = Option.filter(yield* Config.option(Config.String("XDG_DATA_HOME")), (value) => value.length > 0)
  const dataHome = Option.getOrElse(xdgData, () => join(homedir(), ".local", "share"))
  return Arr.dedupe([join(dataHome, "opencode", "log"), join(app.getPath("userData"), "opencode", "log")])
})

type Entry = { name: string; data: Buffer } | { name: string; path: string }

const collect = Effect.fnUntraced(function* (dir: string, prefix: string, cutoff: number) {
  const fs = yield* FileSystem.FileSystem
  // existsSync reported an unreadable path as absent, so an error also counts as absent.
  if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) return []
  const walk = (current: string): Effect.Effect<Entry[], LoggingError> =>
    fs.readDirectory(current).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries, (entry) => {
          const file = join(current, entry)
          return fs.stat(file).pipe(
            Effect.flatMap((info): Effect.Effect<Entry[], LoggingError | PlatformError> => {
              if (info.type === "Directory") return walk(file)
              if (modifiedBefore(info, cutoff)) return Effect.succeed([])
              if (Number(info.size) > MAX_EXPORT_FILE_SIZE) return Effect.succeed([])
              if (file.endsWith(".heapsnapshot")) return Effect.succeed([])
              return Effect.succeed([{ name: join(prefix, file.slice(dir.length + 1)).replace(/\\/g, "/"), path: file }])
            }),
          )
        }),
      ),
      Effect.map((nested) => nested.flat()),
      Effect.mapError((error) => (error instanceof LoggingError ? error : loggingError(error.cause ?? error))),
    )
  return yield* walk(dir)
})

const writeZip = Effect.fnUntraced(function* (output: string, entries: Entry[]) {
  const fs = yield* FileSystem.FileSystem
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  yield* Effect.forEach(
    entries,
    (entry) =>
      ("data" in entry
        ? Effect.succeed<Uint8Array>(entry.data)
        : fs.readFile(entry.path).pipe(Effect.mapError((error) => loggingError(error.cause ?? error)))
      ).pipe(
        Effect.flatMap((data) =>
          Effect.tryPromise({
            try: () => writer.add(entry.name, new BlobReader(new Blob([new Uint8Array(data)]))),
            catch: loggingError,
          }),
        ),
      ),
    { discard: true },
  )
  const zip = yield* Effect.tryPromise({ try: () => writer.close(), catch: loggingError })
  const bytes = yield* Effect.tryPromise({ try: () => zip.arrayBuffer(), catch: loggingError })
  yield* fs.writeFile(output, new Uint8Array(bytes)).pipe(Effect.mapError((error) => loggingError(error.cause ?? error)))
})

function initConsoleTransport() {
  if (app.isPackaged) {
    log.transports.console.level = false
    return
  }

  const writeConsole = log.transports.console.writeFn.bind(log.transports.console)
  log.transports.console.writeFn = (options) => {
    const result = Result.try(() => writeConsole(options))
    if (Result.isFailure(result) && isBrokenPipe(result.failure)) {
      log.transports.console.level = false
      return
    }
    // electron-log calls writeFn synchronously and handles a thrown error,
    // so any other failure goes back to it unchanged.
    Result.getOrThrow(result)
  }
}

function isBrokenPipe(err: unknown) {
  return Predicate.hasProperty(err, "code") && err.code === "EPIPE"
}
