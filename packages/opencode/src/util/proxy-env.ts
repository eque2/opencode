/*
 * Adapted from proxy-from-env: https://github.com/Rob--W/proxy-from-env
 *
 * The MIT License
 *
 * Copyright (C) 2016-2018 Rob Wu <rob@robwu.nl>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { Config, Effect, Option } from "effect"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"

const DEFAULT_PORTS: Record<string, number> = {
  ftp: 21,
  gopher: 70,
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
}

type Target = { protocol: string; hostname: string; port: number }

/** Resolves the proxy URL for a request URL from the `*_proxy` and `no_proxy` environment variables. */
export const proxyForUrl = Effect.fn("ProxyEnv.proxyForUrl")(function* (input: string | URL) {
  const target = parseTarget(input)
  if (Option.isNone(target)) return Option.none<string>()
  const { protocol, hostname, port } = target.value
  if (!shouldProxy(hostname, port, yield* env("no_proxy"))) return Option.none<string>()

  const proxy = (yield* env(`${protocol}_proxy`)) || (yield* env("all_proxy"))
  return proxyUrl(protocol, proxy)
})

/**
 * Synchronous form of {@link proxyForUrl} for callers outside Effect. It reads process.env at call time.
 * The result is undefined when no proxy applies.
 */
export function getProxyForUrl(input: string | URL): string | undefined {
  return parseTarget(input).pipe(
    Option.filter(({ hostname, port }) => shouldProxy(hostname, port, envSync("no_proxy"))),
    Option.flatMap(({ protocol }) => proxyUrl(protocol, envSync(`${protocol}_proxy`) || envSync("all_proxy"))),
    Option.getOrUndefined,
  )
}

function parseTarget(input: string | URL): Option.Option<Target> {
  const url =
    typeof input !== "string"
      ? Option.some(input)
      : URL.canParse(input)
        ? Option.some(new URL(input))
        : Option.none<URL>()
  return url.pipe(
    Option.map((url) => {
      const protocol = url.protocol.split(":", 1)[0]
      return {
        protocol,
        hostname: url.host.replace(/:\d*$/, ""),
        port: Number.parseInt(url.port) || DEFAULT_PORTS[protocol] || 0,
      }
    }),
  )
}

function proxyUrl(protocol: string, proxy: string): Option.Option<string> {
  if (!proxy) return Option.none()
  return Option.some(proxy.includes("://") ? proxy : `${protocol}://${proxy}`)
}

function shouldProxy(hostname: string, port: number, env: string) {
  const noProxy = env.toLowerCase()
  if (!noProxy) return true
  if (noProxy === "*") return false

  return noProxy.split(/[,\s]/).every((proxy) => {
    if (!proxy) return true

    const parsed = proxy.match(/^(.+):(\d+)$/)
    const proxyHostname = parsed ? parsed[1] : proxy
    const proxyPort = parsed ? Number.parseInt(parsed[2]) : 0
    if (proxyPort && proxyPort !== port) return true

    if (!/^[.*]/.test(proxyHostname)) return hostname !== proxyHostname
    return !hostname.endsWith(proxyHostname.startsWith("*") ? proxyHostname.slice(1) : proxyHostname)
  })
}

// The lower-case name wins, and an empty value falls through to the upper-case name, as in proxy-from-env.
const readVariable = (name: string) => readEnvSnapshot(Config.String(name).pipe(Config.withDefault("")))

const env = Effect.fnUntraced(function* (key: string) {
  return (yield* readVariable(key.toLowerCase())) || (yield* readVariable(key.toUpperCase()))
})

function envSync(key: string) {
  return process.env[key.toLowerCase()] || process.env[key.toUpperCase()] || ""
}

export * as ProxyEnv from "./proxy-env"
