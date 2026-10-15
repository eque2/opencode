// The full-screen frame of designs 3 (Board), 4 (Matrix) and 5 (Gantt): one plugin route, which is how these designs
// expand. It always shows the selected task's details beside or under the design.
import type { ScrollBoxRenderable } from "@opentui/core"
import { Option } from "effect"
import { For, Match, Show, Switch, createEffect, onCleanup } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Peek } from "../peek"
import { SharedRegion, outsideCollapsed, pageBy, regionRows, wrap } from "../shared"
import { DESIGNS, OLDER_LINE, bar, costText, counts, cut, older, runUsage, tokensText } from "../store"
import {
  Brand,
  OlderLine,
  ReasonLine,
  TrustedCount,
  WarningLines,
  moving,
  reasonLine,
  refused,
  stoppedText,
  trustedText,
  runText,
  runTitle,
  type Ctx,
  type ViewProps,
} from "../ui"
import type { View } from "../view"
import { BoardView, boardRows } from "./3-board"
import { MatrixView, matrixRows } from "./4-matrix"
import { GanttView, ganttRows } from "./5-gantt"

export const ROUTE = "task-ui"

/** The designs with a full-screen view, and where each shows the task details. */
export const SCREENS: Record<number, "right" | "bottom"> = { 3: "right", 4: "bottom", 5: "bottom" }

const PEEK_RIGHT = 56

/** From this width the Board's right pane, the Peek then the region, sits beside the board (UI22). */
const BESIDE_BOARD = 149

/** From this width, under the Board, the Peek (half the width, at most 72 cells) and the region sit side by side. */
const SIDE_BY_SIDE = 110
const PEEK_HALF = 72

/** The fewest rows the shared region keeps (UI22). */
export const REGION_MIN = 8

/** The rows each full-screen design takes at a width. */
const DESIGN_ROWS: Record<number, (view: View, width: number) => number> = {
  3: boardRows,
  4: matrixRows,
  5: ganttRows,
}

/** The Peek's rows with `lines` activity lines: its border, three headings, and up to `lines` lines under each. */
const peekRows = (lines: number) => 5 + 3 * lines

export function Screen(props: ViewProps & { width: number; height: number; onScroll?: (box: ScrollBoxRenderable) => void }) {
  const name = () => DESIGNS.find((design) => design.id === props.view.design())?.name ?? ""
  // The header's title and run state take what the mark, the name and the counts leave; the title is cut with …
  // (EXPERIENCE "Run header"), the counts never.
  const titleRoom = () => {
    const status = props.view.status()
    if (!status) return 0
    const counts = 10 + 1 + trustedText(status).length + stoppedText(status).length
    // The row's four 1-cell gaps: after the mark, after the name, and on both sides of the spacer before the counts.
    return Math.max(8, props.width - 2 - "◆ In the Flow".length - name().length - counts - 4)
  }
  // The run usage before the trusted bar (EXPERIENCE "Run usage"): the tokens drop first, then the cost, before the
  // title is cut. Each part costs its text and the row's gap before it.
  const usage = () => {
    const status = props.view.status()
    if (!status) return ""
    const title = `${runTitle(status)} · ${runText(status)}`.length
    return Option.match(runUsage(props.sessions.all()()), {
      onNone: () => "",
      onSome: (spent) =>
        [`${tokensText(spent.tokens)} · ${costText(spent.cost)}`, costText(spent.cost)].find(
          (text) => title + 1 + text.length <= titleRoom(),
        ) ?? "",
    })
  }
  const inner = () => props.width - 2
  // Where the Peek and the region go: the Board's right pane, split under the Board, or stacked under the design.
  const layout = () =>
    SCREENS[props.view.design()] !== "right" || !props.view.selected()
      ? "stack"
      : props.width >= BESIDE_BOARD
        ? "right"
        : props.width >= SIDE_BY_SIDE
          ? "split"
          : "stack"
  const body = () => Math.max(20, inner() - (layout() === "right" ? PEEK_RIGHT + 1 : 0))
  const peekWidth = () =>
    layout() === "right" ? PEEK_RIGHT : layout() === "split" ? Math.min(PEEK_HALF, Math.floor(inner() / 2)) : inner()
  const regionWidth = () =>
    layout() === "right" ? PEEK_RIGHT : layout() === "split" ? inner() - peekWidth() - 1 : inner()
  // The rows left for the design, the Peek and the shared region: less the header, the reason, the gap and the keys.
  // The header's lines under its first: the older-status line, the run warning, the outside wait and the reason.
  const headerLines = () => {
    const status = props.view.status()
    if (!status) return 0
    return (
      (older(status) ? wrap(OLDER_LINE, inner()).length : 0) +
      (status.run.warning ? 1 : 0) +
      wrap(outsideCollapsed(status), inner()).length +
      (Option.isSome(reasonLine(status)) ? 1 : 0)
    )
  }
  const room = () => props.height - 3 - headerLines()
  const region = () => {
    const status = props.view.status()
    return status ? Math.max(REGION_MIN, Math.min(regionRows(status, regionWidth()), Math.floor(room() / 2))) : REGION_MIN
  }
  // When the design, the Peek and the region are taller than the terminal, the Peek's activity lines shrink first,
  // to one line for each section (EXPERIENCE "Shared region" → Height). The design is cut, never drawn over the Peek.
  const lines = () => {
    const full = layout() === "right" ? 8 : 4
    const design = DESIGN_ROWS[props.view.design()]?.(props.view, body()) ?? 0
    const peek = props.view.selected() ? peekRows(full) : 0
    const tall =
      layout() === "right"
        ? Math.max(design, peek + region())
        : layout() === "split"
          ? design + 1 + Math.max(peek, region())
          : design + 1 + peek + 1 + region()
    return 1 + tall > room() ? 1 : full
  }
  const peek = () => (
    <Show when={props.view.selected()} keyed>
      {(unit) => (
        <Peek
          theme={props.theme}
          view={props.view}
          sessions={props.sessions}
          unit={unit}
          width={peekWidth()}
          lines={lines()}
        />
      )}
    </Show>
  )
  const shared = () => (
    <SharedRegion theme={props.theme} view={props.view} width={regionWidth()} height={region()} onScroll={props.onScroll} />
  )
  return (
    <box flexDirection="column" width={props.width} height={props.height} paddingLeft={1} paddingRight={1}>
      <Show when={props.view.status()} fallback={<text fg={props.theme().textMuted}>No task run in this directory.</text>}>
        {(status) => (
          <>
            <box flexDirection="row" gap={1} flexShrink={0}>
              <Brand theme={props.theme} moving={moving(props)} />
              <text fg={props.theme().text} wrapMode="none">
                <b>{name()}</b>
              </text>
              <text fg={props.theme().textMuted} wrapMode="none">
                {cut(`${runTitle(status())} · ${runText(status())}`, titleRoom() - (usage() ? usage().length + 1 : 0))}
              </text>
              <box flexGrow={1} />
              <Show when={usage()}>
                <text fg={props.theme().textMuted} wrapMode="none">
                  {usage()}
                </text>
              </Show>
              <TrustedCount
                theme={props.theme}
                status={status()}
                bar={bar(counts(status()).trusted, counts(status()).total, 10)}
              />
            </box>
            <OlderLine theme={props.theme} status={status()} width={inner()} />
            <WarningLines theme={props.theme} status={status()} width={inner()} />
            <ReasonLine theme={props.theme} status={status()} width={inner()} />
            <box flexDirection={layout() === "right" ? "row" : "column"} flexGrow={1} flexShrink={1} gap={1} marginTop={1}>
              <box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
                <Switch
                  fallback={
                    <text fg={props.theme().textMuted}>{`Design ${props.view.design()} has no full-screen view.`}</text>
                  }
                >
                  {/* A refused run has no tasks to draw: the body says so, with every reason line (UI17). */}
                  <Match when={refused(status())}>
                    <text fg={props.theme().text} wrapMode="none">
                      No work started: the spec was refused.
                    </text>
                    <For each={(status().run.reason ?? "").split("\n").filter(Boolean)}>
                      {(line) => (
                        <text fg={props.theme().error} wrapMode="none">
                          {cut(line, body())}
                        </text>
                      )}
                    </For>
                  </Match>
                  <Match when={props.view.design() === 3}>
                    <BoardView {...props} width={body()} />
                  </Match>
                  <Match when={props.view.design() === 4}>
                    <MatrixView {...props} width={body()} />
                  </Match>
                  <Match when={props.view.design() === 5}>
                    <GanttView {...props} width={body()} />
                  </Match>
                </Switch>
              </box>
              <Switch>
                <Match when={layout() === "right"}>
                  <box flexDirection="column" width={PEEK_RIGHT} flexShrink={0}>
                    {peek()}
                    {shared()}
                  </box>
                </Match>
                <Match when={layout() === "split"}>
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    {peek()}
                    {shared()}
                  </box>
                </Match>
                {/* Stacked: the Board's Peek then the region; the Matrix and the Gantt keep the Peek at the bottom. */}
                <Match when={SCREENS[props.view.design()] === "right"}>
                  {peek()}
                  {shared()}
                </Match>
                <Match when={true}>
                  {shared()}
                  {peek()}
                </Match>
              </Switch>
            </box>
            <text fg={props.theme().textMuted} wrapMode="none" flexShrink={0}>
              {`j/k select task · v next design · pgup/pgdn scroll · ${props.leader} w ${props.view.watching() ? "stop watching" : "watch"} · esc collapse`}
            </text>
          </>
        )}
      </Show>
    </box>
  )
}

export function registerScreen(ctx: Ctx) {
  // The full-screen view is how designs 3–5 expand: expanding opens it, collapsing (or switching to a design without
  // one) returns to the session it was opened from.
  createEffect(() => {
    const open = ctx.api.route.current.name === ROUTE
    const wanted = Boolean(SCREENS[ctx.view.design()]) && ctx.view.expanded()
    if (wanted && !open) return ctx.api.route.navigate(ROUTE, { sessionID: ctx.root() })
    if (wanted || !open) return
    if (ctx.root()) return ctx.api.route.navigate("session", { sessionID: ctx.root() })
    ctx.api.route.navigate("home")
  })

  ctx.api.route.register([
    {
      name: ROUTE,
      render: () => {
        const dimensions = useTerminalDimensions()
        // The shared region's scroll box, for pageup and pagedown.
        let region: ScrollBoxRenderable | undefined
        const page = (by: 1 | -1) => () => pageBy(region, by)
        const dispose = ctx.api.keymap.registerLayer({
          commands: [
            { name: "task_ui.screen.collapse", run: () => ctx.view.setExpanded(false) },
            { name: "task_ui.screen.next", run: ctx.view.next },
            { name: "task_ui.screen.previous", run: ctx.view.previous },
            { name: "task_ui.screen.design", run: ctx.view.cycleDesign },
            { name: "task_ui.screen.page_down", run: page(1) },
            { name: "task_ui.screen.page_up", run: page(-1) },
          ],
          bindings: [
            { key: "escape,q", cmd: "task_ui.screen.collapse", desc: "Collapse to the session" },
            { key: "j,down", cmd: "task_ui.screen.next", desc: "Select the next task" },
            { key: "k,up", cmd: "task_ui.screen.previous", desc: "Select the previous task" },
            { key: "v", cmd: "task_ui.screen.design", desc: "Switch to the next task design" },
            { key: "pagedown", cmd: "task_ui.screen.page_down", desc: "Scroll the shared region down" },
            { key: "pageup", cmd: "task_ui.screen.page_up", desc: "Scroll the shared region up" },
          ],
        })
        onCleanup(dispose)
        return (
          <Screen
            theme={ctx.theme}
            view={ctx.view}
            sessions={ctx.sessions}
            leader={ctx.leader}
            motion={ctx.motion}
            width={dimensions().width}
            height={dimensions().height}
            onScroll={(box) => (region = box)}
          />
        )
      },
    },
  ])

}
