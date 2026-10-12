import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { layerWebSocketConstructorGlobal } from "effect/socket/Socket"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)

export const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
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
