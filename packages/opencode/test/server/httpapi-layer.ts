import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { layerWebSocketConstructorGlobal } from "effect/socket/Socket"
import { createServer } from "node:http"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"

// NodeHttpServer.layerTest, bound to the loopback address. layerTest listens on the wildcard
// address and its client sends requests to 127.0.0.1. On macOS another process can then bind
// 127.0.0.1 on the same ephemeral port and receive those requests, which answer 404. A server
// bound to 127.0.0.1 itself makes that second bind fail instead.
const loopbackTestServer = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
    ),
  ),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
)

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)

export const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(loopbackTestServer),
  Layer.provideMerge(NodeServices.layer),
)

// Serves the routes on top of a test's own services, so the routes reuse the test's instances.
// HttpRouter.serve builds the routes in a fork of the memo map: the fork reads its parent's
// entries but never writes back. Layer.mergeAll builds its layers concurrently, so a service
// merged beside the routes is shared only when the sibling reaches the memo map first. Under
// OPENCODE_DB=":memory:" a second Database is a separate, empty database. Building the services
// beneath the routes puts them in the parent memo map before the fork reads it.
export const httpApiLayerWith = <A, E, R>(services: Layer.Layer<A, E, R>) =>
  httpApiLayer.pipe(Layer.provideMerge(services))

export function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

export function requestInDirectory(path: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return request(path, { ...init, headers })
}
