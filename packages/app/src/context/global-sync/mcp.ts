import type { McpServer } from "@opencode-ai/client/promise"
import { Effect } from "effect"

/**
 * Runs the action that the server status asks for, then refreshes the owning MCP queries.
 * A server whose connection is pending is left alone.
 */
export function toggleMcp<E>(input: {
  status: McpServer["status"]["status"]
  connect: Effect.Effect<void, E>
  disconnect: Effect.Effect<void, E>
  authenticate: Effect.Effect<void, E>
  refresh: Effect.Effect<void, E>
}): Effect.Effect<void, E> {
  if (input.status === "pending") return Effect.void
  const action = {
    connected: input.disconnect,
    needs_auth: input.authenticate,
    disabled: input.connect,
    failed: input.connect,
    needs_client_registration: input.connect,
  }[input.status]
  return Effect.andThen(action, input.refresh)
}
