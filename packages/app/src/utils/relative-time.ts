import { DateTime } from "effect"

/** The units that luxon's DateTime.toRelative() tries, largest first. */
const units = ["years", "months", "days", "hours", "minutes", "seconds"] as const

type RelativeUnit = (typeof units)[number]
type CalendarUnit = "years" | "months" | "days"

const unitMillis = { hours: 3_600_000, minutes: 60_000, seconds: 1_000 } as const
const dayMillis = 86_400_000

const isCalendarUnit = (unit: RelativeUnit): unit is CalendarUnit =>
  unit === "years" || unit === "months" || unit === "days"

const calendarStep = (unit: CalendarUnit, count: number): Partial<DateTime.DateTime.PartsForMath> => {
  if (unit === "years") return { years: count }
  if (unit === "months") return { months: count }
  return { days: count }
}

/** Whole calendar days between the local dates of two zoned times. */
const dayDiff = (earlier: DateTime.Zoned, later: DateTime.Zoned) =>
  Math.floor(
    (DateTime.toEpochMillis(DateTime.removeTime(later)) - DateTime.toEpochMillis(DateTime.removeTime(earlier))) /
      dayMillis,
  )

/**
 * Whole calendar units from `earlier` to `later` in their time zone.
 *
 * Like luxon, it guesses the count from the date parts, then steps back at
 * most twice while adding the count to `earlier` would pass `later`.
 */
const calendarSteps = (earlier: DateTime.Zoned, later: DateTime.Zoned, unit: CalendarUnit) => {
  const a = DateTime.toParts(earlier)
  const b = DateTime.toParts(later)
  const guess =
    unit === "years"
      ? b.year - a.year
      : unit === "months"
        ? b.month - a.month + (b.year - a.year) * 12
        : dayDiff(earlier, later)
  const end = DateTime.toEpochMillis(later)
  const reaches = (count: number) => DateTime.toEpochMillis(DateTime.add(earlier, calendarStep(unit, count))) <= end
  if (reaches(guess)) return guess
  if (reaches(guess - 1)) return guess - 1
  return guess - 2
}

/** The whole number of `unit` steps from `earlier` to `later`, truncated toward zero. */
const steps = (earlier: DateTime.Zoned, later: DateTime.Zoned, unit: RelativeUnit) => {
  if (isCalendarUnit(unit)) return calendarSteps(earlier, later, unit)
  return Math.trunc((DateTime.toEpochMillis(later) - DateTime.toEpochMillis(earlier)) / unitMillis[unit])
}

/**
 * Formats `time` relative to `now`, such as "3 days ago" or "in 2 hours".
 *
 * It gives the text of luxon's `DateTime.toRelative()`: the largest unit with
 * at least one whole step, calendar units counted in the system time zone,
 * the count truncated toward zero, and Intl.RelativeTimeFormat with
 * `numeric: "always"`. Times less than a second apart give "0 seconds".
 */
export function formatRelativeTime(time: DateTime.DateTime, now: DateTime.DateTime, locale: string): string {
  const zone = DateTime.zoneMakeLocal()
  const target = DateTime.setZone(time, zone)
  const base = DateTime.setZone(now, zone)
  const past = DateTime.toEpochMillis(target) < DateTime.toEpochMillis(base)
  const earlier = past ? target : base
  const later = past ? base : target
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "always" })
  for (const unit of units) {
    const count = steps(earlier, later, unit)
    if (count >= 1) return format.format(past ? -count : count, unit)
  }
  return format.format(past ? -0 : 0, "seconds")
}
