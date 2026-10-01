import { Config, ConfigProvider, Effect, Formatter, Logger, LogLevel, Option, Predicate, Schema } from "effect"
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

const defaultFile = () => path.join(Global.Path.log, "opencode.log")

/**
 * Passes only records at or above `level` to `logger`. The global minimum is the lowest level of any active sink,
 * so each sink filters to its own level.
 */
export function atLevel<Message, Output>(logger: Logger.Logger<Message, Output>, level: LogLevel.LogLevel) {
  return Logger.make<Message, void>((options) => {
    if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, level)) logger.log(options)
  })
}

/** A file logger at `level`. Without an explicit id, each line carries the process run ID. */
export function fileLogger(file = defaultFile(), id?: string, level: LogLevel.LogLevel = "All") {
  return Effect.flatMap(id === undefined ? runID : Effect.succeed(id), (id) =>
    // Do not set batchWindow to 0; it causes high idle CPU usage.
    Logger.toFile(formatter(id), file, { flag: "a" }).pipe(Effect.map((logger) => atLevel(logger, level))),
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

const levels = {
  DEBUG: "Debug",
  INFO: "Info",
  WARN: "Warn",
  ERROR: "Error",
} as const satisfies Record<string, LogLevel.LogLevel>

const logLevelName = Config.String("OPENCODE_LOG_LEVEL").pipe(
  Config.option,
  Config.map(Option.map((value) => value.toUpperCase())),
)

/**
 * The OPENCODE_LOG_LEVEL level, in any case, or Info for a missing or unknown name. The CLI sets the
 * variable in a yargs middleware after startup, so each run reads a fresh env provider. The variable
 * is optional, so a ConfigError is a defect.
 */
export const minimumLogLevel: Effect.Effect<LogLevel.LogLevel> = Effect.suspend(() =>
  logLevelName.parse(ConfigProvider.fromEnv()),
).pipe(
  Effect.orDie,
  Effect.map((name) =>
    name.pipe(
      Option.filter(isLevelName),
      Option.match({ onNone: () => levels.INFO, onSome: (level) => levels[level] }),
    ),
  ),
)

/** The file logger and, with OPENCODE_PRINT_LOGS=1, the stderr logger, both at `level`. */
export function loggers(level: LogLevel.LogLevel) {
  // The CLI sets OPENCODE_PRINT_LOGS after startup and the ambient ConfigProvider copies
  // process.env once, so read it from a fresh env provider when the logger layer builds.
  const printed = printLogs.parse(ConfigProvider.fromEnv()).pipe(
    Effect.orDie,
    Effect.flatMap((print) =>
      print ? Effect.map(runID, (id) => atLevel(stderrLogger(id), level)) : Effect.succeed(silentLogger),
    ),
  )
  return [Effect.flatMap(runID, (id) => fileLogger(defaultFile(), id, level)), printed]
}

export * as Logging from "./logging"
