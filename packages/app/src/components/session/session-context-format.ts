import { DateTime, Option } from "effect"

// The fields of luxon's DATETIME_MED preset, which this formatter used before, such as "Oct 14, 1983, 9:30 AM".
const DATETIME_MED = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
} as const satisfies Intl.DateTimeFormatOptions

export function createSessionContextFormatter(locale: string) {
  return {
    number(value: number | undefined) {
      if (value === undefined) return "—"
      return value.toLocaleString(locale)
    },
    percent(value: Option.Option<number>) {
      return Option.match(value, {
        onNone: () => "—",
        onSome: (percent) => percent.toLocaleString(locale) + "%",
      })
    },
    time(value: number | undefined) {
      if (!value) return "—"
      // formatLocal uses the system time zone, as luxon's default zone did.
      return Option.match(DateTime.make(value), {
        onNone: () => "—",
        onSome: (time) => DateTime.formatLocal(time, { ...DATETIME_MED, locale }),
      })
    },
  }
}
