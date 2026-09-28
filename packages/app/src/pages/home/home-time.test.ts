import { describe, expect, test } from "bun:test"
import { DateTime, Option } from "effect"
import { formatRelativeTime, sessionDayOf } from "./home-time"

// The expected text is what luxon `DateTime#toRelative()` rendered for the same pair of times.
const relative = (target: string, base: string, locale = "en-US") =>
  Option.getOrNull(
    formatRelativeTime({
      target: DateTime.toEpochMillis(DateTime.makeUnsafe(target)),
      base: DateTime.makeUnsafe(base),
      zone: DateTime.zoneMakeNamedUnsafe("UTC"),
      locale,
    }),
  )

describe("formatRelativeTime", () => {
  const base = "2024-03-10T12:00:00.000Z"

  test("formats less than one second as zero seconds", () => {
    expect(relative(base, base)).toBe("in 0 seconds")
    expect(relative("2024-03-10T11:59:59.500Z", base)).toBe("0 seconds ago")
  })

  test("uses the largest unit that fits once and truncates the count", () => {
    expect(relative("2024-03-10T11:59:59.000Z", base)).toBe("1 second ago")
    expect(relative("2024-03-10T11:59:01.000Z", base)).toBe("59 seconds ago")
    expect(relative("2024-03-10T10:30:00.000Z", base)).toBe("1 hour ago")
    expect(relative("2024-03-09T12:01:00.000Z", base)).toBe("23 hours ago")
    expect(relative("2024-03-09T12:00:00.000Z", base)).toBe("1 day ago")
    expect(relative("2022-03-10T12:00:00.000Z", "2024-03-10T11:59:00.000Z")).toBe("1 year ago")
  })

  test("counts calendar months and clamps the day to a shorter month", () => {
    expect(relative("2024-01-31T10:00:00.000Z", "2024-02-29T09:00:00.000Z")).toBe("28 days ago")
    expect(relative("2024-01-31T10:00:00.000Z", "2024-02-29T10:00:00.000Z")).toBe("1 month ago")
  })

  test("formats future times and other locales", () => {
    expect(relative("2024-03-13T12:00:00.000Z", base)).toBe("in 3 days")
    expect(relative("2024-03-08T12:00:00.000Z", base, "de")).toBe("vor 2 Tagen")
    expect(relative("2023-01-01T00:00:00.000Z", base, "fr")).toBe("il y a 1 an")
  })

  test("gives no text for a time that is not a valid date", () => {
    const text = formatRelativeTime({
      target: Number.NaN,
      base: DateTime.makeUnsafe(base),
      zone: DateTime.zoneMakeNamedUnsafe("UTC"),
      locale: "en-US",
    })
    expect(Option.isNone(text)).toBe(true)
  })
})

describe("sessionDayOf", () => {
  // Daylight saving time starts in New York at 02:00 on 2024-03-10, so that day has 23 hours.
  const zone = DateTime.zoneMakeNamedUnsafe("America/New_York")
  const dayOf = sessionDayOf(DateTime.makeUnsafe("2024-03-10T16:00:00.000Z"), zone)
  const at = (time: string) => dayOf(DateTime.toEpochMillis(DateTime.makeUnsafe(time)))

  test("compares calendar days in the zone", () => {
    expect(at("2024-03-10T05:30:00.000Z")).toBe("today")
    expect(at("2024-03-11T03:59:00.000Z")).toBe("today")
    expect(at("2024-03-10T04:59:00.000Z")).toBe("yesterday")
    expect(at("2024-03-09T05:00:00.000Z")).toBe("yesterday")
    expect(at("2024-03-09T04:59:00.000Z")).toBe("older")
  })

  test("puts a time that is not a valid date in the older group", () => {
    expect(dayOf(Number.NaN)).toBe("older")
  })
})
