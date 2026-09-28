import type { SessionV1 } from "@opencode-ai/schema/v1/session"

// The share viewer decodes its websocket frames with the SessionV1 schemas, so
// these are the decoded (readonly) schema types, not the mutable domain aliases.
export type MessageInfo = typeof SessionV1.Info.Type
export type MessagePart = typeof SessionV1.Part.Type
export type AssistantMessage = Extract<MessageInfo, { role: "assistant" }>
export type ToolPart = Extract<MessagePart, { type: "tool" }>
export type ToolStateCompleted = Extract<ToolPart["state"], { status: "completed" }>
