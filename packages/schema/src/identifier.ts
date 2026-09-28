import { DateTime } from "effect"

const length = 26
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastTimestamp = 0
let counter = 0

export function ascending() {
  return create(false)
}

export function descending() {
  return create(true)
}

export function create(descending: boolean, timestamp = DateTime.toEpochMillis(DateTime.nowUnsafe())) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  // eslint-disable-next-line effect/no-crypto-random-use-random -- (c) Web Crypto getRandomValues is the synchronous CSPRNG that the synchronous ID constructors require; Effect Random is effectful and not cryptographic
  const bytes = crypto.getRandomValues(new Uint8Array(length - 12))
  return time + Array.from(bytes, (byte) => chars[byte % 62]).join("")
}
