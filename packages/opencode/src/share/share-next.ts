import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import type * as SDK from "@opencode-ai/sdk/v2"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Effect, Exit, Layer, MutableHashMap, Option, Schema, Scope, Context } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Account } from "@/account/account"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { Config } from "@/config/config"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventV2 } from "@opencode-ai/core/event"
import { truthyConfig } from "@opencode-ai/core/flag/flag"

export type Api = {
  create: string
  sync: (shareID: string) => string
  remove: (shareID: string) => string
  data: (shareID: string) => string
}

export type Req = {
  headers: Record<string, string>
  api: Api
  baseUrl: string
}

// The share service assigns this id; the sync and remove endpoints take it.
const ShareID = Schema.String.pipe(Schema.brand("ShareNext.ShareID"))

const ShareSchema = Schema.Struct({
  id: ShareID,
  url: Schema.String,
  secret: Schema.String,
}).annotate({ identifier: "ShareNext.Share", description: "A share that the share service created for a session" })
export type Share = typeof ShareSchema.Type

export class TokenError extends Schema.TaggedError<TokenError>()("ShareNext.TokenError", {
  message: Schema.String,
}) {}

type State = {
  queue: MutableHashMap.MutableHashMap<SessionID, MutableHashMap.MutableHashMap<string, Data>>
  scope: Scope.Closeable
  // A cached None records a session that has no share row.
  shared: MutableHashMap.MutableHashMap<SessionID, Option.Option<Share>>
}

// The share service receives these values as JSON, so the event data types serve as they are.
type Data =
  | {
      type: "session"
      data: EventV2.Data<typeof Session.Event.Updated>["info"]
    }
  | {
      type: "message"
      data: EventV2.Data<typeof MessageV2.Event.Updated>["info"]
    }
  | {
      type: "part"
      data: EventV2.Data<typeof MessageV2.Event.PartUpdated>["part"]
    }
  | {
      type: "session_diff"
      data: EventV2.Data<typeof Session.Event.Diff>["diff"]
    }
  | {
      type: "model"
      data: SDK.Model[]
    }

export interface Interface {
  readonly init: () => Effect.Effect<void, unknown>
  readonly url: () => Effect.Effect<string, unknown>
  readonly request: () => Effect.Effect<Req, unknown>
  readonly create: (sessionID: SessionID) => Effect.Effect<Share, unknown>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShareNext") {}

export const use = serviceUse(Service)

function api(resource: string): Api {
  return {
    create: `/api/${resource}`,
    sync: (shareID) => `/api/${resource}/${shareID}/sync`,
    remove: (shareID) => `/api/${resource}/${shareID}`,
    data: (shareID) => `/api/${resource}/${shareID}/data`,
  }
}

const legacyApi = api("share")
const consoleApi = api("shares")

// The session, session_diff and model items have one slot each, keyed by their type.
function key(item: Data) {
  if (item.type === "message") return `message/${item.data.id}`
  if (item.type === "part") return `part/${item.data.messageID}/${item.data.id}`
  return item.type
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const account = yield* Account.Service
    const events = yield* EventV2Bridge.Service
    const cfg = yield* Config.Service
    const { db } = yield* Database.Service
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)
    const provider = yield* Provider.Service
    const session = yield* Session.Service
    const disabled = yield* truthyConfig("OPENCODE_DISABLE_SHARE").pipe(Effect.orDie)

    function sync(sessionID: SessionID, data: Data[]) {
      return Effect.gen(function* () {
        if (disabled) return
        const share = yield* getCached(sessionID)
        if (Option.isNone(share)) return

        const s = yield* InstanceState.get(state)
        const existing = MutableHashMap.get(s.queue, sessionID)
        if (Option.isSome(existing)) {
          for (const item of data) {
            MutableHashMap.set(existing.value, key(item), item)
          }
          return
        }

        MutableHashMap.set(
          s.queue,
          sessionID,
          MutableHashMap.fromIterable(data.map((item) => [key(item), item] as const)),
        )
        yield* flush(sessionID).pipe(
          Effect.delay("1 second"),
          Effect.catchCause((cause) => Effect.logError("share flush failed", { sessionID: sessionID, cause: cause })),
          Effect.forkIn(s.scope),
        )
      })
    }

    const state: InstanceState.InstanceState<State> = yield* InstanceState.make<State>(
      Effect.fn("ShareNext.state")(function* (_ctx) {
        const cache: State = {
          queue: MutableHashMap.empty(),
          scope: yield* Scope.make(),
          shared: MutableHashMap.empty(),
        }

        yield* Effect.addFinalizer(() =>
          Scope.close(cache.scope, Exit.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                MutableHashMap.clear(cache.queue)
                MutableHashMap.clear(cache.shared)
              }),
            ),
          ),
        )

        if (disabled) return cache

        const watch = <D extends EventV2.Definition>(
          def: D,
          fn: (data: EventV2.Data<D>) => Effect.Effect<void, unknown>,
        ) =>
          events.listen((event) => {
            if (event.type !== def.type || event.location?.directory !== _ctx.directory) return Effect.void
            return fn(event.data as EventV2.Data<D>).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("share subscriber failed", { type: def.type, cause: cause }),
              ),
            )
          })

        yield* watch(Session.Event.Updated, (data) =>
          Effect.gen(function* () {
            const info = data.info
            yield* sync(info.id, [{ type: "session", data: structuredClone(info) }])
          }),
        )
        yield* watch(MessageV2.Event.Updated, (data) =>
          Effect.gen(function* () {
            const info = data.info
            yield* sync(info.sessionID, [{ type: "message", data: structuredClone(info) }])
            if (info.role !== "user") return
            const model = yield* provider.getModel(info.model.providerID, info.model.modelID)
            yield* sync(info.sessionID, [{ type: "model", data: [model] }])
          }),
        )
        yield* watch(MessageV2.Event.PartUpdated, (data) =>
          sync(data.part.sessionID, [{ type: "part", data: structuredClone(data.part) }]),
        )
        yield* watch(Session.Event.Diff, (data) =>
          sync(data.sessionID, [{ type: "session_diff", data: structuredClone(data.diff) }]),
        )
        yield* watch(Session.Event.Deleted, (data) => remove(data.sessionID))

        return cache
      }),
    )

    const request = Effect.fn("ShareNext.request")(function* () {
      const headers: Record<string, string> = {}
      const active = yield* account.active()
      if (Option.isNone(active) || !active.value.active_org_id) {
        const baseUrl = (yield* cfg.get()).enterprise?.url ?? "https://opncd.ai"
        return { headers, api: legacyApi, baseUrl } satisfies Req
      }

      const token = yield* account.token(active.value.id)
      if (Option.isNone(token)) {
        return yield* new TokenError({ message: "No active account token available for sharing" })
      }

      headers.authorization = `Bearer ${token.value}`
      headers["x-org-id"] = active.value.active_org_id
      return { headers, api: consoleApi, baseUrl: active.value.url } satisfies Req
    })

    const get = Effect.fnUntraced(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(SessionShareTable)
        .where(eq(SessionShareTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return Option.map(
        Option.fromNullishOr(row),
        (found): Share => ({ id: ShareID.make(found.id), secret: found.secret, url: found.url }),
      )
    })

    const getCached = Effect.fnUntraced(function* (sessionID: SessionID) {
      const s = yield* InstanceState.get(state)
      const cached = MutableHashMap.get(s.shared, sessionID)
      if (Option.isSome(cached)) return cached.value

      const share = yield* get(sessionID)
      MutableHashMap.set(s.shared, sessionID, share)
      return share
    })

    const flush = Effect.fn("ShareNext.flush")(function* (sessionID: SessionID) {
      if (disabled) return
      const s = yield* InstanceState.get(state)
      const queued = MutableHashMap.get(s.queue, sessionID)
      if (Option.isNone(queued)) return

      MutableHashMap.remove(s.queue, sessionID)

      const found = yield* getCached(sessionID)
      if (Option.isNone(found)) return
      const share = found.value

      const req = yield* request()
      const res = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.sync(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret: share.secret, data: Array.from(MutableHashMap.values(queued.value)) }),
        Effect.flatMap((r) => http.execute(r)),
      )

      if (res.status >= 400) {
        yield* Effect.logWarning("failed to sync share", {
          sessionID: sessionID,
          shareID: share.id,
          status: res.status,
        })
      }
    })

    const full = Effect.fn("ShareNext.full")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("full sync", { sessionID: sessionID })
      const info = yield* session.get(sessionID)
      const diffs = yield* session.diff(sessionID)
      const messages = yield* session.messages({ sessionID })
      const models = yield* Effect.forEach(
        Array.from(
          MutableHashMap.fromIterable(
            messages
              .flatMap((msg) => (msg.info.role === "user" ? [msg.info.model] : []))
              .map((item) => [`${item.providerID}/${item.modelID}`, item] as const),
          ).pipe(MutableHashMap.values),
        ),
        (item) => provider.getModel(ProviderV2.ID.make(item.providerID), ModelV2.ID.make(item.modelID)),
        { concurrency: 8 },
      )

      yield* sync(sessionID, [
        { type: "session", data: info },
        ...messages.map((item) => ({ type: "message" as const, data: item.info })),
        ...messages.flatMap((item) => item.parts.map((part) => ({ type: "part" as const, data: part }))),
        { type: "session_diff", data: diffs },
        { type: "model", data: models },
      ])
    })

    const init = Effect.fn("ShareNext.init")(function* () {
      if (disabled) return
      yield* InstanceState.get(state)
    })

    const url = Effect.fn("ShareNext.url")(function* () {
      return (yield* request()).baseUrl
    })

    const create = Effect.fn("ShareNext.create")(function* (sessionID: SessionID) {
      if (disabled) return { id: ShareID.make(""), url: "", secret: "" }
      yield* Effect.logInfo("creating share", { sessionID: sessionID })
      const req = yield* request()
      const result = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.create}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ sessionID }),
        Effect.flatMap((r) => httpOk.execute(r)),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ShareSchema)),
      )
      yield* db
        .insert(SessionShareTable)
        .values({ session_id: sessionID, id: result.id, secret: result.secret, url: result.url })
        .onConflictDoUpdate({
          target: SessionShareTable.session_id,
          set: { id: result.id, secret: result.secret, url: result.url },
        })
        .run()
        .pipe(Effect.orDie)
      const s = yield* InstanceState.get(state)
      MutableHashMap.set(s.shared, sessionID, Option.some(result))
      yield* full(sessionID).pipe(
        Effect.catchCause((cause) => Effect.logError("share full sync failed", { sessionID: sessionID, cause: cause })),
        Effect.forkIn(s.scope),
      )
      return result
    })

    const remove = Effect.fn("ShareNext.remove")(function* (sessionID: SessionID) {
      if (disabled) return
      yield* Effect.logInfo("removing share", { sessionID: sessionID })
      const s = yield* InstanceState.get(state)
      const found = yield* getCached(sessionID)
      if (Option.isNone(found)) {
        MutableHashMap.remove(s.shared, sessionID)
        MutableHashMap.remove(s.queue, sessionID)
        return
      }
      const share = found.value

      const req = yield* request()
      yield* HttpClientRequest.delete(`${req.baseUrl}${req.api.remove(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret: share.secret }),
        Effect.flatMap((r) => httpOk.execute(r)),
      )

      yield* db.delete(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).run().pipe(Effect.orDie)
      MutableHashMap.remove(s.shared, sessionID)
      MutableHashMap.remove(s.queue, sessionID)
    })

    return Service.of({ init, url, request, create, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Account.node, EventV2Bridge.node, Config.node, Database.node, httpClient, Provider.node, Session.node],
})

export * as ShareNext from "./share-next"
