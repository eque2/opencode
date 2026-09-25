import type { APIEvent } from "@solidjs/start/server"
import { Hono } from "hono"
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi"
import { validator } from "hono-openapi"
import { Effect, Option, Result, Schema, SchemaIssue } from "effect"
import { cors } from "hono/cors"
import { Share } from "~/core/share"
import { Resource } from "sst"
import { timingSafeEqual } from "node:crypto"

const ShareResponse = Schema.Struct({
  id: Share.ID,
  url: Schema.String,
  secret: Schema.String,
}).annotate({ identifier: "Share" })

const RemoveShareRequest = Schema.Struct({ shareID: Schema.NonEmptyString }).annotate({
  identifier: "RemoveShareRequest",
})

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

const app = new Hono()

app
  .basePath("/api")
  .use(cors())
  .get(
    "/doc",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Opencode Enterprise API",
          version: "1.0.0",
          description: "Opencode Enterprise API endpoints",
        },
        openapi: "3.1.1",
      },
    }),
  )
  .post(
    "/share",
    describeRoute({
      description: "Create a share",
      operationId: "share.create",
      responses: {
        200: {
          description: "Success",
          content: {
            "application/json": {
              schema: resolver(Schema.toStandardSchemaV1(ShareResponse)),
            },
          },
        },
      },
    }),
    validator("json", Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String }))),
    (c) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const body = c.req.valid("json")
          const share = yield* Share.create({ sessionID: body.sessionID })
          const protocol = c.req.header("x-forwarded-proto") ?? c.req.header("x-forwarded-protocol") ?? "https"
          const host = c.req.header("x-forwarded-host") ?? c.req.header("host")
          return c.json({
            id: share.id,
            secret: share.secret,
            url: `${protocol}://${host}/share/${share.id}`,
          })
        }),
      ),
  )
  .post(
    "/share/:shareID/sync",
    describeRoute({
      description: "Sync share data",
      operationId: "share.sync",
      responses: {
        200: {
          description: "Success",
          content: {
            "application/json": {
              schema: resolver(Schema.toStandardSchemaV1(Schema.Struct({}))),
            },
          },
        },
      },
    }),
    validator("param", Schema.toStandardSchemaV1(Schema.Struct({ shareID: Schema.String }))),
    validator(
      "json",
      Schema.toStandardSchemaV1(Schema.Struct({ secret: Schema.String, data: Schema.Array(Share.Data) })),
    ),
    (c) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { shareID } = c.req.valid("param")
          const body = c.req.valid("json")
          yield* Share.sync({
            share: { id: shareID, secret: body.secret },
            data: body.data,
          })
          return c.json({})
        }),
      ),
  )
  .get(
    "/share/:shareID/data",
    describeRoute({
      description: "Get share data",
      operationId: "share.data",
      responses: {
        200: {
          description: "Success",
          content: {
            "application/json": {
              schema: resolver(Schema.toStandardSchemaV1(Schema.Array(Share.Data))),
            },
          },
        },
      },
    }),
    validator("param", Schema.toStandardSchemaV1(Schema.Struct({ shareID: Schema.String }))),
    (c) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { shareID } = c.req.valid("param")
          c.header("Cache-Control", "public, max-age=30, s-maxage=300, stale-while-revalidate=86400")
          return c.json(yield* Share.data(shareID))
        }),
      ),
  )
  .delete(
    "/share/:shareID",
    describeRoute({
      description: "Remove a share",
      operationId: "share.remove",
      responses: {
        200: {
          description: "Success",
          content: {
            "application/json": {
              schema: resolver(Schema.toStandardSchemaV1(Schema.Struct({}))),
            },
          },
        },
      },
    }),
    validator("param", Schema.toStandardSchemaV1(Schema.Struct({ shareID: Schema.String }))),
    validator("json", Schema.toStandardSchemaV1(Schema.Struct({ secret: Schema.String }))),
    (c) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { shareID } = c.req.valid("param")
          const body = c.req.valid("json")
          yield* Share.remove({ id: shareID, secret: body.secret })
          return c.json({})
        }),
      ),
  )
  .delete("/support/actions/remove-share", (c) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const authorization = c.req.header("authorization")
        const expected = `Bearer ${Resource.SUPPORT_API_KEY.value}`
        const actual = Buffer.from(authorization ?? "")
        const secret = Buffer.from(expected)
        if (actual.length !== secret.length || !timingSafeEqual(actual, secret))
          return c.json({ error: "Unauthorized" }, 401)

        // A body that is not JSON decodes as a missing body, so it gets the same 400 answer.
        const json = yield* Effect.option(Effect.tryPromise(() => c.req.json<unknown>()))
        const body = Schema.decodeUnknownResult(RemoveShareRequest)(Option.getOrUndefined(json))
        if (Result.isFailure(body))
          return c.json({ error: "Invalid request", issues: formatIssues(body.failure.issue).issues }, 400)
        return yield* Share.removeAdmin({ id: body.success.shareID }).pipe(
          Effect.map(() => c.json({ success: true, message: "Share removed" })),
          Effect.catch((error) => Effect.succeed(c.json({ error: error.message }, 400))),
        )
      }),
    ),
  )

export function GET(event: APIEvent) {
  return app.fetch(event.request)
}

export function POST(event: APIEvent) {
  return app.fetch(event.request)
}

export function PUT(event: APIEvent) {
  return app.fetch(event.request)
}

export function DELETE(event: APIEvent) {
  return app.fetch(event.request)
}
