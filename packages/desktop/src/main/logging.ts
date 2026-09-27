import { MainLogger } from "electron-log"
import log from "electron-log/main.js"
import { app, crashReporter, netLog, shell } from "electron"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { ZipWriter, BlobWriter, BlobReader } from "@zip.js/zip.js"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { Array as Arr, Config, Data, DateTime, Effect, Option, Predicate, Result, Schema } from "effect"

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

export function initLogging() {
  initRunDirectory()
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.file.resolvePathFn = (_vars, message) =>
    join(
      run,
      `${safeLogName(message?.scope ?? (message?.variables?.processType === "renderer" ? "renderer" : "main"))}.log`,
    )
  log.initialize({ preload: false, spyRendererConsole: true })
  initConsoleTransport()
  cleanup()
  return (logger = log)
}

export function initCrashReporter() {
  const dir = join(app.getPath("userData"), "Crashpad")
  mkdirSync(dir, { recursive: true })
  app.setPath("crashDumps", dir)
  crashReporter.start({ uploadToServer: false, compress: true })
  write("crash", "crash reporter started", { path: dir })
}

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
        yield* writeZip(output, [
          { name: "manifest.json", data: Buffer.from(manifestJson) },
          ...collect(root, "desktop", cutoff),
          ...serverLogs.flatMap((dir, i) => collect(dir, `server-${i + 1}`, cutoff)),
          ...collect(app.getPath("crashDumps"), "crashpad", cutoff),
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
    }),
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

export function tail(): string {
  return Result.try(() => readFileSync(log.transports.file.getFile().path, "utf8")).pipe(
    Result.map((contents) => {
      const lines = contents.split("\n")
      return lines.slice(Math.max(0, lines.length - TAIL_LINES)).join("\n")
    }),
    Result.getOrElse(() => ""),
  )
}

function initRunDirectory() {
  root = join(app.getPath("userData"), "logs")
  run = join(root, stamp(DateTime.nowUnsafe()))
  mkdirSync(run, { recursive: true })
}

function stamp(now: DateTime.DateTime) {
  return DateTime.formatIso(now)
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
}

function safeLogName(name: string) {
  return name.replace(/[^a-z0-9_.-]/gi, "_") || "main"
}

function cleanup() {
  const dir = root || dirname(log.transports.file.getFile().path)
  const cutoff = DateTime.toEpochMillis(DateTime.nowUnsafe()) - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000

  // A file that disappears or cannot be removed is skipped; cleanup is best effort.
  readdirSync(dir).forEach((entry) => {
    const file = join(dir, entry)
    Result.try(() => {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { recursive: true, force: true })
    })
  })
}

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

function collect(dir: string, prefix: string, cutoff: number): Entry[] {
  if (!existsSync(dir)) return []
  const walk = (current: string): Entry[] =>
    readdirSync(current).flatMap((entry): Entry[] => {
      const file = join(current, entry)
      const info = statSync(file)
      if (info.isDirectory()) return walk(file)
      if (info.mtimeMs < cutoff) return []
      if (info.size > MAX_EXPORT_FILE_SIZE) return []
      if (file.endsWith(".heapsnapshot")) return []
      return [{ name: join(prefix, file.slice(dir.length + 1)).replace(/\\/g, "/"), path: file }]
    })
  return walk(dir)
}

const writeZip = Effect.fnUntraced(function* (output: string, entries: Entry[]) {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  yield* Effect.forEach(
    entries,
    (entry) =>
      Effect.try({ try: () => ("data" in entry ? entry.data : readFileSync(entry.path)), catch: loggingError }).pipe(
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
  yield* Effect.try({ try: () => writeFileSync(output, Buffer.from(bytes)), catch: loggingError })
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
