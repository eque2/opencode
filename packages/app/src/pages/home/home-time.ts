import { Array as Arr, DateTime, Option } from "effect"

/** The units that relative time can use, largest first. These are the units of luxon `DateTime#toRelative()`. */
const RELATIVE_UNITS = ["years", "months", "days", "hours", "minutes", "seconds"] as const

type RelativeUnit = (typeof RELATIVE_UNITS)[number]

const ELAPSED_MILLIS = { hours: 3_600_000, minutes: 60_000, seconds: 1_000 } as const

const DAY_MILLIS = 86_400_000

/**
 * Formats an epoch time relative to `base`, with the text of luxon `DateTime#toRelative()`.
 *
 * The text uses the largest unit that fits at least once between the two times. Years, months and days
 * count calendar steps in `zone`. Hours, minutes and seconds count elapsed time. The count is truncated
 * toward zero, and a gap under one second formats as zero seconds. Numbers use `Intl.RelativeTimeFormat`
 * with `numeric: "always"`, as luxon did.
 *
 * The result is none for an epoch time that is not a valid date, where luxon returned null.
 */
export function formatRelativeTime(input: {
  readonly target: number
  readonly base: DateTime.DateTime
  readonly zone: DateTime.TimeZone
  readonly locale: string
}): Option.Option<string> {
  return Option.map(DateTime.make(input.target), (target) => {
    const past = DateTime.isLessThan(target, input.base)
    const earlier = DateTime.setZone(past ? target : input.base, input.zone)
    const later = DateTime.setZone(past ? input.base : target, input.zone)
    const formatter = new Intl.RelativeTimeFormat(input.locale, { numeric: "always", style: "long" })
    return Option.match(
      Arr.findFirst(RELATIVE_UNITS, (unit) => {
        const count = wholeUnits(earlier, later, unit)
        return count >= 1 ? Option.some({ unit, count }) : Option.none()
      }),
      {
        onNone: () => formatter.format(past ? -0 : 0, "seconds"),
        onSome: (step) => formatter.format(past ? -step.count : step.count, step.unit),
      },
    )
  })
}

/** A Home session group, by the calendar day of the session's last update. */
export type SessionDay = "today" | "yesterday" | "older"

/**
 * Returns a function that sorts an epoch time into today, yesterday or older.
 *
 * It compares calendar days in `zone`, as luxon `hasSame(now, "day")` did in the local zone.
 * An epoch time that is not a valid date is older, because luxon matched no day for it.
 */
export function sessionDayOf(now: DateTime.DateTime, zone: DateTime.TimeZone): (epochMillis: number) => SessionDay {
  const today = DateTime.removeTime(DateTime.setZone(now, zone))
  const yesterday = DateTime.subtract(today, { days: 1 })
  return (epochMillis) =>
    Option.match(DateTime.make(epochMillis), {
      onNone: () => "older",
      onSome: (time) => {
        const day = DateTime.removeTime(DateTime.setZone(time, zone))
        if (DateTime.Equivalence(day, today)) return "today"
        if (DateTime.Equivalence(day, yesterday)) return "yesterday"
        return "older"
      },
    })
}

/** The whole units from `earlier` to `later`. `earlier` must not be after `later`. */
function wholeUnits(earlier: DateTime.Zoned, later: DateTime.Zoned, unit: RelativeUnit): number {
  if (unit === "years") return Math.floor(wholeMonths(earlier, later) / 12)
  if (unit === "months") return wholeMonths(earlier, later)
  if (unit === "days") return wholeDays(earlier, later)
  return Math.floor((DateTime.toEpochMillis(later) - DateTime.toEpochMillis(earlier)) / ELAPSED_MILLIS[unit])
}

/**
 * The calendar months from `earlier` to `later`. A month step keeps the wall-clock time and clamps the day
 * to the end of a shorter month, as luxon `plus({ months })` did. Twelve month steps are one year step.
 */
function wholeMonths(earlier: DateTime.Zoned, later: DateTime.Zoned): number {
  const from = DateTime.toParts(earlier)
  const to = DateTime.toParts(later)
  return countBack((to.year - from.year) * 12 + (to.month - from.month), later, (months) =>
    DateTime.add(earlier, { months }),
  )
}

/** The calendar days from `earlier` to `later`. A day step keeps the wall-clock time in the zone. */
function wholeDays(earlier: DateTime.Zoned, later: DateTime.Zoned): number {
  const days = Math.floor(
    (DateTime.toEpochMillis(DateTime.removeTime(later)) - DateTime.toEpochMillis(DateTime.removeTime(earlier))) /
      DAY_MILLIS,
  )
  return countBack(days, later, (count) => DateTime.add(earlier, { days: count }))
}

/**
 * The largest count, at most `estimate`, whose step from the earlier time does not pass `later`.
 * The calendar estimate can be one step high when the day or time of day of `later` comes first.
 */
function countBack(estimate: number, later: DateTime.DateTime, step: (count: number) => DateTime.DateTime): number {
  if (estimate > 0 && DateTime.isGreaterThan(step(estimate), later)) return countBack(estimate - 1, later, step)
  return estimate
}
