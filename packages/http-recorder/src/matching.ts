import { Array as Arr, Option, Predicate, Schema } from "effect"
import { REDACTED, secretFindings } from "./redaction.js"
import type { HttpInteraction, RequestMatcher, RequestSnapshot } from "./types.js"

const JsonValue = Schema.fromJsonString(Schema.Unknown)
export const decodeJson = Schema.decodeUnknownOption(JsonValue)
export const encodeJson = Schema.encodeSync(JsonValue)
const encodeJsonOption = Schema.encodeUnknownOption(JsonValue)

export const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonicalizeJson(value[key])]),
    )
  }
  return value
}

export type { RequestMatcher } from "./types.js"

export const canonicalSnapshot = (snapshot: RequestSnapshot): string =>
  encodeJson({
    method: snapshot.method,
    url: snapshot.url,
    headers: canonicalizeJson(snapshot.headers),
    body: Option.match(decodeJson(snapshot.body), {
      onNone: () => snapshot.body,
      onSome: canonicalizeJson,
    }),
  })

export const defaultMatcher: RequestMatcher = (incoming, recorded) =>
  canonicalSnapshot(incoming) === canonicalSnapshot(recorded)

export const safeText = (value: unknown) => {
  if (value === undefined) return "undefined"
  if (secretFindings(value).length > 0) return encodeJson(REDACTED)
  return Option.match(encodeJsonOption(value), {
    onNone: () => typeof value,
    onSome: (text) => (text.length > 300 ? `${text.slice(0, 300)}...` : text),
  })
}

const jsonBody = (body: string) => Option.getOrUndefined(decodeJson(body))

const valueDiffs = (expected: unknown, received: unknown, base = "$", limit = 8): ReadonlyArray<string> => {
  if (Object.is(expected, received)) return []
  if (Predicate.isObject(expected) && Predicate.isObject(received)) {
    return Arr.dedupe([...Object.keys(expected), ...Object.keys(received)])
      .toSorted()
      .flatMap((key) => valueDiffs(expected[key], received[key], `${base}.${key}`, limit))
      .slice(0, limit)
  }
  if (Array.isArray(expected) && Array.isArray(received)) {
    return Array.from({ length: Math.max(expected.length, received.length) }, (_, index) => index)
      .flatMap((index) => valueDiffs(expected[index], received[index], `${base}[${index}]`, limit))
      .slice(0, limit)
  }
  return [`${base} expected ${safeText(expected)}, received ${safeText(received)}`]
}

const headerDiffs = (expected: Record<string, string>, received: Record<string, string>) =>
  Arr.dedupe([...Object.keys(expected), ...Object.keys(received)])
    .toSorted()
    .flatMap((key) => {
      if (expected[key] === received[key]) return []
      if (expected[key] === undefined) return [`  ${key} unexpected ${safeText(received[key])}`]
      if (received[key] === undefined) return [`  ${key} missing expected ${safeText(expected[key])}`]
      return [`  ${key} expected ${safeText(expected[key])}, received ${safeText(received[key])}`]
    })

export const requestDiff = (expected: RequestSnapshot, received: RequestSnapshot): ReadonlyArray<string> => {
  const headers = headerDiffs(expected.headers, received.headers)
  const expectedBody = jsonBody(expected.body)
  const receivedBody = jsonBody(received.body)
  const body =
    expectedBody !== undefined && receivedBody !== undefined
      ? valueDiffs(expectedBody, receivedBody).map((line) => `  ${line}`)
      : expected.body === received.body
        ? []
        : [`  expected ${safeText(expected.body)}, received ${safeText(received.body)}`]
  return [
    ...(expected.method !== received.method
      ? ["method:", `  expected ${expected.method}, received ${received.method}`]
      : []),
    ...(expected.url !== received.url ? ["url:", `  expected ${expected.url}`, `  received ${received.url}`] : []),
    ...(headers.length > 0 ? ["headers:", ...headers.slice(0, 8)] : []),
    ...(body.length > 0 ? ["body:", ...body] : []),
  ]
}

export const selectSequential = (
  interactions: ReadonlyArray<HttpInteraction>,
  incoming: RequestSnapshot,
  match: RequestMatcher,
  index: number,
): { readonly interaction: Option.Option<HttpInteraction>; readonly detail: string } =>
  Option.match(Arr.get(interactions, index), {
    onNone: () => ({
      interaction: Option.none(),
      detail: `interaction ${index + 1} of ${interactions.length} not recorded`,
    }),
    onSome: (interaction) =>
      match(incoming, interaction.request)
        ? { interaction: Option.some(interaction), detail: "" }
        : { interaction: Option.none(), detail: requestDiff(interaction.request, incoming).join("\n") },
  })
