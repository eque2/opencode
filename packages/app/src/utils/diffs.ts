import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import type { Message, UserMessage } from "@opencode-ai/sdk/v2/client"
import { Predicate, Struct } from "effect"

type Diff = FileDiffInfo | SnapshotFileDiff | VcsFileDiff

function diff(value: unknown): value is Diff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if (!("file" in value) || typeof value.file !== "string") return false
  if (!("patch" in value) || typeof value.patch !== "string") return false
  if (!("additions" in value) || typeof value.additions !== "number") return false
  if (!("deletions" in value) || typeof value.deletions !== "number") return false
  if (!("status" in value) || value.status === undefined) return true
  return value.status === "added" || value.status === "deleted" || value.status === "modified"
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function diffs(value: unknown): Diff[] {
  if (Array.isArray(value) && value.every(diff)) return value
  if (Array.isArray(value)) return value.filter(diff)
  if (diff(value)) return [value]
  if (!object(value)) return []
  return Object.values(value).filter(diff)
}

/** A user message as the server sent it. Its summary can have any shape, and `message` repairs it. */
export type RawUserMessage = Omit<UserMessage, "summary"> & { summary?: unknown }

// A summary is kept as is when its title and body are strings or absent and its diffs are all valid.
function validSummary(value: UserMessage | RawUserMessage): value is UserMessage {
  const raw = value.summary
  if (raw === undefined) return true
  if (!object(raw)) return false
  const text = (field: unknown) => field === undefined || Predicate.isString(field)
  return text(raw.title) && text(raw.body) && Array.isArray(raw.diffs) && raw.diffs.every(diff)
}

export function message(value: Message | RawUserMessage): Message {
  if (value.role !== "user") return value
  if (validSummary(value)) return value

  const raw = value.summary
  if (!object(raw)) return Struct.omit(value, ["summary"])

  return {
    ...value,
    summary: {
      ...(Predicate.isString(raw.title) ? { title: raw.title } : {}),
      ...(Predicate.isString(raw.body) ? { body: raw.body } : {}),
      diffs: diffs(raw.diffs),
    },
  }
}
