import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { formatRelativeTime } from "./relative-time"

// The times sit at noon UTC in months without a daylight-saving change, so the
// local calendar counts are the same in every time zone the tests may run in.
const at = (iso: string) => DateTime.makeUnsafe(iso)
const now = at("2026-07-20T12:00:00Z")

describe("formatRelativeTime", () => {
  test("picks the largest unit with a whole step", () => {
    expect(formatRelativeTime(at("2024-07-20T12:00:00Z"), now, "en-US")).toBe("2 years ago")
    expect(formatRelativeTime(at("2026-05-20T12:00:00Z"), now, "en-US")).toBe("2 months ago")
    expect(formatRelativeTime(at("2026-07-17T12:00:00Z"), now, "en-US")).toBe("3 days ago")
    expect(formatRelativeTime(at("2026-07-20T10:00:00Z"), now, "en-US")).toBe("2 hours ago")
    expect(formatRelativeTime(at("2026-07-20T11:54:01Z"), now, "en-US")).toBe("5 minutes ago")
    expect(formatRelativeTime(at("2026-07-20T11:59:30Z"), now, "en-US")).toBe("30 seconds ago")
  })

  test("truncates a partial unit toward zero", () => {
    expect(formatRelativeTime(at("2026-06-21T12:00:00Z"), now, "en-US")).toBe("29 days ago")
    expect(formatRelativeTime(at("2026-07-19T12:00:01Z"), now, "en-US")).toBe("23 hours ago")
  })

  test("counts months on the calendar and clamps the day of month", () => {
    const end = at("2026-02-28T12:00:00Z")
    expect(formatRelativeTime(at("2026-01-31T12:00:00Z"), end, "en-US")).toBe("1 month ago")
    expect(formatRelativeTime(at("2026-01-31T12:00:01Z"), end, "en-US")).toBe("27 days ago")
  })

  test("formats future times and times under a second", () => {
    expect(formatRelativeTime(at("2026-07-20T14:00:00Z"), now, "en-US")).toBe("in 2 hours")
    expect(formatRelativeTime(now, now, "en-US")).toBe("in 0 seconds")
    expect(formatRelativeTime(at("2026-07-20T11:59:59.500Z"), now, "en-US")).toBe("0 seconds ago")
  })

  test("uses the requested locale", () => {
    expect(formatRelativeTime(at("2026-07-17T12:00:00Z"), now, "de")).toBe("vor 3 Tagen")
    expect(formatRelativeTime(at("2026-07-20T14:00:00Z"), now, "fr")).toBe("dans 2 heures")
  })
})
