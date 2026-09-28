import { Schema } from "effect"
import { SessionID } from "./schema"

import { NonNegativeInt } from "@opencode-ai/core/schema"
import { MessageError } from "./message-error"
import { AuthError, OutputLengthError } from "./message-error"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
export { AuthError, OutputLengthError } from "./message-error"

// Legacy v1 message data is stored JSON. The IDs are opaque strings from that data.
export const ToolCallID = Schema.String.pipe(Schema.brand("Message.ToolCallID")).annotate({
  identifier: "Message.ToolCallID",
  description: "Tool call identifier in a legacy v1 message.",
})
export type ToolCallID = Schema.Schema.Type<typeof ToolCallID>

export const SourceID = Schema.String.pipe(Schema.brand("Message.SourceID")).annotate({
  identifier: "Message.SourceID",
  description: "Source identifier in a legacy v1 message.",
})
export type SourceID = Schema.Schema.Type<typeof SourceID>

export const ID = Schema.String.pipe(Schema.brand("Message.ID")).annotate({
  identifier: "Message.ID",
  description: "Identifier of a legacy v1 message.",
})
export type ID = Schema.Schema.Type<typeof ID>

export const ToolCall = Schema.Struct({
  state: Schema.Literal("call"),
  step: Schema.optional(NonNegativeInt),
  toolCallId: ToolCallID,
  toolName: Schema.String,
  args: Schema.Json,
}).annotate({ identifier: "ToolCall" })
export type ToolCall = Schema.Schema.Type<typeof ToolCall>

export const ToolPartialCall = Schema.Struct({
  state: Schema.Literal("partial-call"),
  step: Schema.optional(NonNegativeInt),
  toolCallId: ToolCallID,
  toolName: Schema.String,
  args: Schema.Json,
}).annotate({ identifier: "ToolPartialCall" })
export type ToolPartialCall = Schema.Schema.Type<typeof ToolPartialCall>

export const ToolResult = Schema.Struct({
  state: Schema.Literal("result"),
  step: Schema.optional(NonNegativeInt),
  toolCallId: ToolCallID,
  toolName: Schema.String,
  args: Schema.Json,
  result: Schema.String,
}).annotate({ identifier: "ToolResult" })
export type ToolResult = Schema.Schema.Type<typeof ToolResult>

export const ToolInvocation = Schema.Union([ToolCall, ToolPartialCall, ToolResult]).annotate({
  identifier: "ToolInvocation",
  discriminator: "state",
})
export type ToolInvocation = Schema.Schema.Type<typeof ToolInvocation>

export const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
}).annotate({ identifier: "TextPart" })
export type TextPart = Schema.Schema.Type<typeof TextPart>

export const ReasoningPart = Schema.Struct({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  providerMetadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
}).annotate({ identifier: "ReasoningPart" })
export type ReasoningPart = Schema.Schema.Type<typeof ReasoningPart>

export const ToolInvocationPart = Schema.Struct({
  type: Schema.Literal("tool-invocation"),
  toolInvocation: ToolInvocation,
}).annotate({ identifier: "ToolInvocationPart" })
export type ToolInvocationPart = Schema.Schema.Type<typeof ToolInvocationPart>

export const SourceUrlPart = Schema.Struct({
  type: Schema.Literal("source-url"),
  sourceId: SourceID,
  url: Schema.String,
  title: Schema.optional(Schema.String),
  providerMetadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
}).annotate({ identifier: "SourceUrlPart" })
export type SourceUrlPart = Schema.Schema.Type<typeof SourceUrlPart>

export const FilePart = Schema.Struct({
  type: Schema.Literal("file"),
  mediaType: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
}).annotate({ identifier: "FilePart" })
export type FilePart = Schema.Schema.Type<typeof FilePart>

export const StepStartPart = Schema.Struct({
  type: Schema.Literal("step-start"),
}).annotate({ identifier: "StepStartPart" })
export type StepStartPart = Schema.Schema.Type<typeof StepStartPart>

export const MessagePart = Schema.Union([
  TextPart,
  ReasoningPart,
  ToolInvocationPart,
  SourceUrlPart,
  FilePart,
  StepStartPart,
]).annotate({ identifier: "MessagePart", discriminator: "type" })
export type MessagePart = Schema.Schema.Type<typeof MessagePart>

export const Info = Schema.Struct({
  id: ID,
  role: Schema.Literals(["user", "assistant"]),
  parts: Schema.Array(MessagePart),
  metadata: Schema.Struct({
    time: Schema.Struct({
      created: NonNegativeInt,
      completed: Schema.optional(NonNegativeInt),
    }),
    error: Schema.optional(MessageError.SharedSchema),
    sessionID: SessionID,
    tool: Schema.Record(
      Schema.String,
      Schema.StructWithRest(
        Schema.Struct({
          title: Schema.String,
          snapshot: Schema.optional(Schema.String),
          time: Schema.Struct({
            start: NonNegativeInt,
            end: NonNegativeInt,
          }),
        }),
        [Schema.Record(Schema.String, Schema.Json)],
      ),
    ),
    assistant: Schema.optional(
      Schema.Struct({
        system: Schema.Array(Schema.String),
        modelID: ModelV2.ID,
        providerID: ProviderV2.ID,
        path: Schema.Struct({
          cwd: Schema.String,
          root: Schema.String,
        }),
        cost: Schema.Finite,
        summary: Schema.optional(Schema.Boolean),
        tokens: Schema.Struct({
          input: Schema.Finite,
          output: Schema.Finite,
          reasoning: Schema.Finite,
          cache: Schema.Struct({
            read: Schema.Finite,
            write: Schema.Finite,
          }),
        }),
      }),
    ),
    snapshot: Schema.optional(Schema.String),
  }).annotate({ identifier: "MessageMetadata" }),
}).annotate({ identifier: "Message" })
export type Info = Schema.Schema.Type<typeof Info>

export * as Message from "./message"
