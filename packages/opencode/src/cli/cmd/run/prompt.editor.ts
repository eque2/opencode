import { Option } from "effect"
import type { RunPromptPart } from "./types"

type Mention = Extract<RunPromptPart, { type: "file" | "agent" }>

export function resolveEditorSlashValue(text: string) {
  return slashHead(text).pipe(
    Option.filter((head) => head.name.toLowerCase() === "editor"),
    Option.match({ onNone: () => text, onSome: (head) => head.arguments }),
  )
}

// A mention whose text no longer appears in the edited content is dropped. The
// used ranges keep two mentions with the same text from claiming one match.
export function realignEditorPromptParts(content: string, parts: RunPromptPart[]): RunPromptPart[] {
  const used: Array<{ start: number; end: number }> = []

  return parts.flatMap((part): RunPromptPart[] => {
    if (part.type !== "file" && part.type !== "agent") {
      return [part]
    }

    const text = promptPartText(part)
    if (!text) {
      return [part]
    }

    const start = findPromptPartIndex(content, text, used, promptPartStart(part))
    if (start === -1) {
      return []
    }

    const end = start + text.length
    used.push({ start, end })
    return [updatePromptPart(part, start, end, text)]
  })
}

function slashHead(text: string): Option.Option<{ name: string; arguments: string }> {
  if (!text.startsWith("/")) {
    return Option.none()
  }

  for (let i = 1; i < text.length; i++) {
    switch (text[i]) {
      case " ":
      case "\t":
      case "\n":
        return Option.some({
          name: text.slice(1, i),
          arguments: text.slice(i + 1),
        })
    }
  }

  return Option.some({
    name: text.slice(1),
    arguments: "",
  })
}

function promptPartText(part: Mention) {
  if (part.type === "agent") {
    return part.source?.value
  }

  return part.source?.text.value
}

function promptPartStart(part: Mention) {
  if (part.type === "agent") {
    return part.source?.start ?? Number.POSITIVE_INFINITY
  }

  return part.source?.text.start ?? Number.POSITIVE_INFINITY
}

function findPromptPartIndex(content: string, text: string, used: Array<{ start: number; end: number }>, hint: number) {
  let searchFrom = 0
  let best = -1
  let distance = Number.POSITIVE_INFINITY
  const hinted = Number.isFinite(hint)

  while (true) {
    const start = content.indexOf(text, searchFrom)
    if (start === -1) {
      return best
    }

    const end = start + text.length
    searchFrom = start + 1
    if (used.some((range) => start < range.end && end > range.start)) {
      continue
    }

    if (!hinted) {
      return start
    }

    const nextDistance = Math.abs(start - hint)
    if (nextDistance < distance) {
      best = start
      distance = nextDistance
    }
  }
}

function updatePromptPart(part: Mention, start: number, end: number, text: string): Mention {
  if (part.type === "agent") {
    return {
      ...part,
      source: {
        start,
        end,
        value: text,
      },
    }
  }

  if (!part.source?.text) {
    return part
  }

  return {
    ...part,
    source: {
      ...part.source,
      text: {
        ...part.source.text,
        start,
        end,
        value: text,
      },
    },
  }
}
