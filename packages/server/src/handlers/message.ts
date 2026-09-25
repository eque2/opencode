import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { Effect, Encoding, Option, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { errorRef } from "./error-ref"
import { InvalidCursorError, SessionNotFoundError, UnknownError } from "@opencode-ai/protocol/errors"

const DefaultMessagesLimit = 50

const Cursor = Schema.Struct({
  id: SessionMessage.ID,
  order: Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")]),
  direction: Schema.Union([Schema.Literal("previous"), Schema.Literal("next")]),
}).annotate({ identifier: "SessionMessagesCursor" })

const CursorJson = Schema.fromJsonString(Cursor)
const encodeCursorJson = Schema.encodeSync(CursorJson)
const decodeCursorJson = Schema.decodeUnknownEffect(CursorJson)

const cursor = {
  encode(message: SessionMessage.Message, order: "asc" | "desc", direction: "previous" | "next") {
    return Encoding.encodeBase64Url(encodeCursorJson({ id: message.id, order, direction }))
  },
  decode(input: string) {
    return Effect.fromResult(Encoding.decodeBase64UrlString(input)).pipe(
      Effect.flatMap(decodeCursorJson),
      Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
    )
  },
}

export const MessageHandler = HttpApiBuilder.group(Api, "server.message", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service

    return handlers.handle(
      "session.messages",
      Effect.fn(function* (ctx) {
        if (ctx.query.cursor && ctx.query.order !== undefined)
          return yield* new InvalidCursorError({ message: "Cursor cannot be combined with order" })
        const decoded = yield* Option.fromNullishOr(ctx.query.cursor).pipe(
          Option.filter((input) => input !== ""),
          Option.map((input) => cursor.decode(input)),
          Effect.transposeOption,
        )
        const order = Option.match(decoded, {
          onNone: () => ctx.query.order ?? "desc",
          onSome: (value) => value.order,
        })
        const messages = yield* session
          .messages({
            sessionID: ctx.params.sessionID,
            limit: ctx.query.limit ?? DefaultMessagesLimit,
            order,
            ...(Option.isSome(decoded) ? { cursor: { id: decoded.value.id, direction: decoded.value.direction } } : {}),
          })
          .pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.MessageDecodeError", (error) =>
              Effect.flatMap(errorRef, (ref) =>
                Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                ),
              ),
            ),
          )
        const first = messages[0]
        const last = messages.at(-1)
        return {
          data: messages,
          cursor: {
            previous: first ? cursor.encode(first, order, "previous") : undefined,
            next: last ? cursor.encode(last, order, "next") : undefined,
          },
        }
      }),
    )
  }),
)
