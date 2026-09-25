import { Option } from "effect"
import type { Projection } from "./markdown-stream"

export type MarkdownToken = [content: string, style: string]

export type MarkdownWorkerRequest =
  | { type: "parse"; id: number; text: string }
  | { type: "project"; id: number; key: string; text: string; live: boolean }
  | { type: "highlight"; id: number; key: string; text: string; language: string; complete?: boolean }
  | { type: "dispose"; key: string }

export type MarkdownWorkerResponse =
  | { type: "parse"; id: number; html: string }
  | { type: "project"; id: number; key: string; projection: Projection }
  | {
      type: "highlight"
      id: number
      key: string
      language: string
      reset: boolean
      stable: MarkdownToken[]
      unstable: MarkdownToken[]
    }
  | { type: "error"; id: number; key?: string; message: string }
  | { type: "superseded"; id: number; key: string }

export type MarkdownWorkerState = {
  id: number
  generation: number
  language: string
  stable: MarkdownToken[]
  unstable: MarkdownToken[]
}

export function shouldReleaseMarkdownWorkerState(
  complete: boolean,
  latestID: Option.Option<number>,
  responseID: number,
) {
  return complete && Option.exists(latestID, (id) => id === responseID)
}

export function markdownBlockKey(owner: string, cacheKey: Option.Option<string>, index: number, mode: string) {
  // An empty cache key counts as no key, as the old truthiness check did.
  const scope = Option.match(
    Option.filter(cacheKey, (key) => key.length > 0),
    {
      onNone: () => `block:${index}`,
      onSome: (key) => `${key}:${index}:${mode}`,
    },
  )
  return `${owner}:${scope}`
}

export function applyMarkdownWorkerResponse(
  state: Option.Option<MarkdownWorkerState>,
  response: Extract<MarkdownWorkerResponse, { type: "highlight" }>,
): MarkdownWorkerState {
  if (Option.isSome(state) && response.id <= state.value.id) return state.value
  const generation = Option.match(state, { onNone: () => 0, onSome: (value) => value.generation })
  const stable = Option.match(state, { onNone: () => [], onSome: (value) => value.stable })
  return {
    id: response.id,
    generation: generation + (response.reset ? 1 : 0),
    language: response.language,
    stable: response.reset ? response.stable : [...stable, ...response.stable],
    unstable: response.unstable,
  }
}
