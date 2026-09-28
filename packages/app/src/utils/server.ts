import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { OpenCode, type OpenCodeClient } from "@opencode-ai/client/promise"
import { Option } from "effect"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  return Option.fromNullishOr(token).pipe(
    Option.flatMap((value) => Option.fromNullishOr(decode64(value))),
    Option.flatMap((decoded) => {
      const separator = decoded.indexOf(":")
      if (separator === -1) return Option.none()
      return Option.some({
        username: decoded.slice(0, separator) || "opencode",
        password: decoded.slice(separator + 1),
      })
    }),
    Option.getOrUndefined,
  )
}

/** Copies the caller's headers into a plain record, so the auth header can be merged over them. */
function headerRecord(headers: NonNullable<Parameters<typeof createOpencodeClient>[0]>["headers"]) {
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return headers
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  return createOpencodeClient({
    ...config,
    headers: {
      ...headerRecord(config.headers),
      ...(server.password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
          }
        : {}),
    },
    baseUrl: server.url,
  })
}

export function createApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): OpenCodeClient {
  return OpenCode.make({
    baseUrl: input.server.url,
    fetch: input.fetch,
    ...(input.server.password
      ? {
          headers: {
            Authorization: `Basic ${authTokenFromCredentials({
              username: input.server.username,
              password: input.server.password,
            })}`,
          },
        }
      : {}),
  })
}

export type ServerApi = OpenCodeClient
