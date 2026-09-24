export * as Event from "./event"

import { MutableHashMap, Option, Result, Schema } from "effect"
import { optional } from "./schema"
import { ascending } from "./identifier"
import { Location } from "./location"
import { statics } from "./schema"

export const ID = Schema.String.check(Schema.isStartsWith("evt_")).pipe(
  Schema.brand("Event.ID"),
  statics((schema) => ({ create: () => schema.make("evt_" + ascending()) })),
)
export type ID = typeof ID.Type

export type Definition<
  Type extends string = string,
  DataSchema extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
> = Schema.Top & {
  readonly type: Type
  readonly durable?: {
    readonly version: number
    readonly aggregate: string
  }
  readonly data: DataSchema
}

export type Data<D extends Definition> = Schema.Schema.Type<D["data"]>

export type Payload<D extends Definition = Definition> = {
  readonly id: ID
  readonly type: D["type"]
  readonly data: Data<D>
  readonly durable?: {
    readonly aggregateID: string
    readonly seq: number
    readonly version: number
  }
  readonly location?: Location.Ref
  readonly metadata?: Record<string, unknown>
}

export function define<
  const Type extends string,
  const Fields extends Readonly<Record<PropertyKey, Schema.Codec<unknown, unknown>>>,
>(input: {
  readonly type: Type
  readonly durable?: {
    readonly version: number
    readonly aggregate: string
  }
  readonly schema: Fields
}) {
  const data = Schema.Struct(input.schema)
  return Schema.Struct({
    id: ID,
    metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
    type: Schema.Literal(input.type),
    durable: optional(Schema.Struct({ aggregateID: Schema.String, seq: Schema.Int, version: Schema.Int })),
    location: optional(Location.Ref),
    data,
  })
    .annotate({ identifier: input.type })
    .pipe(
      statics(() => ({
        type: input.type,
        ...(input.durable === undefined ? {} : { durable: input.durable }),
        data,
      })),
    ) satisfies Definition<Type, typeof data>
}

export function inventory<const Definitions extends ReadonlyArray<Definition>>(...definitions: Definitions) {
  return Object.freeze(definitions)
}

/** Raised when a manifest lists two different definitions for one event key. */
export class DuplicateDefinitionError extends Schema.TaggedError<DuplicateDefinitionError>()(
  "Event.DuplicateDefinition",
  { key: Schema.String, message: Schema.String },
) {}

type Index<Value> = Result.Result<MutableHashMap.MutableHashMap<string, Value>, DuplicateDefinitionError>

export function latest(definitions: ReadonlyArray<Definition>) {
  return definitions
    .reduce<Index<Definition>>(
      (index, definition) =>
        Result.flatMap(index, (result) => {
          const found = MutableHashMap.get(result, definition.type)
          if (Option.isNone(found)) return Result.succeed(MutableHashMap.set(result, definition.type, definition))
          const existing = found.value
          if (definition.durable && existing.durable && definition.durable.version !== existing.durable.version) {
            return Result.succeed(
              definition.durable.version > existing.durable.version
                ? MutableHashMap.set(result, definition.type, definition)
                : result,
            )
          }
          if (definition === existing) return Result.succeed(result)
          return Result.fail(
            new DuplicateDefinitionError({
              key: definition.type,
              message: `Duplicate latest event definition for ${definition.type}`,
            }),
          )
        }),
      Result.succeed(MutableHashMap.empty()),
    )
    .pipe(Result.map(readonlyMap))
}

export function versionedType(type: string, version: number) {
  return `${type}.${version}`
}

export function durable<const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) {
  return definitions
    .reduce<Index<Definitions[number]>>(
      (index, definition) =>
        Result.flatMap(index, (result) => {
          if (!definition.durable) return Result.succeed(result)
          const key = versionedType(definition.type, definition.durable.version)
          if (MutableHashMap.has(result, key)) {
            return Result.fail(
              new DuplicateDefinitionError({ key, message: `Duplicate durable event definition for ${key}` }),
            )
          }
          MutableHashMap.set(result, key, definition)
          return Result.succeed(result)
        }),
      Result.succeed(MutableHashMap.empty()),
    )
    .pipe(Result.map(readonlyMap))
}

// MutableHashMap keeps string keys in insertion order, which the OpenAPI event unions built from
// `values()` depend on. The facade keeps the `ReadonlyMap` contract that callers read.
function readonlyMap<Key, Value>(map: MutableHashMap.MutableHashMap<Key, Value>): ReadonlyMap<Key, Value> {
  const result: ReadonlyMap<Key, Value> = Object.freeze({
    get size() {
      return MutableHashMap.size(map)
    },
    entries: () => Iterator.from(map),
    forEach: (callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown) =>
      MutableHashMap.forEach(map, (value, key) => callback.call(thisArg, value, key, result)),
    get: (key: Key) => Option.getOrUndefined(MutableHashMap.get(map, key)),
    has: (key: Key) => MutableHashMap.has(map, key),
    keys: () => Iterator.from(MutableHashMap.keys(map)),
    values: () => Iterator.from(MutableHashMap.values(map)),
    [Symbol.iterator]: () => Iterator.from(map),
  })
  return result
}
