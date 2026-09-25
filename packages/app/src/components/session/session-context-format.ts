import { Option } from "effect"
import { DateTime } from "luxon"

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
      return DateTime.fromMillis(value).setLocale(locale).toLocaleString(DateTime.DATETIME_MED)
    },
  }
}
