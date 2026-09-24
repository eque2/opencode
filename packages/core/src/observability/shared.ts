import { NodeCrypto } from "@effect/platform-node"
import { Crypto, Effect, Option, SynchronizedRef } from "effect"

// One ID per process: the first read draws it from the Crypto service, and every later read returns the same value.
const current = SynchronizedRef.makeUnsafe(Option.none<string>())

/** Short ID of this process run, shared by every log line and the OTEL resource. */
export const runID: Effect.Effect<string> = SynchronizedRef.modifyEffect(current, (stored) =>
  Option.match(stored, {
    onSome: (id) => Effect.succeed([id, stored] as const),
    onNone: () =>
      Effect.flatMap(Crypto.Crypto, (cryptoService) => cryptoService.randomUUIDv4).pipe(
        Effect.map((uuid) => {
          const id = uuid.slice(0, 8)
          return [id, Option.some(id)] as const
        }),
        Effect.provide(NodeCrypto.layer),
        Effect.orDie,
      ),
  }),
)
