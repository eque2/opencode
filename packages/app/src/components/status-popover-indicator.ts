import type { LspStatus } from "@opencode-ai/sdk/v2/client"
import type { McpServer } from "@opencode-ai/client/promise"
import { Option } from "effect"

export function hasServiceNeedingAttention(input: { mcp: Array<McpServer["status"]["status"]> }) {
  return input.mcp.some((status) => status === "needs_auth" || status === "needs_client_registration")
}

export function hasNonBlockingServiceIssue(input: {
  mcp: Array<McpServer["status"]["status"]>
  lsp: Array<LspStatus["status"]>
}) {
  return (
    input.mcp.some((status) => status !== "connected" && status !== "pending" && status !== "disabled") ||
    input.lsp.some((status) => status === "error")
  )
}

/**
 * The status dot colour. `serverHealth` is none until the first health check
 * answers. An unhealthy server shows the critical colour even before the
 * services are ready.
 */
export function serverStatusDotClass(input: {
  ready: boolean
  serverHealth: Option.Option<boolean>
  attention?: boolean
  issue: boolean
}) {
  return Option.match(input.serverHealth, {
    onNone: () => "bg-border-weak-base",
    onSome: (healthy) => {
      if (!healthy) return "bg-icon-critical-base"
      if (!input.ready) return "bg-border-weak-base"
      if (input.attention) return "bg-v2-background-bg-accent"
      if (input.issue) return "bg-icon-warning-base"
      return "bg-icon-success-base"
    },
  })
}
