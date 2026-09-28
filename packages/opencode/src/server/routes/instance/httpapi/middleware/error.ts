import { NamedError } from "@opencode-ai/core/util/error"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { Cause, Effect, Random } from "effect"
import { HttpRouter, HttpServerError, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http"

// Eight hex digits that tie the client error to its server log line, as the former UUID prefix did.
const errorRef = Random.nextIntBetween(0, 0xffffffff).pipe(Effect.map((n) => `err_${n.toString(16).padStart(8, "0")}`))

// Keep typed HttpApi failures on their declared error path; this boundary only replaces defect-only empty 500s.
export const errorLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const defect = cause.reasons.filter(Cause.isDieReason).find((reason) => {
        if (HttpServerResponse.isHttpServerResponse(reason.defect)) return false
        if (HttpServerError.isHttpServerError(reason.defect)) return false
        if (HttpServerRespondable.isRespondable(reason.defect)) return false
        return true
      })
      if (!defect) return Effect.failCause(cause)

      const error = defect.defect
      if (
        ConfigErrorV1.JsonError.isInstance(error) ||
        ConfigErrorV1.InvalidError.isInstance(error) ||
        ConfigErrorV1.FrontmatterError.isInstance(error) ||
        ConfigErrorV1.DirectoryTypoError.isInstance(error) ||
        ConfigErrorV1.RemoteAuthError.isInstance(error)
      ) {
        return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 400 }))
      }

      return Effect.gen(function* () {
        const ref = yield* errorRef
        yield* Effect.logError("failed", { ref, error, cause: Cause.pretty(cause) })
        return HttpServerResponse.jsonUnsafe(
          new NamedError.Unknown({
            message: "Unexpected server error. Check server logs for details.",
            ref,
          }).toObject(),
          { status: 500 },
        )
      })
    }),
  ),
).layer
