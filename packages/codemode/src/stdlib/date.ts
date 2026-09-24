export const dateMethods = HashSet.make(
  "getTime",
  "valueOf",
  "toISOString",
  "toJSON",
  "toString",
  "getFullYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "getMilliseconds",
  "getUTCFullYear",
  "getUTCMonth",
  "getUTCDate",
  "getUTCDay",
  "getUTCHours",
  "getUTCMinutes",
  "getUTCSeconds",
  "getUTCMilliseconds",
  "getTimezoneOffset",
)

export const dateStatics = HashSet.make("now", "parse", "UTC")

const MS_PER_DAY = 86_400_000
const DAYS_PER_400_YEARS = 146_097

// A time value as the Date constructor clips it: NaN outside the Date range.
const clipTime = (time: number): number =>
  Option.match(DateTime.make(time), { onNone: () => Number.NaN, onSome: DateTime.toEpochMillis })

// Date.UTC(year, monthIndex = 0, day = 1, hours = 0, minutes = 0, seconds = 0, ms = 0): each
// argument truncates to an integer, a year from 0 to 99 means 1900 + year, and the month, day, and
// time fields may overflow into the next unit. A non-finite argument gives NaN.
const utcTime = (args: ReadonlyArray<unknown>): number => {
  const [year = Number.NaN, month = 0, day = 1, hours = 0, minutes = 0, seconds = 0, milliseconds = 0] = args.map(
    (arg) => coerceToNumber(arg),
  )
  const fields = [year, month, day, hours, minutes, seconds, milliseconds]
  if (!fields.every(Number.isFinite)) return Number.NaN
  const [y, m, d, h, min, s, ms] = fields.map((field) => Math.trunc(field))
  const fullYear = y >= 0 && y <= 99 ? 1900 + y : y
  const monthYear = fullYear + Math.floor(m / 12)
  const monthIndex = m - Math.floor(m / 12) * 12
  // The Gregorian calendar repeats every 400 years (146097 days): the month start resolves in a
  // cycle that DateTime holds and shifts back by whole cycles, then the day and time add exactly.
  const cycles = Math.floor((monthYear - 2000) / 400)
  return Option.match(DateTime.make({ year: monthYear - cycles * 400, month: monthIndex + 1, day: 1 }), {
    onNone: () => Number.NaN,
    onSome: (monthStart) => {
      const dayNumber = DateTime.toEpochMillis(monthStart) / MS_PER_DAY + cycles * DAYS_PER_400_YEARS + d - 1
      return clipTime(dayNumber * MS_PER_DAY + (h * 3_600_000 + min * 60_000 + s * 1000 + ms))
    },
  })
}

// The time value of a date string, as sandbox `Date.parse(text)` and `new Date(text)` read it: the
// host parse reads a zone-less date-time or free-form string in the host time zone, and an
// unparseable string gives NaN. DateTime.make reads zone-less strings as UTC, so it cannot stand in.
export const parseTime = (text: string): number =>
  // eslint-disable-next-line effect/no-date-static-use-datetime -- (b) sandbox Date strings follow host Date.parse semantics (local zone for zone-less strings, free-form input), which DateTime.make does not reproduce
  Date.parse(text)

export const invokeDateStatic = (
  name: string,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<number, InterpreterRuntimeError> => {
  switch (name) {
    // Date.now() reads the Effect clock.
    case "now":
      return Clock.currentTimeMillis
    case "parse":
      return Effect.succeed(parseTime(coerceToString(args[0])))
    case "UTC":
      return Effect.succeed(utcTime(args))
    default:
      return Effect.fail(new InterpreterRuntimeError(`Date.${name} is not available in CodeMode.`, node))
  }
}

type DatePart = keyof DateTime.DateTime.PartsWithWeekday

// A part of the time in the host time zone. DateTime.makeZoned takes the host offset at that
// instant, as the local Date getters do; an invalid date has no parts, so the part is NaN.
const localPart = (time: number, part: DatePart): number =>
  Option.match(DateTime.makeZoned(time), { onNone: () => Number.NaN, onSome: (local) => DateTime.getPart(local, part) })

const utcPart = (time: number, part: DatePart): number =>
  Option.match(DateTime.make(time), { onNone: () => Number.NaN, onSome: (utc) => DateTime.getPartUtc(utc, part) })

// getTimezoneOffset is UTC minus local time, in minutes; `0 -` keeps a zero offset at +0.
const timezoneOffset = (time: number): number =>
  Option.match(DateTime.makeZoned(time), {
    onNone: () => Number.NaN,
    onSome: (local) => 0 - DateTime.zonedOffset(local) / 60_000,
  })

export const invokeDateMethod = (
  value: SandboxDate,
  name: string,
  node: AstNode,
): Effect.Effect<unknown, InterpreterRuntimeError> => {
  const time = value.time
  switch (name) {
    case "getTime":
    case "valueOf":
      return Effect.succeed(time)
    case "toISOString":
      return Option.match(DateTime.make(time), {
        onNone: () => Effect.fail(new InterpreterRuntimeError("Invalid time value.", node)),
        onSome: (valid) => Effect.succeed(DateTime.formatIso(valid)),
      })
    // An invalid date has no ISO form: toJSON gives JS null, which Option.getOrNull is at the sandbox edge.
    case "toJSON":
      return Effect.succeed(Option.getOrNull(Option.map(DateTime.make(time), DateTime.formatIso)))
    case "toString":
      return Effect.succeed(coerceToString(value))
    case "getFullYear":
      return Effect.succeed(localPart(time, "year"))
    case "getMonth":
      return Effect.succeed(localPart(time, "month") - 1)
    case "getDate":
      return Effect.succeed(localPart(time, "day"))
    case "getDay":
      return Effect.succeed(localPart(time, "weekDay"))
    case "getHours":
      return Effect.succeed(localPart(time, "hour"))
    case "getMinutes":
      return Effect.succeed(localPart(time, "minute"))
    case "getSeconds":
      return Effect.succeed(localPart(time, "second"))
    case "getMilliseconds":
      return Effect.succeed(localPart(time, "millisecond"))
    case "getUTCFullYear":
      return Effect.succeed(utcPart(time, "year"))
    case "getUTCMonth":
      return Effect.succeed(utcPart(time, "month") - 1)
    case "getUTCDate":
      return Effect.succeed(utcPart(time, "day"))
    case "getUTCDay":
      return Effect.succeed(utcPart(time, "weekDay"))
    case "getUTCHours":
      return Effect.succeed(utcPart(time, "hour"))
    case "getUTCMinutes":
      return Effect.succeed(utcPart(time, "minute"))
    case "getUTCSeconds":
      return Effect.succeed(utcPart(time, "second"))
    case "getUTCMilliseconds":
      return Effect.succeed(utcPart(time, "millisecond"))
    case "getTimezoneOffset":
      return Effect.succeed(timezoneOffset(time))
    default:
      return Effect.fail(new InterpreterRuntimeError(`Date method '${name}' is not available in CodeMode.`, node))
  }
}
import { Clock, DateTime, Effect, HashSet, Option } from "effect"
import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js"
import { SandboxDate } from "../values.js"
import { coerceToNumber, coerceToString } from "./value.js"
