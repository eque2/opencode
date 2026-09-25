import { Option } from "effect"
import { marked, type Token, type Tokens } from "marked"
import remend from "remend"
import { completedProjection } from "./markdown-projection"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live" | "code"
  language?: string
  complete?: boolean
}

export type Projection = {
  text: string
  blocks: Block[]
}

function refs(text: string) {
  if (!text.includes("]:")) return false
  return /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:\S+|\r?\n[ \t]+\S+)/m.test(text)
}

// A fence without a language leaves the key out of the block.
function language(value: string | undefined): Pick<Block, "language"> {
  const name = value?.trim().split(/\s+/, 1)[0]
  return name ? { language: name } : {}
}

function openCode(raw: string) {
  const newline = raw.indexOf("\n")
  return newline < 0 ? "" : raw.slice(newline + 1)
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return false
  const mark = match[1]
  if (!mark) return false
  const char = mark[0]
  const size = mark.length
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? ""
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

function closesFence(raw: string, suffix: string) {
  const mark = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1]
  if (!mark) return suffix.includes("```") || suffix.includes("~~~")
  return `${raw.slice(-(mark.length - 1))}${suffix}`.includes(mark)
}

// marked's Token union also has a Generic member with a string `type`, so the type check alone
// does not narrow to Tokens.Code. The text check confirms the field that the code path reads.
function isCodeToken(token: Token): token is Tokens.Code {
  return token.type === "code" && typeof token.text === "string"
}

function heal(text: string) {
  return remend(text, { linkMode: "text-only" })
}

export function stream(text: string, live: boolean): Block[] {
  if (!live) return completedProjection(text).blocks
  if (refs(text)) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  const tokens = marked.lexer(text)
  const tail = tokens.findLastIndex((token) => token.type !== "space")
  if (tail < 0) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  const last = tokens[tail]
  if (!last) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]

  const result: Block[] = []
  for (let index = 0; index < tail; index++) {
    const token = tokens[index]
    if (!token || token.type === "space") continue
    let raw = token.raw
    while (tokens[index + 1]?.type === "space" && index + 1 < tail) raw += tokens[++index]!.raw
    if (isCodeToken(token)) {
      result.push({ raw, src: token.text, mode: "code", ...language(token.lang), complete: true })
      continue
    }
    result.push({ raw, src: raw, mode: "full" })
  }

  const raw = tokens
    .slice(tail)
    .map((token) => token.raw)
    .join("")
  if (!isCodeToken(last)) return [...result, { raw, src: heal(raw), mode: "live" }]

  if (!open(last.raw)) return [...result, { raw, src: last.text, mode: "code", ...language(last.lang), complete: true }]
  return [...result, { raw, src: openCode(last.raw), mode: "code", ...language(last.lang) }]
}

export function project(previous: Option.Option<Projection>, text: string, live: boolean): Projection {
  if (!live) {
    const current = Option.flatMap(previous, (value) => {
      if (value.text === text) return Option.some(value)
      if (text.startsWith(value.text)) return Option.some(project(previous, text, true))
      return Option.none()
    })
    if (Option.isNone(current)) return completedProjection(text)
    return {
      text,
      blocks: current.value.blocks.map((block) => {
        if (block.mode === "live") return { raw: block.raw, src: block.raw, mode: "full" }
        if (block.mode === "code" && !block.complete) return { ...block, complete: true }
        return block
      }),
    }
  }
  if (Option.isNone(previous) || !text.startsWith(previous.value.text)) return { text, blocks: stream(text, live) }
  const tail = previous.value.blocks.at(-1)
  const suffix = text.slice(previous.value.text.length)
  if (!suffix || tail?.mode !== "code" || tail.complete || closesFence(tail.raw, suffix))
    return { text, blocks: stream(text, live) }
  return {
    text,
    blocks: [
      ...previous.value.blocks.slice(0, -1),
      {
        ...tail,
        raw: tail.raw + suffix,
        src: tail.src + suffix,
      },
    ],
  }
}
