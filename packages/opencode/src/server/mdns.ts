import { Bonjour } from "bonjour-service"
import { Effect, MutableRef, Option } from "effect"

type Published = { readonly bonjour: Bonjour; readonly port: number }

const current = MutableRef.make(Option.none<Published>())

export const unpublish = Effect.suspend(() =>
  Option.match(MutableRef.getAndSet(current, Option.none()), {
    onNone: () => Effect.void,
    onSome: (published) =>
      Effect.try(() => {
        published.bonjour.unpublishAll()
        published.bonjour.destroy()
      }).pipe(Effect.ignore),
  }),
)

export const publish = Effect.fn("MDNS.publish")(function* (port: number, domain?: string) {
  const published = MutableRef.get(current)
  if (Option.isSome(published) && published.value.port === port) return
  yield* unpublish
  // mDNS is best effort: a failed publish leaves nothing published.
  const bonjour = yield* start(port, domain ?? "opencode.local").pipe(Effect.option)
  MutableRef.set(
    current,
    Option.map(bonjour, (instance) => ({ bonjour: instance, port })),
  )
})

function start(port: number, host: string) {
  return Effect.try(() => new Bonjour()).pipe(
    Effect.flatMap((bonjour) =>
      Effect.try(() => {
        const service = bonjour.publish({
          name: `opencode-${port}`,
          type: "http",
          host,
          port,
          txt: { path: "/" },
        })
        service.on("error", () => {})
      }).pipe(
        Effect.as(bonjour),
        Effect.tapError(() => Effect.try(() => bonjour.destroy()).pipe(Effect.ignore)),
      ),
    ),
  )
}

export * as MDNS from "./mdns"
