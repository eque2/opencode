import type { MessageV2 } from "opencode/session/message-v2"

// message-v2.ts takes its message types from @opencode-ai/core/v1/session and
// does not re-export them, and this package does not declare that dependency.
// These aliases read the types off a signature that MessageV2 does export.
export type WithParts = Parameters<typeof MessageV2.latest>[0][number]
export type MessageInfo = WithParts["info"]
export type MessagePart = WithParts["parts"][number]
export type AssistantMessage = Extract<MessageInfo, { role: "assistant" }>
export type ToolPart = Extract<MessagePart, { type: "tool" }>
export type ToolStateCompleted = Extract<ToolPart["state"], { status: "completed" }>
