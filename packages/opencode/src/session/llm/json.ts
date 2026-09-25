import { Option, Predicate, Record, Schema } from "effect"

const isJsonObject = Schema.is(Schema.JsonObject)
const encodeJsonText = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeJsonObjectText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject))

/**
 * The JSON object that a provider receives for `value`. A JSON object stays as it is. Another object goes through
 * JSON encoding, as the request encoder does: undefined-valued keys drop out and Dates become ISO strings. A value
 * that is not an object, or that has no JSON object form, is none.
 */
export const toJsonObject = (value: unknown): Option.Option<Schema.JsonObject> => {
  if (isJsonObject(value)) return Option.some(value)
  if (!Predicate.isObject(value)) return Option.none()
  return Option.flatMap(encodeJsonText(value), decodeJsonObjectText)
}

/**
 * The entries of a provider-keyed record (provider metadata or provider options) in their JSON object form. An
 * entry with no JSON object form drops out.
 */
export const objectEntries = (
  value: Record.ReadonlyRecord<string, unknown>,
): Record.ReadonlyRecord<string, Schema.JsonObject> => Record.getSomes(Record.map(value, toJsonObject))

export * as LLMJson from "./json"
