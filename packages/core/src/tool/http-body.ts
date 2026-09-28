import { Effect, Option, Stream } from "effect"
import { HttpClientResponse } from "effect/unstable/http"

export const collectBoundedResponseBody = <E>(
  response: HttpClientResponse.HttpClientResponse,
  maximumBytes: number,
  tooLarge: () => E,
) =>
  Effect.gen(function* () {
    const declaredSize = Option.fromNullishOr(response.headers["content-length"]).pipe(
      Option.filter((contentLength) => contentLength !== ""),
      Option.map((contentLength) => Number.parseInt(contentLength, 10)),
      Option.filter((size) => Number.isSafeInteger(size) && size >= 0),
    )
    if (Option.isSome(declaredSize) && declaredSize.value > maximumBytes) return yield* Effect.fail(tooLarge())
    const initialSize = declaredSize.pipe(
      Option.filter((size) => size > 0),
      Option.getOrElse(() => 64 * 1024),
    )
    let body = Buffer.allocUnsafe(Math.min(maximumBytes, initialSize))
    let size = 0
    yield* Stream.runForEach(response.stream, (chunk) => {
      if (chunk.byteLength === 0) return Effect.void
      if (size + chunk.byteLength > maximumBytes) return Effect.fail(tooLarge())
      if (size + chunk.byteLength > body.byteLength) {
        const grown = Buffer.allocUnsafe(Math.min(maximumBytes, Math.max(size + chunk.byteLength, body.byteLength * 2)))
        body.copy(grown, 0, 0, size)
        body = grown
      }
      body.set(chunk, size)
      size += chunk.byteLength
      return Effect.void
    })
    return body.subarray(0, size)
  })
