// The full-screen frame of designs 3 (Board), 4 (Matrix) and 5 (Gantt): one plugin route, which is how these designs
// expand. It always shows the selected task's details beside or under the design.
import type { ScrollBoxRenderable } from "@opentui/core"
import { Match, Show, Switch, createEffect, onCleanup } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Peek } from "../peek"
import { SharedRegion, pageBy, regionRows } from "../shared"
import { DESIGNS, bar, counts, cut, tone } from "../store"
import { Brand, runText, trustedText, type Ctx, type ViewProps } from "../ui"
import type { View } from "../view"
import { BoardView, boardRows } from "./3-board"
import { MatrixView, matrixRows } from "./4-matrix"
import { GanttView, ganttRows } from "./5-gantt"

export const ROUTE = "task-ui"

/** The designs with a full-screen view, and where each shows the task details. */
export const SCREENS: Record<number, "right" | "bottom"> = { 3: "right", 4: "bottom", 5: "bottom" }

const PEEK_RIGHT = 56

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
  const right = () => SCREENS[props.view.design()] === "right" && Boolean(props.view.selected())
  const body = () => Math.max(20, props.width - 2 - (right() ? PEEK_RIGHT + 1 : 0))
  // The rows left for the design, the Peek and the shared region: less the header, the reason, the gap and the keys.
  const room = () => {
    const status = props.view.status()
    return props.height - 3 - (status?.run.reason && tone(status.run.state) !== "good" ? 1 : 0)
  }
  const region = () => {
    const status = props.view.status()
    return status ? Math.max(REGION_MIN, Math.min(regionRows(status, props.width - 2), Math.floor(room() / 2))) : REGION_MIN
  }
  // When the design, the Peek and the region are taller than the terminal, the Peek's activity lines shrink first,
  // to one line for each section (EXPERIENCE "Shared region" → Height). The design is cut, never drawn over the Peek.
  const lines = () => {
    const full = right() ? 8 : 4
    const design = DESIGN_ROWS[props.view.design()]?.(props.view, body()) ?? 0
    const tall = right() ? Math.max(design, peekRows(full)) : design + 1 + peekRows(full)
    return 1 + tall + region() > room() ? 1 : full
  }
  return (
    <box flexDirection="column" width={props.width} height={props.height} paddingLeft={1} paddingRight={1}>
      <Show when={props.view.status()} fallback={<text fg={props.theme().textMuted}>No task run in this directory.</text>}>
        {(status) => (
          <>
            <box flexDirection="row" gap={1} flexShrink={0}>
              <text wrapMode="none">
                <Brand theme={props.theme} />
              </text>
              <text fg={props.theme().text} wrapMode="none">
                <b>{name()}</b>
              </text>
              <text fg={props.theme().textMuted} wrapMode="none">
                {`${status().run.spec.split("/").at(-1)} · ${runText(status())}`}
              </text>
              <box flexGrow={1} />
              <text fg={props.theme().success} wrapMode="none">
                {`${bar(counts(status()).trusted, counts(status()).total, 10)} ${trustedText(status())}`}
              </text>
            </box>
            <Show when={status().run.reason && tone(status().run.state) !== "good"}>
              <text fg={props.theme().error} wrapMode="none" flexShrink={0}>
                {cut(status().run.reason ?? "", props.width - 2)}
              </text>
            </Show>
            <box flexDirection={SCREENS[props.view.design()] === "right" ? "row" : "column"} flexGrow={1} flexShrink={1} gap={1} marginTop={1}>
              <box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
                <Switch
                  fallback={
                    <text fg={props.theme().textMuted}>{`Design ${props.view.design()} has no full-screen view.`}</text>
                  }
                >
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
              <Show when={props.view.selected()} keyed>
                {(unit) => (
                  <Peek
                    theme={props.theme}
                    view={props.view}
                    sessions={props.sessions}
                    unit={unit}
                    width={right() ? PEEK_RIGHT : props.width - 2}
                    lines={lines()}
                  />
                )}
              </Show>
            </box>
            <SharedRegion theme={props.theme} view={props.view} width={props.width - 2} height={region()} onScroll={props.onScroll} />
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
            width={dimensions().width}
            height={dimensions().height}
            onScroll={(box) => (region = box)}
          />
        )
      },
    },
  ])

}
