import { Crypto, Effect, Layer, PlatformError } from "effect"

/**
 * The Effect Crypto service on Web Crypto, which Cloudflare Workers, Node and Bun all provide.
 * Enterprise runs on Workers, so it cannot use the node:crypto layer from @effect/platform-node.
 */
export namespace WebCrypto {
  // Web Crypto rejects a digest only for an unsupported algorithm or data that is not a buffer.
  // It takes only ArrayBuffer-backed views, so the bytes are copied out of a possibly shared buffer.
  const digest = (algorithm: Crypto.DigestAlgorithm, data: Uint8Array) =>
    Effect.tryPromise({
      try: () => crypto.subtle.digest(algorithm, Uint8Array.from(data)),
      catch: (cause) =>
        PlatformError.badArgument({ module: "Crypto", method: "digest", description: "Could not compute digest", cause }),
    }).pipe(Effect.map((buffer) => new Uint8Array(buffer)))

  export const layer = Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      // eslint-disable-next-line effect/no-crypto-random-use-random -- Crypto.make needs a sync CSPRNG; Web Crypto getRandomValues is the only one on Cloudflare Workers
      randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
      digest,
    }),
  )
}
