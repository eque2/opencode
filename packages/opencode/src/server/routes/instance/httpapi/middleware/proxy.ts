import { ProxyUtil } from "@/server/proxy-util"
import { Effect, Predicate, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { WebSocketTracker } from "../websocket-tracker"

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  if (request.source instanceof Request && Predicate.isNull(request.source.body)) return HttpBody.empty
  const len = request.headers["content-length"]
  const contentType = request.headers["content-type"]
  return len
    ? HttpBody.stream(request.stream, contentType, Number(len))
    : HttpBody.stream(request.stream, contentType)
}

export function websocket(
  request: HttpServerRequest.HttpServerRequest,
  target: string | URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Socket.WebSocketConstructor> {
  return Effect.scoped(
    Effect.gen(function* () {
      const inbound = yield* Effect.orDie(request.upgrade)
      const outbound = yield* Socket.makeWebSocket(ProxyUtil.websocketTargetURL(target), {
        protocols: ProxyUtil.websocketProtocols(request.headers),
      })
      const { write: writeInbound } = yield* inbound.writer
      const { write: writeOutbound } = yield* outbound.writer
      const closeSocket = (socket: Socket.Socket, write: Socket.Writer["write"]) =>
        Effect.gen(function* () {
          const reader = yield* socket.reader
          yield* write(WebSocketTracker.SERVER_CLOSING_EVENT()).pipe(Effect.catch(() => Effect.void))
          while (true) yield* reader.pull
        }).pipe(
          Effect.timeout("1 second"),
          Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
          Effect.catch(() => Effect.void),
        )
      const forward = (
        socket: Socket.Socket,
        write: (message: string | Uint8Array) => Effect.Effect<void, Socket.SocketError>,
      ) =>
        Effect.gen(function* () {
          const reader = yield* socket.reader
          while (true) {
            const messages = yield* reader.pull
            for (const message of messages) yield* write(message)
          }
        })
      const closeAccepted = Effect.all([closeSocket(inbound, writeInbound), closeSocket(outbound, writeOutbound)], {
        concurrency: "unbounded",
        discard: true,
      })
      const registered = yield* WebSocketTracker.register(
        Effect.all(
          [
            writeInbound(WebSocketTracker.SERVER_CLOSING_EVENT()),
            writeOutbound(WebSocketTracker.SERVER_CLOSING_EVENT()),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      )
      if (!registered) {
        yield* closeAccepted
        return HttpServerResponse.empty()
      }

      yield* forward(outbound, writeInbound).pipe(
        Effect.catchReason("SocketError", "SocketCloseError", (reason) =>
          writeInbound(new Socket.CloseEvent(reason.code, reason.closeReason)).pipe(Effect.catch(() => Effect.void)),
        ),
        Effect.catch(() =>
          writeInbound(new Socket.CloseEvent(1011, "proxy error")).pipe(Effect.catch(() => Effect.void)),
        ),
        Effect.forkScoped,
      )

      yield* forward(inbound, (message) => writeOutbound(typeof message === "string" ? message : message.slice())).pipe(
        Effect.catch(() => Effect.void),
        Effect.ensuring(writeOutbound(new Socket.CloseEvent()).pipe(Effect.catch(() => Effect.void))),
      )
      return HttpServerResponse.empty()
    }).pipe(Effect.orDie),
  )
}

function statusText(response: unknown) {
  return (response as { source?: Response }).source?.statusText
}

export function http(
  client: HttpClient.HttpClient,
  url: string | URL,
  extra: HeadersInit | undefined,
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return Effect.gen(function* () {
    const response = yield* client.execute(
      HttpClientRequest.make(request.method as never)(url, {
        headers: ProxyUtil.headers(request.headers as HeadersInit, extra),
        body: requestBody(request),
      }),
    )
    const headers = new Headers(response.headers as HeadersInit)
    headers.delete("content-encoding")
    headers.delete("content-length")

    // An upstream 5xx from a remote workspace sandbox arrives here as an opaque
    // status — its real cause (and log line) live only inside the sandbox. Buffer
    // the small error body, log it locally so it shows up in the host's log, and
    // forward it unchanged (preserving content-type so the client can still parse
    // the structured error, e.g. its `ref`).
    if (response.status >= 500) {
      const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")))
      const contentType = response.headers["content-type"] ?? "application/json"
      headers.delete("content-type")
      yield* Effect.logError("workspace proxy upstream error", {
        url: url.toString(),
        method: request.method,
        status: response.status,
        body: body.slice(0, 2000),
      })
      return HttpServerResponse.text(body, {
        status: response.status,
        statusText: statusText(response),
        headers,
        contentType,
      })
    }

    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      statusText: statusText(response),
      headers,
    })
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 500 }))))
}

export * as HttpApiProxy from "./proxy"
