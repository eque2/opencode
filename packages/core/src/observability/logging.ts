import { Config, ConfigProvider, Effect, Formatter, Logger, Option, Predicate, Schema, type LogLevel } from "effect"
import { constVoid } from "effect/Function"
import path from "path"
import { Global } from "../global"
import { runID } from "./shared"

function formatter(id: string) {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", id],
      ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ")
  })
}

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length === 0 && prefix) return [[prefix, input]]
  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, path, seen) : [[path, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (!Predicate.isObject(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || Predicate.isNull(prototype)
}

const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String))

function format(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : quote(value)
}

/** A file logger. Without an explicit id, each line carries the process run ID. */
export function fileLogger(file = path.join(Global.Path.log, "opencode.log"), id?: string) {
  return Effect.flatMap(id === undefined ? runID : Effect.succeed(id), (id) =>
    // Do not set batchWindow to 0; it causes high idle CPU usage.
    Logger.toFile(formatter(id), file, { flag: "a" }),
  )
}

const stderrLogger = (id: string) => {
  const lineFormatter = formatter(id)
  return Logger.make((options) => process.stderr.write(lineFormatter.log(options) + "\n"))
}
const silentLogger = Logger.make(constVoid)

const printLogs = Config.String("OPENCODE_PRINT_LOGS").pipe(
  Config.option,
  Config.map((value) => Option.contains(value, "1")),
)

const isLevelName = Schema.is(Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]))

export function minimumLogLevel() {
  const value = process.env.OPENCODE_LOG_LEVEL?.toUpperCase()
  const levels = {
    DEBUG: "Debug",
    INFO: "Info",
    WARN: "Warn",
    ERROR: "Error",
  } as const satisfies Record<string, LogLevel.LogLevel>
  return isLevelName(value) ? levels[value] : levels.INFO
}

export function loggers() {
  // The CLI sets OPENCODE_PRINT_LOGS after startup and the ambient ConfigProvider copies
  // process.env once, so read it from a fresh env provider when the logger layer builds.
  const printed = printLogs.parse(ConfigProvider.fromEnv()).pipe(
    Effect.orDie,
    Effect.flatMap((print) => (print ? Effect.map(runID, stderrLogger) : Effect.succeed(silentLogger))),
  )
  return [fileLogger(), printed]
}

export * as Logging from "./logging"
