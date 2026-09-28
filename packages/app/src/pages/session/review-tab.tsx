import { createEffect, onCleanup, type JSX } from "solid-js"
import { Data, Effect, Option } from "effect"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { SessionReview } from "@opencode-ai/session-ui/session-review"
import type {
  SessionReviewCommentActions,
  SessionReviewCommentDelete,
  SessionReviewCommentUpdate,
  SessionReviewFocus,
} from "@opencode-ai/session-ui/session-review"
import type { SelectedLineRange } from "@/context/file"
import { useSDK } from "@/context/sdk"
import { useLayout } from "@/context/layout"
import type { LineComment } from "@/context/comments"

export type DiffStyle = "unified" | "split"

class ReviewFileReadError extends Data.TaggedError("SessionReviewTab.FileReadError")<{ readonly cause: unknown }> {}

type ReviewDiff = FileDiffInfo | SnapshotFileDiff | VcsFileDiff

export interface SessionReviewTabProps {
  title?: JSX.Element
  empty?: JSX.Element
  diffs: () => ReviewDiff[]
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  diffStyle: DiffStyle
  onDiffStyleChange?: (style: DiffStyle) => void
  onViewFile?: (file: string) => void
  onLineComment?: (comment: { file: string; selection: SelectedLineRange; comment: string; preview?: string }) => void
  onLineCommentUpdate?: (comment: SessionReviewCommentUpdate) => void
  onLineCommentDelete?: (comment: SessionReviewCommentDelete) => void
  lineCommentActions?: SessionReviewCommentActions
  comments?: LineComment[]
  focusedComment?: { file: string; id: string } | null
  onFocusedCommentChange?: (focus: Option.Option<SessionReviewFocus>) => void
  focusedFile?: string
  onScrollRef?: (el: Option.Option<HTMLDivElement>) => void
  commentMentions?: {
    items: (query: string) => string[] | Promise<string[]>
  }
  classes?: {
    root?: string
    header?: string
    container?: string
  }
}

export function SessionReviewTab(props: SessionReviewTabProps) {
  let scroll: HTMLDivElement | undefined
  let restoreFrame = Option.none<number>()
  let userInteracted = false
  let restored = Option.none<{ x: number; y: number }>()

  const sdk = useSDK()
  const layout = useLayout()

  const readFile = (path: string) =>
    Effect.runPromise(
      Effect.tryPromise({
        try: () => sdk().client.file.read({ path }),
        catch: (cause) => new ReviewFileReadError({ cause }),
      }).pipe(
        Effect.map((x) => Option.fromNullishOr(x.data)),
        Effect.catch((error) =>
          Effect.logDebug("[session-review] failed to read file", { path, error: error.cause }).pipe(
            Effect.as(Option.none()),
          ),
        ),
        Effect.map(Option.getOrUndefined),
      ),
    )

  const handleInteraction = () => {
    userInteracted = true

    if (Option.isSome(restoreFrame)) {
      cancelAnimationFrame(restoreFrame.value)
      restoreFrame = Option.none()
    }
  }

  const doRestore = () => {
    restoreFrame = Option.none()
    const el = scroll
    if (!el || !layout.ready() || userInteracted) return
    if (el.clientHeight === 0 || el.clientWidth === 0) return

    const s = props.view().scroll("review")
    if (!s || (s.x === 0 && s.y === 0)) return

    const maxY = Math.max(0, el.scrollHeight - el.clientHeight)
    const maxX = Math.max(0, el.scrollWidth - el.clientWidth)

    const targetY = Math.min(s.y, maxY)
    const targetX = Math.min(s.x, maxX)

    if (el.scrollTop === targetY && el.scrollLeft === targetX) return

    if (el.scrollTop !== targetY) el.scrollTop = targetY
    if (el.scrollLeft !== targetX) el.scrollLeft = targetX
    restored = Option.some({ x: el.scrollLeft, y: el.scrollTop })
  }

  const queueRestore = () => {
    if (userInteracted || Option.isSome(restoreFrame)) return
    restoreFrame = Option.some(requestAnimationFrame(doRestore))
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    const el = event.currentTarget
    const prev = restored
    restored = Option.none()
    if (Option.isSome(prev) && el.scrollTop === prev.value.y && el.scrollLeft === prev.value.x) return

    handleInteraction()
    if (!layout.ready()) return
    if (el.clientHeight === 0 || el.clientWidth === 0) return

    props.view().setScroll("review", {
      x: el.scrollLeft,
      y: el.scrollTop,
    })
  }

  createEffect(() => {
    props.diffs().length
    props.diffStyle
    if (!layout.ready()) return
    queueRestore()
  })

  onCleanup(() => {
    if (Option.isSome(restoreFrame)) cancelAnimationFrame(restoreFrame.value)
    props.onScrollRef?.(Option.none())
  })

  return (
    <SessionReview
      title={props.title}
      empty={props.empty}
      scrollRef={(el) => {
        scroll = el
        makeEventListener(el, "wheel", handleInteraction, { passive: true, capture: true })
        makeEventListener(el, "mousewheel", handleInteraction, { passive: true, capture: true })
        makeEventListener(el, "pointerdown", handleInteraction, { passive: true, capture: true })
        makeEventListener(el, "touchstart", handleInteraction, { passive: true, capture: true })
        makeEventListener(el, "keydown", handleInteraction, { capture: true })
        props.onScrollRef?.(Option.some(el))
        queueRestore()
      }}
      onScroll={handleScroll}
      onDiffRendered={queueRestore}
      open={props.view().review.open()}
      onOpenChange={(open) => props.view().review.setOpen(open)}
      classes={{
        root: props.classes?.root ?? "pr-3",
        header: props.classes?.header ?? "px-3",
        container: props.classes?.container ?? "pl-3",
      }}
      diffs={props.diffs()}
      diffStyle={props.diffStyle}
      onDiffStyleChange={props.onDiffStyleChange}
      onViewFile={props.onViewFile}
      focusedFile={props.focusedFile}
      readFile={readFile}
      onLineComment={props.onLineComment}
      onLineCommentUpdate={props.onLineCommentUpdate}
      onLineCommentDelete={props.onLineCommentDelete}
      lineCommentActions={props.lineCommentActions}
      lineCommentMention={props.commentMentions}
      comments={props.comments}
      focusedComment={props.focusedComment}
      onFocusedCommentChange={props.onFocusedCommentChange}
    />
  )
}
