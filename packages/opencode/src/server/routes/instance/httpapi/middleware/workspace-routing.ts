import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import type { Target } from "@/control-plane/types"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceAdapterRuntime } from "@/control-plane/workspace-adapter-runtime"
import { Session } from "@/session/session"
import { HttpApiProxy } from "./proxy"
import * as Fence from "@/server/shared/fence"
import { getWorkspaceRouteSessionID, isLocalWorkspaceRoute, workspaceProxyURL } from "@/server/shared/workspace-routing"
import { NotFoundError } from "@/storage/storage"
import { FlagConfig } from "@opencode-ai/core/flag/flag"
import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { InvalidRequestError } from "../errors"

// Query fields this middleware reads from the URL. Spread into every
// endpoint query schema in groups that apply WorkspaceRoutingMiddleware,
// otherwise HttpApi rejects requests carrying these params with 400.
// HttpApiMiddleware in effect-smol cannot declare query params today —
// remove this once upstream supports middleware-declared query schemas.
export const WorkspaceRoutingQueryFields = {
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
}

export const WorkspaceRoutingQuery = Schema.Struct(WorkspaceRoutingQueryFields)

type RemoteTarget = Extract<Target, { type: "remote" }>

type RequestPlan = Data.TaggedEnum<{
  InvalidWorkspace: {}
  MissingWorkspace: { readonly workspaceID: WorkspaceV2.ID }
  Local: { readonly directory: string; readonly workspaceID: Option.Option<WorkspaceV2.ID> }
  Remote: {
    readonly request: HttpServerRequest.HttpServerRequest
    readonly workspace: Workspace.Info
    readonly target: RemoteTarget
    readonly url: URL
  }
}>
const RequestPlan = Data.taggedEnum<RequestPlan>()
const InvalidWorkspaceID = Symbol("InvalidWorkspaceID")

export class WorkspaceRouteContext extends Context.Service<
  WorkspaceRouteContext,
  {
    readonly directory: string
    readonly workspaceID?: WorkspaceV2.ID
  }
>()("@opencode/ExperimentalHttpApiWorkspaceRouteContext") {}

export class WorkspaceRoutingMiddleware extends HttpApiMiddleware.Service<
  WorkspaceRoutingMiddleware,
  {
    provides: WorkspaceRouteContext
    requires: Session.Service
  }
>()("@opencode/ExperimentalHttpApiWorkspaceRouting") {}

function requestURL(request: HttpServerRequest.HttpServerRequest): URL {
  return new URL(request.url, "http://localhost")
}

// The ambient provider treats an empty variable as not set. The variable is optional, so a
// ConfigError is a defect.
const configuredWorkspaceID = FlagConfig.OPENCODE_WORKSPACE_ID.pipe(
  Effect.orDie,
  Effect.map(Option.map((id) => WorkspaceV2.ID.make(id))),
)

function workspaceParam(url: URL): Option.Option<string> {
  return Option.fromNullishOr(url.searchParams.get("workspace")).pipe(Option.filter((value) => value !== ""))
}

function selectedWorkspaceID(
  url: URL,
  sessionWorkspaceID: Option.Option<WorkspaceV2.ID>,
): Option.Option<WorkspaceV2.ID> {
  return Option.orElse(sessionWorkspaceID, () => Option.map(workspaceParam(url), (id) => WorkspaceV2.ID.make(id)))
}

function selectedV2WorkspaceID(
  url: URL,
  sessionWorkspaceID: Option.Option<WorkspaceV2.ID>,
): Option.Option<WorkspaceV2.ID> | typeof InvalidWorkspaceID {
  if (Option.isSome(sessionWorkspaceID) && sessionWorkspaceID.value) return sessionWorkspaceID
  const param = workspaceParam(url)
  if (Option.isNone(param)) return Option.none()
  const workspaceID = Schema.decodeUnknownOption(WorkspaceV2.ID)(param.value)
  if (Option.isNone(workspaceID)) return InvalidWorkspaceID
  return workspaceID
}

function defaultDirectory(request: HttpServerRequest.HttpServerRequest, url: URL): string {
  return url.searchParams.get("directory") || request.headers["x-opencode-directory"] || process.cwd()
}

function shouldStayOnControlPlane(request: HttpServerRequest.HttpServerRequest, url: URL): boolean {
  return isLocalWorkspaceRoute(request.method, url.pathname) || url.pathname.startsWith("/console")
}

function resolveWorkspace(
  id: Option.Option<WorkspaceV2.ID>,
  envWorkspaceID: Option.Option<WorkspaceV2.ID>,
): Effect.Effect<Option.Option<Workspace.Info>, never, Workspace.Service> {
  if (Option.isNone(id) || Option.isSome(envWorkspaceID)) return Effect.succeedNone
  return Workspace.Service.use((workspace) => workspace.get(id.value)).pipe(Effect.map(Option.fromNullishOr))
}

function missingWorkspaceResponse(id: WorkspaceV2.ID): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.text(`Workspace not found: ${id}`, {
    status: 500,
    contentType: "text/plain; charset=utf-8",
  })
}

function resolveTarget(workspace: Workspace.Info): Effect.Effect<Target> {
  return WorkspaceAdapterRuntime.target(workspace)
}

function proxyRemote(
  client: HttpClient.HttpClient,
  request: HttpServerRequest.HttpServerRequest,
  workspace: Workspace.Info,
  target: RemoteTarget,
  url: URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Socket.WebSocketConstructor | Workspace.Service> {
  return Effect.gen(function* () {
    const syncing = yield* Workspace.Service.use((svc) => svc.isSyncing(workspace.id))
    if (!syncing) {
      return HttpServerResponse.text(`broken sync connection for workspace: ${workspace.id}`, {
        status: 503,
        contentType: "text/plain; charset=utf-8",
      })
    }
    const proxyURL = workspaceProxyURL(target.url, url)
    const headers = request.headers as Record<string, string>
    if (headers["upgrade"]?.toLowerCase() === "websocket") return yield* HttpApiProxy.websocket(request, proxyURL)
    const response = yield* HttpApiProxy.http(client, proxyURL, target.headers, request)
    const sync = Fence.parse(new Headers(response.headers))
    if (!sync) return response
    const signal = request.source instanceof Request ? Option.some(request.source.signal) : Option.none()
    return yield* Fence.wait(workspace.id, sync, Option.getOrUndefined(signal)).pipe(
      Effect.as(response),
      Effect.catch((error) => Effect.succeed(HttpServerResponse.text(error.message, { status: 503 }))),
    )
  })
}

function planWorkspaceRequest(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  workspace: Workspace.Info,
): Effect.Effect<RequestPlan, never, Workspace.Service> {
  return Effect.gen(function* () {
    const target = yield* resolveTarget(workspace)
    if (target.type === "remote") return RequestPlan.Remote({ request, workspace, target, url })
    return RequestPlan.Local({ directory: target.directory, workspaceID: Option.some(workspace.id) })
  })
}

function planRequest(
  request: HttpServerRequest.HttpServerRequest,
  session: Option.Option<Session.Info>,
): Effect.Effect<RequestPlan, never, Workspace.Service> {
  return Effect.gen(function* () {
    const url = requestURL(request)
    const envWorkspaceID = yield* configuredWorkspaceID
    const sessionWorkspaceID = Option.flatMap(session, (info) => Option.fromNullishOr(info.workspaceID))
    const workspaceID = url.pathname.startsWith("/api/")
      ? selectedV2WorkspaceID(url, sessionWorkspaceID)
      : selectedWorkspaceID(url, sessionWorkspaceID)
    if (workspaceID === InvalidWorkspaceID) return RequestPlan.InvalidWorkspace()
    const workspace = yield* resolveWorkspace(workspaceID, envWorkspaceID)

    if (Option.isSome(workspaceID) && Option.isNone(workspace) && Option.isNone(envWorkspaceID)) {
      return RequestPlan.MissingWorkspace({ workspaceID: workspaceID.value })
    }

    if (Option.isSome(workspace) && Option.isNone(envWorkspaceID) && !shouldStayOnControlPlane(request, url)) {
      return yield* planWorkspaceRequest(request, url, workspace.value)
    }

    return RequestPlan.Local({
      directory: Option.match(session, {
        onNone: () => defaultDirectory(request, url),
        onSome: (info) => info.directory || defaultDirectory(request, url),
      }),
      workspaceID: Option.orElse(envWorkspaceID, () => workspaceID),
    })
  })
}

function routeWorkspace<E>(
  client: HttpClient.HttpClient,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext>,
  plan: RequestPlan,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, Socket.WebSocketConstructor | Workspace.Service> {
  return RequestPlan.$match(plan, {
    InvalidWorkspace: () =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          new InvalidRequestError({
            message: "Invalid workspace query parameter",
            kind: "Query",
            field: "workspace",
          }),
          { status: 400 },
        ),
      ),
    MissingWorkspace: ({ workspaceID }) => Effect.succeed(missingWorkspaceResponse(workspaceID)),
    Remote: ({ request, workspace, target, url }) => proxyRemote(client, request, workspace, target, url),
    Local: ({ directory, workspaceID }) =>
      effect.pipe(
        Effect.provideService(
          WorkspaceRouteContext,
          WorkspaceRouteContext.of({ directory, workspaceID: Option.getOrUndefined(workspaceID) }),
        ),
      ),
  })
}

function routeHttpApiWorkspace<E>(
  client: HttpClient.HttpClient,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  Session.Service | Workspace.Service | HttpServerRequest.HttpServerRequest | Socket.WebSocketConstructor
> {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const session = yield* Option.match(Option.fromNullishOr(getWorkspaceRouteSessionID(requestURL(request))), {
      onNone: () => Effect.succeedNone,
      onSome: (sessionID) =>
        Session.Service.use((svc) => svc.get(sessionID)).pipe(
          Effect.map(Option.some),
          Effect.catchIf(
            (error): error is NotFoundError => NotFoundError.isInstance(error),
            () => Effect.succeedNone,
          ),
          Effect.catchDefect(() => Effect.succeedNone),
        ),
    })
    const plan = yield* planRequest(request, session)
    return yield* routeWorkspace(client, effect, plan)
  })
}

export const workspaceRoutingLayer = Layer.effect(
  WorkspaceRoutingMiddleware,
  Effect.gen(function* () {
    const makeWebSocket = yield* Socket.WebSocketConstructor
    const workspace = yield* Workspace.Service
    const client = yield* HttpClient.HttpClient
    return WorkspaceRoutingMiddleware.of((effect) =>
      routeHttpApiWorkspace(client, effect).pipe(
        Effect.provideService(Socket.WebSocketConstructor, makeWebSocket),
        Effect.provideService(Workspace.Service, workspace),
      ),
    )
  }),
)
