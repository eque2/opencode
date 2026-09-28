import { Brand, Data, Result } from "effect"
import type { ServerConnection } from "@/context/server"

export type ServerScope = string & Brand.Brand<"ServerScope">
export type SessionRouteKey = string & Brand.Brand<"SessionRouteKey">
export type SessionStateKey = string & Brand.Brand<"SessionStateKey">
export type ScopedKey = string & Brand.Brand<"ScopedKey">

class ScopeFragmentError extends Data.TaggedError("App.ScopeFragmentError")<{ readonly message: string }> {}

const separator = "\u0000"

const serverScope = Brand.nominal<ServerScope>()
const sessionRouteKey = Brand.nominal<SessionRouteKey>()
const sessionStateKey = Brand.nominal<SessionStateKey>()
const scopedKey = Brand.nominal<ScopedKey>()

function fragment(label: string, value: string): Result.Result<string, ScopeFragmentError> {
  if (value.includes(separator)) {
    return Result.fail(new ScopeFragmentError({ message: `${label} cannot contain null bytes` }))
  }
  return Result.succeed(value)
}

function compose(scope: ServerScope, parts: ReadonlyArray<string>): Result.Result<string, ScopeFragmentError> {
  const fragments = Result.all([
    fragment("Server scope", scope),
    ...parts.map((part) => fragment("Scoped key part", part)),
  ])
  return Result.map(fragments, (values) => values.join(separator))
}

// The key constructors below are synchronous and throw ScopeFragmentError for a fragment with a null byte.
export const ServerScope = {
  local: serverScope("local"),
  make(value: string): ServerScope {
    return serverScope(Result.getOrThrow(fragment("Server scope", value)))
  },
  fromServerKey(key: ServerConnection.Key, canonicalLocalServer?: ServerConnection.Key): ServerScope {
    return ServerScope.make(key === "sidecar" || key === canonicalLocalServer ? ServerScope.local : key)
  },
}

export const SessionRouteKey = {
  fromRoute(dir: string | undefined, sessionID?: string): SessionRouteKey {
    const route = `${dir ?? ""}${sessionID ? "/" + sessionID : ""}`
    return sessionRouteKey(Result.getOrThrow(fragment("Session route", route)))
  },
  fromLegacy(key: string): SessionRouteKey {
    return sessionRouteKey(Result.getOrThrow(fragment("Legacy session route", key)))
  },
}

export const SessionStateKey = {
  from(scope: ServerScope, route: SessionRouteKey): SessionStateKey {
    return sessionStateKey(Result.getOrThrow(compose(scope, [route])))
  },
  route(key: string): SessionRouteKey {
    const split = key.lastIndexOf(separator)
    return SessionRouteKey.fromLegacy(split === -1 ? key : key.slice(split + 1))
  },
  scope(key: string): ServerScope {
    const split = key.indexOf(separator)
    if (split === -1) return ServerScope.local
    return serverScope(Result.getOrThrow(fragment("Stored server scope", key.slice(0, split))))
  },
}

export const ScopedKey = {
  from(scope: ServerScope, ...parts: string[]): ScopedKey {
    return scopedKey(Result.getOrThrow(compose(scope, parts)))
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
