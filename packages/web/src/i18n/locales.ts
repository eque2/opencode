import { Array, Option } from "effect"

export const docsLocale = [
  "ar",
  "bs",
  "da",
  "de",
  "es",
  "fr",
  "it",
  "ja",
  "ko",
  "nb",
  "pl",
  "pt-br",
  "ru",
  "th",
  "tr",
  "uk",
  "zh-cn",
  "zh-tw",
] as const

export type DocsLocale = (typeof docsLocale)[number]

export const locale = ["root", ...docsLocale] as const

export type Locale = (typeof locale)[number]

export const localeAlias = {
  ar: "ar",
  br: "pt-br",
  bs: "bs",
  da: "da",
  de: "de",
  en: "root",
  es: "es",
  fr: "fr",
  it: "it",
  ja: "ja",
  ko: "ko",
  nb: "nb",
  nn: "nb",
  no: "nb",
  pl: "pl",
  pt: "pt-br",
  "pt-br": "pt-br",
  root: "root",
  ru: "ru",
  th: "th",
  tr: "tr",
  uk: "uk",
  zh: "zh-cn",
  "zh-cn": "zh-cn",
  zht: "zh-tw",
  "zh-tw": "zh-tw",
} as const satisfies Record<string, Locale>

const starts = [
  ["ko", "ko"],
  ["bs", "bs"],
  ["de", "de"],
  ["es", "es"],
  ["fr", "fr"],
  ["it", "it"],
  ["da", "da"],
  ["ja", "ja"],
  ["pl", "pl"],
  ["ru", "ru"],
  ["uk", "uk"],
  ["ar", "ar"],
  ["th", "th"],
  ["tr", "tr"],
  ["en", "root"],
] as const

const decode = Option.liftThrowable(decodeURIComponent)

function isAlias(value: string): value is keyof typeof localeAlias {
  return Object.hasOwn(localeAlias, value)
}

function alias(value: string) {
  return isAlias(value) ? Option.some(localeAlias[value]) : Option.none<Locale>()
}

function parse(input: string) {
  return decode(input).pipe(
    Option.map((decoded) => decoded.trim().toLowerCase()),
    Option.filter((value) => value.length > 0),
  )
}

export function exactLocale(input: string) {
  return parse(input).pipe(Option.flatMap(alias))
}

export function matchLocale(input: string) {
  return parse(input).pipe(Option.flatMap(matchParsed))
}

function matchParsed(value: string): Option.Option<Locale> {
  if (value.startsWith("zh")) {
    if (value.includes("hant") || value.includes("-tw") || value.includes("-hk") || value.includes("-mo")) {
      return Option.some("zh-tw")
    }
    return Option.some("zh-cn")
  }

  const hit = alias(value)
  if (Option.isSome(hit)) return hit

  if (value.startsWith("pt")) return Option.some("pt-br")
  if (value.startsWith("no") || value.startsWith("nb") || value.startsWith("nn")) return Option.some("nb")

  return Array.findFirst(starts, (item) => value.startsWith(item[0])).pipe(Option.map((item) => item[1]))
}
