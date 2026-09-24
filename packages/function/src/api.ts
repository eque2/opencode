import { Hono } from "hono"
import { DurableObject } from "cloudflare:workers"
import { randomUUID } from "node:crypto"
import { jwtVerify, createRemoteJWKSet } from "jose"
import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"
import { Resource } from "sst"
import { Effect, Option, Result, Schema } from "effect"
import { parseRepositoryClaim } from "./github"

type Env = {
  SYNC_SERVER: DurableObjectNamespace<SyncServer>
  Bucket: R2Bucket
  WEB_DOMAIN: string
}

class InvalidSecretError extends Schema.TaggedError<InvalidSecretError>()("InvalidSecretError", {
  message: Schema.String,
}) {}

class PatAuthorizationError extends Schema.TaggedError<PatAuthorizationError>()("PatAuthorizationError", {
  message: Schema.String,
}) {}

/** A GitHub OIDC, App auth, or REST call failed; `cause` is the original error. */
class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  cause: Schema.Defect(),
}) {}

const githubRequest = <A>(request: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: request, catch: (cause) => new GitHubError({ cause }) })

// createAppAuth validates its options and throws synchronously when one is missing.
const githubAppAuth = Effect.try({
  try: () =>
    createAppAuth({
      appId: Resource.GITHUB_APP_ID.value,
      privateKey: Resource.GITHUB_APP_PRIVATE_KEY.value,
    }),
  catch: (cause) => new GitHubError({ cause }),
})

/** A `{ key, content }` share update, as sent to WebSocket subscribers. */
const SyncFrame = Schema.Struct({
  key: Schema.String,
  content: Schema.Json,
}).annotate({ identifier: "SyncFrame" })

const SyncFrameJson = Schema.fromJsonString(SyncFrame)

const JsonText = Schema.fromJsonString(Schema.Json)

const DiscordMessageJson = Schema.fromJsonString(Schema.Struct({ content: Schema.String }))

/** The fields of a Feishu event callback that the support bridge reads. */
const FeishuEvent = Schema.Struct({
  challenge: Schema.optional(Schema.String),
  event: Schema.optional(
    Schema.Struct({
      message: Schema.optional(
        Schema.Struct({
          message_id: Schema.optional(Schema.String.pipe(Schema.brand("FeishuMessageId"))),
          root_id: Schema.optional(Schema.String.pipe(Schema.brand("FeishuMessageId"))),
          content: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
}).annotate({ identifier: "FeishuEvent" })

/** The JSON a Feishu text message carries in `content`. */
const FeishuText = Schema.Struct({
  text: Schema.String,
}).annotate({ identifier: "FeishuText" })

export class SyncServer extends DurableObject<Env> {
  // oxlint-disable-next-line no-useless-constructor
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }
  fetch() {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* Effect.logInfo("SyncServer subscribe")

        const webSocketPair = new WebSocketPair()
        const [client, server] = Object.values(webSocketPair)

        this.ctx.acceptWebSocket(server)

        const data = yield* Effect.tryPromise(() => this.ctx.storage.list())
        yield* Effect.forEach(
          Array.from(data.entries()).filter(([key, _]) => key.startsWith("session/")),
          ([key, content]) =>
            Schema.encodeUnknownEffect(SyncFrameJson)({ key, content }).pipe(Effect.map((frame) => server.send(frame))),
          { discard: true },
        )

        // eslint-disable-next-line effect/no-null-use-option -- Workers Response constructor requires a null body for a 101 WebSocket upgrade (webSocket init)
        return new Response(null, {
          status: 101,
          webSocket: client,
        })
      }),
    )
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {}

  webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean) {
    ws.close(code, "Durable Object is closing WebSocket")
  }

  publish(key: string, content: unknown) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const sessionID = yield* this.getSessionID()
        if (
          !key.startsWith(`session/info/${sessionID}`) &&
          !key.startsWith(`session/message/${sessionID}/`) &&
          !key.startsWith(`session/part/${sessionID}/`)
        )
          return new Response("Error: Invalid key", { status: 400 })

        // store message
        const json = yield* Schema.encodeUnknownEffect(JsonText)(content)
        yield* Effect.tryPromise(() =>
          this.env.Bucket.put(`share/${key}.json`, json, {
            httpMetadata: {
              contentType: "application/json",
            },
          }),
        )
        yield* Effect.tryPromise(() => this.ctx.storage.put(key, content))
        const clients = this.ctx.getWebSockets()
        yield* Effect.logInfo("SyncServer publish", key, "to", clients.length, "subscribers")
        const frame = yield* Schema.encodeUnknownEffect(SyncFrameJson)({ key, content })
        for (const client of clients) {
          client.send(frame)
        }
        return undefined
      }),
    )
  }

  public share(sessionID: string) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const existing = yield* this.getSecret()
        if (existing) return existing
        const secret = randomUUID()

        yield* Effect.tryPromise(() => this.ctx.storage.put("secret", secret))
        yield* Effect.tryPromise(() => this.ctx.storage.put("sessionID", sessionID))

        return secret
      }),
    )
  }

  public getData() {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const data = (yield* Effect.tryPromise(() => this.ctx.storage.list())) as Map<string, any>
        return Array.from(data.entries())
          .filter(([key, _]) => key.startsWith("session/"))
          .map(([key, content]) => ({ key, content }))
      }),
    )
  }

  public assertSecret(secret: string) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        if (secret !== (yield* this.getSecret())) yield* new InvalidSecretError({ message: "Invalid secret" })
      }),
    )
  }

  private getSecret() {
    return Effect.tryPromise(() => this.ctx.storage.get<string>("secret"))
  }

  private getSessionID() {
    return Effect.tryPromise(() => this.ctx.storage.get<string>("sessionID"))
  }

  clear() {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const sessionID = yield* this.getSessionID()
        const list = yield* Effect.tryPromise(() =>
          this.env.Bucket.list({
            prefix: `session/message/${sessionID}/`,
            limit: 1000,
          }),
        )
        yield* Effect.forEach(list.objects, (item) => Effect.tryPromise(() => this.env.Bucket.delete(item.key)), {
          discard: true,
        })
        yield* Effect.tryPromise(() => this.env.Bucket.delete(`session/info/${sessionID}`))
        yield* Effect.tryPromise(() => this.ctx.storage.deleteAll())
      }),
    )
  }

  static shortName(id: string) {
    return id.substring(id.length - 8)
  }
}

export default new Hono<{ Bindings: Env }>()
  .get("/", (c) => c.text("Hello, world!"))
  .post("/share_create", (c) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* Effect.tryPromise(() => c.req.json<{ sessionID: string }>())
        const sessionID = body.sessionID
        const short = SyncServer.shortName(sessionID)
        const id = c.env.SYNC_SERVER.idFromName(short)
        const stub = c.env.SYNC_SERVER.get(id)
        const secret = yield* Effect.tryPromise(() => stub.share(sessionID))
        return c.json({
          secret,
          url: `https://${c.env.WEB_DOMAIN}/s/${short}`,
        })
      }),
    ),
  )
  .post("/share_delete", (c) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* Effect.tryPromise(() => c.req.json<{ sessionID: string; secret: string }>())
        const sessionID = body.sessionID
        const secret = body.secret
        const id = c.env.SYNC_SERVER.idFromName(SyncServer.shortName(sessionID))
        const stub = c.env.SYNC_SERVER.get(id)
        yield* Effect.tryPromise(() => stub.assertSecret(secret))
        yield* Effect.tryPromise(() => stub.clear())
        return c.json({})
      }),
    ),
  )
  .post("/share_delete_admin", (c) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* Effect.tryPromise(() => c.req.json<{ sessionShortName: string; adminSecret: string }>())
        const sessionShortName = body.sessionShortName
        const adminSecret = body.adminSecret
        if (adminSecret !== Resource.ADMIN_SECRET.value)
          return yield* new InvalidSecretError({ message: "Invalid admin secret" })
        const id = c.env.SYNC_SERVER.idFromName(sessionShortName)
        const stub = c.env.SYNC_SERVER.get(id)
        yield* Effect.tryPromise(() => stub.clear())
        return c.json({})
      }),
    ),
  )
  .post("/share_sync", (c) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* Effect.tryPromise(() =>
          c.req.json<{
            sessionID: string
            secret: string
            key: string
            content: any
          }>(),
        )
        const name = SyncServer.shortName(body.sessionID)
        const id = c.env.SYNC_SERVER.idFromName(name)
        const stub = c.env.SYNC_SERVER.get(id)
        yield* Effect.tryPromise(() => stub.assertSecret(body.secret))
        yield* Effect.tryPromise(() => stub.publish(body.key, body.content))
        return c.json({})
      }),
    ),
  )
  .get("/share_poll", (c) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const upgradeHeader = c.req.header("Upgrade")
        if (!upgradeHeader || upgradeHeader !== "websocket") {
          return c.text("Error: Upgrade header is required", { status: 426 })
        }
        const id = c.req.query("id")
        yield* Effect.logInfo("share_poll", id)
        if (!id) return c.text("Error: Share ID is required", { status: 400 })
        const stub = c.env.SYNC_SERVER.get(c.env.SYNC_SERVER.idFromName(id))
        return yield* Effect.tryPromise(() => stub.fetch(c.req.raw))
      }),
    ),
  )
  .get("/share_data", (c) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const id = c.req.query("id")
        yield* Effect.logInfo("share_data", id)
        if (!id) return c.text("Error: Share ID is required", { status: 400 })
        const stub = c.env.SYNC_SERVER.get(c.env.SYNC_SERVER.idFromName(id))
        const data = yield* Effect.tryPromise(() => stub.getData())

        let info
        const messages: Record<string, any> = {}
        data.forEach((d) => {
          const [root, type] = d.key.split("/")
          if (root !== "session") return
          if (type === "info") {
            info = d.content
            return
          }
          if (type === "message") {
            messages[d.content.id] = {
              parts: [],
              ...d.content,
            }
          }
          if (type === "part") {
            messages[d.content.messageID].parts.push(d.content)
          }
        })

        return c.json({ info, messages })
      }),
    ),
  )
  .post("/feishu", (c) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const raw = yield* Effect.tryPromise(() => c.req.json<unknown>())
        yield* Effect.logInfo(raw)
        const body = yield* Schema.decodeUnknownEffect(FeishuEvent)(raw)
        const challenge = body.challenge
        if (challenge) return c.json({ challenge })

        const content = body.event?.message?.content ?? ""
        // Invalid JSON still fails the route; JSON without a string `text` falls back to the raw content.
        const parsed = content.trim().startsWith("{")
          ? Schema.decodeUnknownOption(FeishuText)(yield* Schema.decodeUnknownEffect(JsonText)(content))
          : Option.none()
        const text = Option.match(parsed, { onNone: () => content, onSome: (value) => value.text })

        let message = text.trim().replace(/^@_user_\d+\s*/, "")
        message = message.replace(/^aiden,?\s*/i, "<@759257817772851260> ")
        if (!message) return c.json({ ok: true })

        const threadId = body.event?.message?.root_id || body.event?.message?.message_id
        if (threadId) message = `${message} [${threadId}]`

        const discordBody = yield* Schema.encodeEffect(DiscordMessageJson)({ content: message })
        const response = yield* Effect.tryPromise(() =>
          fetch(`https://discord.com/api/v10/channels/${Resource.DISCORD_SUPPORT_CHANNEL_ID.value}/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bot ${Resource.DISCORD_SUPPORT_BOT_TOKEN.value}`,
            },
            body: discordBody,
          }),
        )

        if (!response.ok) {
          yield* Effect.logError(yield* Effect.tryPromise(() => response.text()))
          return c.json({ error: "Discord bot message failed" }, { status: 502 })
        }

        return c.json({ ok: true })
      }),
    ),
  )
  /**
   * Used by the GitHub action to get GitHub installation access token given the OIDC token
   */
  .post("/exchange_github_app_token", (c) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const EXPECTED_AUDIENCE = "opencode-github-action"
        const GITHUB_ISSUER = "https://token.actions.githubusercontent.com"
        const JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`

        // get Authorization header
        const token = c.req.header("Authorization")?.replace(/^Bearer /, "")
        if (!token) return c.json({ error: "Authorization header is required" }, { status: 401 })

        // verify token
        const JWKS = createRemoteJWKSet(new URL(JWKS_URL))
        const verified = yield* githubRequest(() =>
          jwtVerify(token, JWKS, {
            issuer: GITHUB_ISSUER,
            audience: EXPECTED_AUDIENCE,
          }),
        ).pipe(
          Effect.flatMap(({ payload }) => parseRepositoryClaim(payload)),
          Effect.result,
        )
        if (Result.isFailure(verified)) {
          const err = verified.failure
          yield* Effect.logError("Token verification failed:", err._tag === "GitHubError" ? err.cause : err)
          return c.json({ error: "Invalid or expired token" }, { status: 403 })
        }
        const repository = verified.success
        const exchangeFailed = (error: unknown) =>
          Effect.logError("GitHub App token exchange failed:", error).pipe(
            Effect.as(
              c.json(
                { error: `Failed to exchange GitHub App token for ${repository.owner}/${repository.repo}` },
                { status: 502 },
              ),
            ),
          )

        return yield* Effect.gen(function* () {
          const auth = yield* githubAppAuth
          const appAuth = yield* githubRequest(() => auth({ type: "app" }))
          const octokit = new Octokit({ auth: appAuth.token })
          const { data: installation } = yield* githubRequest(() =>
            octokit.apps.getRepoInstallation({
              owner: repository.owner,
              repo: repository.repo,
            }),
          )
          const installationAuth = yield* githubRequest(() =>
            auth({
              type: "installation",
              installationId: installation.id,
            }),
          )
          return c.json({ token: installationAuth.token })
        }).pipe(
          // A GitHub failure carries the original error; log it as before.
          Effect.catch((error) => exchangeFailed(error.cause)),
          // The route has always answered 502 for any error thrown in this
          // block, such as an Octokit constructor error.
          Effect.catchDefect(exchangeFailed),
        )
      }),
    ),
  )
  /**
   * Used by the GitHub action to get GitHub installation access token given user PAT token (used when testing `opencode github run` locally)
   */
  .post("/exchange_github_app_token_with_pat", (c) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* Effect.tryPromise(() => c.req.json<{ owner: string; repo: string }>())
        const owner = body.owner
        const repo = body.repo
        const unauthorized = (original: unknown) =>
          Effect.succeed(c.json({ error: original instanceof Error ? original.message : original }, { status: 401 }))

        return yield* Effect.gen(function* () {
          // get Authorization header
          const authHeader = c.req.header("Authorization")
          const token = authHeader?.replace(/^Bearer /, "")
          if (!token) return yield* new PatAuthorizationError({ message: "Authorization header is required" })

          // Verify permissions
          const userClient = new Octokit({ auth: token })
          const { data: repoData } = yield* githubRequest(() => userClient.repos.get({ owner, repo }))
          if (!repoData.permissions.admin && !repoData.permissions.push && !repoData.permissions.maintain)
            return yield* new PatAuthorizationError({ message: "User does not have write permissions" })

          // Get installation token
          const auth = yield* githubAppAuth
          const appAuth = yield* githubRequest(() => auth({ type: "app" }))

          // Lookup installation
          const appClient = new Octokit({ auth: appAuth.token })
          const { data: installation } = yield* githubRequest(() =>
            appClient.apps.getRepoInstallation({
              owner,
              repo,
            }),
          )

          // Get installation token
          const installationAuth = yield* githubRequest(() =>
            auth({
              type: "installation",
              installationId: installation.id,
            }),
          )

          return c.json({ token: installationAuth.token })
        }).pipe(
          // A GitHub failure carries the original error; report its message as before.
          Effect.catch((e) => unauthorized(e._tag === "GitHubError" ? e.cause : e)),
          // The route has always answered 401 for any thrown error, such as a
          // TypeError when GitHub omits `permissions`.
          Effect.catchDefect(unauthorized),
        )
      }),
    ),
  )
  /**
   * Used by the opencode CLI to check if the GitHub app is installed
   */
  .get("/get_github_app_installation", (c) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const owner = c.req.query("owner")
        const repo = c.req.query("repo")

        const auth = yield* githubAppAuth
        const appAuth = yield* githubRequest(() => auth({ type: "app" }))

        // Lookup installation
        const octokit = new Octokit({ auth: appAuth.token })
        const installation = yield* githubRequest(() => octokit.apps.getRepoInstallation({ owner, repo })).pipe(
          Effect.map((ret) => Option.some(ret.data)),
          Effect.catchIf(
            // not installed
            (err) => err.cause instanceof Error && err.cause.message.includes("Not Found"),
            () => Effect.succeed(Option.none()),
          ),
        )

        return c.json({ installation: Option.getOrUndefined(installation) })
      }),
    ),
  )
  .all("*", (c) => c.text("Not Found"))
