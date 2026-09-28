import { Data, DateTime, Option, Random } from "effect"

const prefixes = {
  session: "ses",
  message: "msg",
  permission: "per",
  user: "usr",
  part: "prt",
  pty: "pty",
} as const

const LENGTH = 26
let lastTimestamp = 0
let counter = 0

type Prefix = keyof typeof prefixes

/** A given ID does not start with the prefix of its kind. */
class IdentifierPrefixError extends Data.TaggedError("App.IdentifierPrefixError")<{ readonly message: string }> {}

export namespace Identifier {
  export function ascending(prefix: Prefix, given?: string) {
    return generateID(prefix, false, given)
  }

  export function descending(prefix: Prefix, given?: string) {
    return generateID(prefix, true, given)
  }
}

function generateID(prefix: Prefix, descending: boolean, given?: string): string {
  if (!given) {
    return create(prefix, descending)
  }

  return Option.getOrThrowWith(
    Option.liftPredicate(given, (id) => id.startsWith(prefixes[prefix])),
    () => new IdentifierPrefixError({ message: `ID ${given} does not start with ${prefixes[prefix]}` }),
  )
}

function create(prefix: Prefix, descending: boolean, timestamp?: number): string {
  const currentTimestamp = timestamp ?? DateTime.toEpochMillis(DateTime.nowUnsafe())

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }

  counter += 1

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

  if (descending) {
    now = ~now
  }

  const timeBytes = new Uint8Array(6)
  for (let i = 0; i < 6; i += 1) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }

  return prefixes[prefix] + "_" + bytesToHex(timeBytes) + randomBase62(LENGTH - 12)
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0")
  }
  return hex
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  const bytes = getRandomBytes(length)
  let result = ""
  for (let i = 0; i < length; i += 1) {
    result += chars[bytes[i] % 62]
  }
  return result
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const cryptoObj = Option.fromNullishOr(globalThis.crypto).pipe(
    Option.filter((source) => typeof source.getRandomValues === "function"),
  )

  if (Option.isSome(cryptoObj)) {
    cryptoObj.value.getRandomValues(bytes)
    return bytes
  }

  // Identifier is a synchronous API with no fiber, so the fallback reads the default Random service directly.
  const random = Random.Random.defaultValue()
  for (let i = 0; i < length; i += 1) {
    bytes[i] = Math.floor(random.nextDoubleUnsafe() * 256)
  }

  return bytes
}
