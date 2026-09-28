// Retained streaming append logic for direct-mode scrollback.
//
// Static entries are rendered through `scrollback.writer.tsx`. This file only
// keeps the retained-surface machinery needed for streaming assistant,
// reasoning, and tool progress entries that need stable markdown/code layout
// while content is still arriving.
import {
  CodeRenderable,
  MarkdownRenderable,
  TextRenderable,
  getTreeSitterClient,
  type TreeSitterClient,
  type CliRenderer,
  type ScrollbackSurface,
} from "@opentui/core"
import { Effect, Option, Schema } from "effect"
import { entryBody, entryCanStream, entryDone, entryFlags } from "./entry.body"
import { entryColor, entryLook, entrySyntax } from "./scrollback.shared"
import { turnSummaryCommit } from "./turn-summary"
import { entryWriter, sameEntryGroup, separatorRows, spacerWriter, turnSummaryWriter } from "./scrollback.writer"
import { type RunTheme } from "./theme"
import type { RunDiffStyle, RunEntryBody, StreamCommit } from "./types"

type ActiveBody = Exclude<RunEntryBody, { type: "none" | "structured" }>

/** The retained surface did not settle its pending layout work. */
export class ScrollbackSettleError extends Schema.TaggedError<ScrollbackSettleError>()("ScrollbackSettleError", {
  cause: Schema.Defect(),
}) {}

function settle(surface: ScrollbackSurface) {
  return Effect.tryPromise({ try: () => surface.settle(), catch: (cause) => new ScrollbackSettleError({ cause }) })
}

type ActiveEntry = {
  body: ActiveBody
  commit: StreamCommit
  surface: ScrollbackSurface
  renderable: TextRenderable | CodeRenderable | MarkdownRenderable
  content: string
  committedRows: number
  committedBlocks: number
  pendingSpacerRows: number
  rendered: boolean
}

function commitMarkdownBlocks(input: {
  surface: ScrollbackSurface
  renderable: MarkdownRenderable
  startBlock: number
  endBlockExclusive: number
  trailingNewline: boolean
  beforeCommit?: () => void
}) {
  if (input.endBlockExclusive <= input.startBlock) {
    return false
  }

  const first = input.renderable._blockStates[input.startBlock]
  const last = input.renderable._blockStates[input.endBlockExclusive - 1]
  if (!first || !last) {
    return false
  }

  const next = input.renderable._blockStates[input.endBlockExclusive]
  const start = first.renderable.y
  const end = next ? next.renderable.y : last.renderable.y + last.renderable.height

  input.beforeCommit?.()
  input.surface.commitRows(start, end, {
    trailingNewline: input.trailingNewline,
  })
  return true
}

function staticBody(commit: StreamCommit, body: RunEntryBody, spaced: number): RunEntryBody {
  if (spaced === 0 || body.type !== "text") {
    return body
  }

  if (commit.kind !== "tool" || commit.phase !== "progress" || commit.toolState !== "completed") {
    return body
  }

  if (!body.content.startsWith("\n")) {
    return body
  }

  return {
    ...body,
    content: body.content.replace(/^\n/, ""),
  }
}

export class RunScrollbackStream {
  private tail: StreamCommit | undefined
  private rendered: StreamCommit | undefined
  private active: Option.Option<ActiveEntry> = Option.none()
  private diffStyle: RunDiffStyle | undefined
  private sessionID?: () => string | undefined
  private treeSitterClient: TreeSitterClient | undefined
  private wrote: boolean
  private pendingThemes: RunTheme[] = []

  constructor(
    private renderer: CliRenderer,
    private theme: RunTheme,
    options: {
      wrote?: boolean
      diffStyle?: RunDiffStyle
      sessionID?: () => string | undefined
      treeSitterClient?: TreeSitterClient
      onThemeRelease?: (theme: RunTheme) => void
    } = {},
  ) {
    this.diffStyle = options.diffStyle
    this.sessionID = options.sessionID
    this.treeSitterClient = options.treeSitterClient ?? getTreeSitterClient()
    this.wrote = options.wrote ?? false
    this.onThemeRelease = options.onThemeRelease
  }

  private onThemeRelease: ((theme: RunTheme) => void) | undefined

  private releasePendingThemes(): void {
    if (this.pendingThemes.length === 0) {
      return
    }

    for (const theme of this.pendingThemes.splice(0)) this.onThemeRelease?.(theme)
  }

  public setTheme(theme: RunTheme): void {
    if (this.theme === theme) {
      return
    }

    const previous = this.theme
    this.theme = theme
    if (Option.isNone(this.active)) {
      this.onThemeRelease?.(previous)
      return
    }

    const active = this.active.value
    this.pendingThemes.push(previous)

    const style = entryLook(active.commit, theme.entry)
    if (active.renderable instanceof TextRenderable) {
      active.renderable.fg = style.fg
      active.renderable.attributes = style.attrs ?? 0
      return
    }

    active.renderable.fg = entryColor(active.commit, theme)
    active.renderable.syntaxStyle = entrySyntax(active.commit, theme)
  }

  private createEntry(commit: StreamCommit, body: ActiveBody): ActiveEntry {
    const surface = this.renderer.createScrollbackSurface({
      startOnNewLine: entryFlags(commit).startOnNewLine,
    })
    const style = entryLook(commit, this.theme.entry)
    const renderable =
      body.type === "text"
        ? new TextRenderable(surface.renderContext, {
            content: "",
            width: "100%",
            wrapMode: "word",
            fg: style.fg,
            attributes: style.attrs,
          })
        : body.type === "code"
          ? new CodeRenderable(surface.renderContext, {
              content: "",
              filetype: body.filetype,
              syntaxStyle: entrySyntax(commit, this.theme),
              width: "100%",
              wrapMode: "word",
              drawUnstyledText: false,
              streaming: true,
              fg: entryColor(commit, this.theme),
              treeSitterClient: this.treeSitterClient,
            })
          : new MarkdownRenderable(surface.renderContext, {
              content: "",
              syntaxStyle: entrySyntax(commit, this.theme),
              width: "100%",
              streaming: true,
              internalBlockMode: "top-level",
              tableOptions: { widthMode: "content" },
              fg: entryColor(commit, this.theme),
              treeSitterClient: this.treeSitterClient,
            })

    surface.root.add(renderable)

    const rows = separatorRows(this.rendered, commit, body)

    return {
      body,
      commit,
      surface,
      renderable,
      content: "",
      committedRows: 0,
      committedBlocks: 0,
      pendingSpacerRows: rows || (!this.rendered && this.wrote ? 1 : 0),
      rendered: false,
    }
  }

  private markRendered(commit: Option.Option<StreamCommit>): void {
    if (Option.isSome(commit)) {
      this.rendered = commit.value
    }
  }

  private writeSpacer(rows: number): void {
    if (rows === 0) {
      return
    }

    this.renderer.writeToScrollback(spacerWriter())
    this.wrote = false
  }

  private flushPendingSpacer(active: ActiveEntry): void {
    this.writeSpacer(active.pendingSpacerRows)
    active.pendingSpacerRows = 0
  }

  private flushActive(done: boolean, trailingNewline: boolean): Effect.Effect<boolean, ScrollbackSettleError> {
    return Effect.gen({ self: this }, function* () {
      if (Option.isNone(this.active)) {
        return false
      }

      const active = this.active.value
      if (active.body.type === "text") {
        if (!(active.renderable instanceof TextRenderable)) {
          return false
        }

        const renderable = active.renderable
        renderable.content = active.content
        active.surface.render()
        this.releasePendingThemes()
        const targetRows = done ? active.surface.height : Math.max(active.committedRows, active.surface.height - 1)
        if (targetRows <= active.committedRows) {
          return false
        }

        this.flushPendingSpacer(active)
        active.surface.commitRows(active.committedRows, targetRows, {
          trailingNewline: done && targetRows === active.surface.height ? trailingNewline : false,
        })
        active.committedRows = targetRows
        active.rendered = true
        return true
      }

      if (active.body.type === "code") {
        if (!(active.renderable instanceof CodeRenderable)) {
          return false
        }

        const renderable = active.renderable
        renderable.content = active.content
        renderable.streaming = !done
        yield* settle(active.surface)
        this.releasePendingThemes()
        const targetRows = done ? active.surface.height : Math.max(active.committedRows, active.surface.height - 1)
        if (targetRows <= active.committedRows) {
          return false
        }

        this.flushPendingSpacer(active)
        active.surface.commitRows(active.committedRows, targetRows, {
          trailingNewline: done && targetRows === active.surface.height ? trailingNewline : false,
        })
        active.committedRows = targetRows
        active.rendered = true
        return true
      }

      if (!(active.renderable instanceof MarkdownRenderable)) {
        return false
      }

      const renderable = active.renderable
      renderable.content = active.content
      renderable.streaming = !done
      yield* settle(active.surface)
      this.releasePendingThemes()
      const targetBlockCount = done ? renderable._blockStates.length : renderable._stableBlockCount
      if (targetBlockCount <= active.committedBlocks) {
        return false
      }

      if (
        commitMarkdownBlocks({
          surface: active.surface,
          renderable,
          startBlock: active.committedBlocks,
          endBlockExclusive: targetBlockCount,
          trailingNewline: done && targetBlockCount === renderable._blockStates.length ? trailingNewline : false,
          beforeCommit: () => this.flushPendingSpacer(active),
        })
      ) {
        active.committedBlocks = targetBlockCount
        active.rendered = true
        return true
      }

      return false
    })
  }

  // Flushes the rest of the active entry, then always drops and destroys its
  // surface. The result is the entry commit when any of it reached scrollback.
  private finishActive(trailingNewline: boolean): Effect.Effect<Option.Option<StreamCommit>, ScrollbackSettleError> {
    return Effect.gen({ self: this }, function* () {
      if (Option.isNone(this.active)) {
        return Option.none<StreamCommit>()
      }

      const active = this.active.value
      yield* this.flushActive(true, trailingNewline).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (Option.exists(this.active, (current) => current === active)) {
              this.active = Option.none()
            }

            if (!active.surface.isDestroyed) {
              active.surface.destroy()
            }
            this.releasePendingThemes()
          }),
        ),
      )

      return active.rendered ? Option.some(active.commit) : Option.none<StreamCommit>()
    })
  }

  // Keeps the active entry when the commit continues it; else finishes it and
  // opens a new entry for the commit.
  private streamingEntry(commit: StreamCommit, body: ActiveBody): Effect.Effect<ActiveEntry, ScrollbackSettleError> {
    return Effect.gen({ self: this }, function* () {
      const current = this.active
      if (
        Option.isSome(current) &&
        sameEntryGroup(current.value.commit, commit) &&
        current.value.body.type === body.type
      ) {
        return current.value
      }

      this.markRendered(yield* this.finishActive(false))
      const next = this.createEntry(commit, body)
      this.active = Option.some(next)
      return next
    })
  }

  private writeStreaming(commit: StreamCommit, body: ActiveBody): Effect.Effect<void, ScrollbackSettleError> {
    return Effect.gen({ self: this }, function* () {
      const active = yield* this.streamingEntry(commit, body)
      active.body = body
      active.commit = commit
      active.content += body.content
      yield* this.flushActive(false, false)
      if (active.rendered) {
        this.markRendered(Option.some(active.commit))
      }
    })
  }

  private appendCommit(commit: StreamCommit): Effect.Effect<void, ScrollbackSettleError> {
    return Effect.gen({ self: this }, function* () {
      const same = sameEntryGroup(this.tail, commit)
      if (!same) {
        this.markRendered(yield* this.finishActive(false))
      }

      if (commit.summary) {
        this.writeSpacer(1)
        this.renderer.writeToScrollback(turnSummaryWriter({ ...commit.summary, theme: this.theme }))
        this.markRendered(Option.some(commit))
        this.tail = commit
        return
      }

      const body = entryBody(commit)
      if (body.type === "none") {
        if (entryDone(commit)) {
          this.markRendered(yield* this.finishActive(false))
        }

        this.tail = commit
        return
      }

      if (
        body.type !== "structured" &&
        (entryCanStream(commit, body) ||
          (commit.kind === "tool" && commit.phase === "final" && body.type === "markdown"))
      ) {
        yield* this.writeStreaming(commit, body)
        if (entryDone(commit)) {
          this.markRendered(yield* this.finishActive(false))
        }
        this.tail = commit
        return
      }

      if (same) {
        this.markRendered(yield* this.finishActive(false))
      }

      const rows = separatorRows(this.rendered, commit, body)
      const spaced = rows || (!this.rendered && this.wrote ? 1 : 0)
      this.writeSpacer(spaced)

      this.renderer.writeToScrollback(
        entryWriter({
          commit,
          body: staticBody(commit, body, spaced),
          theme: this.theme,
          opts: {
            diffStyle: this.diffStyle,
          },
        }),
      )
      this.markRendered(Option.some(commit))
      this.tail = commit
    })
  }

  // footer.ts runs these through its Promise-based callback queue, and the
  // tests await them, so the public methods run the Effects as Promises.
  public append(commit: StreamCommit): Promise<void> {
    return Effect.runPromise(this.appendCommit(commit))
  }

  private resetActive(): void {
    if (Option.isNone(this.active)) {
      return
    }

    if (!this.active.value.surface.isDestroyed) {
      this.active.value.surface.destroy()
    }

    this.active = Option.none()
    this.releasePendingThemes()
  }

  public complete(trailingNewline = false): Promise<void> {
    return Effect.runPromise(this.finishActive(trailingNewline).pipe(Effect.map((commit) => this.markRendered(commit))))
  }

  public writeTurnSummary(input: { agent: string; model: string; duration: string }): Promise<void> {
    return Effect.runPromise(this.appendCommit(turnSummaryCommit(input)))
  }

  public destroy(): void {
    this.resetActive()
    this.releasePendingThemes()
  }
}
