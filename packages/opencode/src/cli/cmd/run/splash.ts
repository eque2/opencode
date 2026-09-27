// Entry and exit splash banners for direct interactive mode scrollback.
//
// Renders the full opencode entry logo and a compact [O] exit badge, plus
// session metadata and the resume command. These are scrollback snapshots, so
// they become immutable terminal history once committed.
//
// Both variants use a cell-based renderer. cells() classifies each character
// in the source template as text, full-block, half-block-mix, or
// half-block-top, and draw() renders it with foreground/background shadow
// colors from the theme.
import {
  BoxRenderable,
  type ColorInput,
  TextAttributes,
  TextRenderable,
  type ScrollbackRenderContext,
  type ScrollbackSnapshot,
  type ScrollbackWriter,
} from "@opentui/core"
import { Option } from "effect"
import * as Locale from "@/util/locale"
import { go } from "@/cli/logo"
import type { RunSplashTheme } from "./theme"

export const SPLASH_TITLE_LIMIT = 50
export const SPLASH_TITLE_FALLBACK = "Untitled session"

type SplashInput = {
  title: string | undefined
  session_id: string
}

type SplashWriterInput = SplashInput & {
  theme: RunSplashTheme
  showSession?: boolean
  detail?: string
}

export type SplashMeta = {
  title: string
  session_id: string
}

type Cell = {
  char: string
  mark: "text" | "full" | "mix" | "top"
}

type Line = {
  left: number
  top: number
  text: string
  fg: ColorInput
  bg: Option.Option<ColorInput>
  attrs: Option.Option<number>
}

function cells(line: string): Cell[] {
  return Array.from(line, (char): Cell => {
    if (char === "_") {
      return { char: " ", mark: "full" }
    }

    if (char === "^") {
      return { char: "▀", mark: "mix" }
    }

    if (char === "~") {
      return { char: "▀", mark: "top" }
    }

    return { char, mark: "text" }
  })
}

function title(text: string | undefined): string {
  if (!text) {
    return SPLASH_TITLE_FALLBACK
  }

  let value = ""
  let gap = false
  for (const char of text.trim()) {
    if (char === " " || char === "\n" || char === "\r" || char === "\t") {
      gap = true
      continue
    }

    if (gap && value.length > 0) {
      value += " "
    }

    value += char
    gap = false
  }

  if (!value) {
    return SPLASH_TITLE_FALLBACK
  }

  return Locale.truncate(value, SPLASH_TITLE_LIMIT)
}

// The opentui renderable options mark a missing background or attribute set
// as undefined, so the Options open here.
function write(root: BoxRenderable, ctx: ScrollbackRenderContext, line: Line): void {
  if (line.left >= ctx.width) {
    return
  }

  root.add(
    new TextRenderable(ctx.renderContext, {
      position: "absolute",
      left: line.left,
      top: line.top,
      width: Math.max(1, ctx.width - line.left),
      height: 1,
      wrapMode: "none",
      content: line.text,
      fg: line.fg,
      bg: Option.getOrUndefined(line.bg),
      attributes: Option.getOrUndefined(line.attrs),
    }),
  )
}

function draw(
  row: string,
  input: {
    left: number
    top: number
    fg: ColorInput
    shadow: ColorInput
  },
): Line[] {
  // Each cell takes one column.
  return cells(row).map((cell, index): Line => {
    const left = input.left + index
    if (cell.mark === "full" || cell.mark === "mix") {
      return {
        left,
        top: input.top,
        text: cell.char,
        fg: input.fg,
        bg: Option.some(input.shadow),
        attrs: Option.none(),
      }
    }

    if (cell.mark === "top") {
      return { left, top: input.top, text: cell.char, fg: input.shadow, bg: Option.none(), attrs: Option.none() }
    }

    return { left, top: input.top, text: cell.char, fg: input.fg, bg: Option.none(), attrs: Option.none() }
  })
}

function text(left: number, top: number, content: string, fg: ColorInput, attrs: Option.Option<number>): Line {
  return { left, top, text: content, fg, bg: Option.none(), attrs }
}

function build(input: SplashWriterInput, kind: "entry" | "exit", ctx: ScrollbackRenderContext): ScrollbackSnapshot {
  const width = Math.max(1, ctx.width)
  const meta = splashMeta(input)
  const left = input.theme.left
  const mark = go.right.slice(1)
  const top = 1
  const body_left = (mark[0]?.length ?? 0) + 2
  const height = top + mark.length
  const logo = mark.flatMap((row, index) =>
    draw(row, {
      left: 0,
      top: top + index,
      fg: left,
      shadow: input.theme.leftShadow,
    }),
  )

  const lines =
    kind === "entry"
      ? [...logo, ...entryBody(input, body_left, top, width)]
      : [...logo, ...exitBody(input, meta, body_left, top)]

  const root = new BoxRenderable(ctx.renderContext, {
    position: "absolute",
    left: 0,
    top: 0,
    width,
    height,
  })

  for (const line of lines) {
    write(root, ctx, line)
  }

  return {
    root,
    width,
    height,
    rowColumns: width,
    startOnNewLine: true,
    trailingNewline: false,
  }
}

function entryBody(input: SplashWriterInput, body_left: number, top: number, width: number): Line[] {
  const head = text(body_left, top, "OpenCode", input.theme.right, Option.some(TextAttributes.BOLD))
  if (!input.detail) {
    return [head]
  }

  return [
    head,
    text(
      body_left,
      top + 1,
      Locale.truncateMiddle(input.detail, Math.max(1, width - body_left)),
      input.theme.left,
      Option.none(),
    ),
  ]
}

function exitBody(input: SplashWriterInput, meta: SplashMeta, body_left: number, top: number): Line[] {
  const session = "Session  "
  const label = "Continue "
  const dim = Option.some(TextAttributes.DIM)
  const bold = Option.some(TextAttributes.BOLD)
  const resume = [
    text(body_left, top + 1, label, input.theme.left, dim),
    text(body_left + label.length, top + 1, `opencode --mini -s ${meta.session_id}`, input.theme.right, bold),
  ]
  if (input.showSession === false) {
    return resume
  }

  return [
    text(body_left, top, session, input.theme.left, dim),
    text(body_left + session.length, top, meta.title, input.theme.right, bold),
    ...resume,
  ]
}

export function splashMeta(input: SplashInput): SplashMeta {
  return {
    title: title(input.title),
    session_id: input.session_id,
  }
}

export function entrySplash(input: SplashWriterInput): ScrollbackWriter {
  return (ctx) => build(input, "entry", ctx)
}

export function exitSplash(input: SplashWriterInput): ScrollbackWriter {
  return (ctx) => build(input, "exit", ctx)
}
