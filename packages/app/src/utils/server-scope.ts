import { Brand } from "effect"
import type { ServerConnection } from "@/context/server"

export type ServerScope = string & Brand.Brand<"ServerScope">
export type SessionRouteKey = string & Brand.Brand<"SessionRouteKey">
export type SessionStateKey = string & Brand.Brand<"SessionStateKey">
export type ScopedKey = string & Brand.Brand<"ScopedKey">

const separator = "\u0000"

const serverScope = Brand.nominal<ServerScope>()
const sessionRouteKey = Brand.nominal<SessionRouteKey>()
const sessionStateKey = Brand.nominal<SessionStateKey>()
const scopedKey = Brand.nominal<ScopedKey>()

function fragment(label: string, value: string) {
  if (value.includes(separator)) throw new Error(`${label} cannot contain null bytes`)
  return value
}

function compose(scope: ServerScope, parts: string[]) {
  return [fragment("Server scope", scope), ...parts.map((part) => fragment("Scoped key part", part))].join(separator)
}

export const ServerScope = {
  local: serverScope("local"),
  make(value: string): ServerScope {
    return serverScope(fragment("Server scope", value))
  },
  fromServerKey(key: ServerConnection.Key, canonicalLocalServer?: ServerConnection.Key): ServerScope {
    return ServerScope.make(key === "sidecar" || key === canonicalLocalServer ? ServerScope.local : key)
  },
}

export const SessionRouteKey = {
  fromRoute(dir: string | undefined, sessionID?: string): SessionRouteKey {
    return sessionRouteKey(fragment("Session route", `${dir ?? ""}${sessionID ? "/" + sessionID : ""}`))
  },
  fromLegacy(key: string): SessionRouteKey {
    return sessionRouteKey(fragment("Legacy session route", key))
  },
}

export const SessionStateKey = {
  from(scope: ServerScope, route: SessionRouteKey): SessionStateKey {
    return sessionStateKey(compose(scope, [route]))
  },
  route(key: string): SessionRouteKey {
    const split = key.lastIndexOf(separator)
    return SessionRouteKey.fromLegacy(split === -1 ? key : key.slice(split + 1))
  },
  scope(key: string): ServerScope {
    const split = key.indexOf(separator)
    if (split === -1) return ServerScope.local
    return serverScope(fragment("Stored server scope", key.slice(0, split)))
  },
}

export const ScopedKey = {
  from(scope: ServerScope, ...parts: string[]): ScopedKey {
    return scopedKey(compose(scope, parts))
  },
  prefix(scope: ServerScope, ...parts: string[]) {
    return `${ScopedKey.from(scope, ...parts)}${separator}`
  },
}

export function migrateLegacySessionStateKeys(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const entries = Object.entries(value)
  if (entries.every(([key]) => key.includes(separator))) return value
  const scoped = Object.fromEntries(entries.filter(([key]) => key.includes(separator)))
  for (const [key, item] of entries) {
    if (key.includes(separator)) continue
    const next = SessionStateKey.from(ServerScope.local, SessionRouteKey.fromLegacy(key))
    if (!(next in scoped)) scoped[next] = item
  }
  return scoped
}
