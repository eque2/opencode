// Design 7, Ticker: the quietest. Its line is the status part of the shortcut bar beside the prompt; it adds a toast
// when a task changes state, a notification when the run ends, and expands to a dialog over the session.
import type { ScrollBoxRenderable } from "@opentui/core"
import { Option } from "effect"
import { For, Show, createEffect, on, onCleanup } from "solid-js"
import { Peek } from "../peek"
import { SharedRegion, pageBy } from "../shared"
import { MARK, NAME, label, tagged, tone, type Status } from "../store"
import { Brand, OlderLine, TaskLine, reasonLine, type Ctx, type ViewProps } from "../ui"

const LIST = 30
const PEEK = 72
/** The rows the dialog gives the shared region; pageup and pagedown scroll it. */
const REGION = 12

/** The state changes between two snapshots: the run's, then each task's, as `T1.4 building → proving`. */
export const changes = (before: Status, after: Status) => [
  ...(before.run.state === after.run.state ? [] : [{ unit: "run", from: before.run.state, to: after.run.state }]),
  ...Object.entries(after.tasks).flatMap(([id, task]) =>
    before.tasks[id]?.state === task.state ? [] : [{ unit: id, from: before.tasks[id]?.state, to: task.state }],
  ),
]

const variantOf = (state: string): "success" | "error" | "warning" | "info" => {
  const value = tone(state)
  return value === "good" ? "success" : value === "bad" ? "error" : value === "warn" ? "warning" : "info"
}

/**
 * The toasts for one change, at most three (EXPERIENCE "Ticker toast"): the run's change, then each task's, a task
 * before the tasks it blocks. A task that gains `dead` or `blocked` shows its reason in place of "from → to".
 */
export const tickerToasts = (before: Status, after: Status) => {
  // How deep a task sits in a chain of blocks: a blocker ranks before what it blocks.
  const rank = (id: string, seen: ReadonlyArray<string> = []): number => {
    const by = after.tasks[id]?.blockedBy?.id
    return by && !seen.includes(by) ? rank(by, [...seen, id]) + 1 : 0
  }
  const list = changes(before, after)
  const run = list.filter((change) => change.unit === "run")
  const tasks = list.filter((change) => change.unit !== "run").toSorted((a, b) => rank(a.unit) - rank(b.unit))
  return [...run, ...tasks].slice(0, 3).map((change) => {
    const task = change.unit === "run" ? undefined : after.tasks[change.unit]
    const was = change.unit === "run" ? undefined : before.tasks[change.unit]
    const gained = task && task.reason && ["dead", "blocked"].some((tag) => tagged(task, tag) && !(was && tagged(was, tag)))
    return {
      variant: variantOf(change.to),
      message: gained
        ? `${change.unit} ${task.reason}`
        : `${change.unit} ${change.from ? `${label(change.from)} → ` : ""}${label(change.to)}`,
    }
  })
}

/**
 * The end-of-run notification when the run gains the `ended` tag, with the run reason line of a stopped run; a done
 * run that ends with a "not run" line raises none (AD-16, UI19).
 */
export const endNotice = (before: Status, after: Status) => {
  if (!tagged(after.run, "ended") || tagged(before.run, "ended")) return Option.none<string>()
  const stopped = tagged(after.run, "stopped")
  const line = reasonLine(after)
  if (!stopped && Option.isSome(line)) return Option.none<string>()
  return Option.some(
    `Run ${label(after.run.state)}${stopped && Option.isSome(line) ? `: ${line.value.text}` : ""}`,
  )
}

export function TickerDialog(props: ViewProps & { onScroll?: (box: ScrollBoxRenderable) => void }) {
  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="row" gap={2}>
        <box flexDirection="column" width={LIST} flexShrink={0}>
          <text wrapMode="none">
            <Brand theme={props.theme} />
            <span style={{ fg: props.theme().textMuted }}> tasks</span>
          </text>
          <Show when={props.view.status()}>
            {(status) => <OlderLine theme={props.theme} status={status()} width={LIST} />}
          </Show>
          <For each={props.view.rows()}>
            {(row) => (
              <TaskLine
                theme={props.theme}
                row={row}
                selected={row.id === props.view.selected()}
                width={LIST}
                prefix={"  ".repeat(row.depth)}
                onClick={() => props.view.select(row.id)}
              />
            )}
          </For>
          <text fg={props.theme().textMuted} wrapMode="none" marginTop={1}>
            j/k select task · pgup/pgdn scroll · esc collapse
          </text>
        </box>
        <Show when={props.view.selected()} keyed>
          {(unit) => <Peek theme={props.theme} view={props.view} sessions={props.sessions} unit={unit} width={PEEK} lines={6} />}
        </Show>
      </box>
      <SharedRegion theme={props.theme} view={props.view} width={LIST + 2 + PEEK} height={REGION} onScroll={props.onScroll} />
    </box>
  )
}

export function registerTicker(ctx: Ctx) {
  // A toast for each change, at most three at a time; the first snapshot is the baseline, not news.
  createEffect(
    on(ctx.view.status, (after, before) => {
      if (!ctx.active() || !before || !after) return
      for (const toast of tickerToasts(before, after)) ctx.api.ui.toast({ ...toast, title: MARK })
      Option.map(endNotice(before, after), (message) => void ctx.api.attention.notify({ title: NAME, message }))
    }),
  )

  // The peek is a dialog: open it when the peek turns on, and turn the peek off when the dialog closes.
  let shown = false
  createEffect(() => {
    const open = ctx.active() && ctx.view.expanded()
    if (open && !shown) {
      shown = true
      ctx.api.ui.dialog.replace(
        () => {
          // The shared region's scroll box, for pageup and pagedown.
          let region: ScrollBoxRenderable | undefined
          const page = (by: 1 | -1) => () => pageBy(region, by)
          const dispose = ctx.api.keymap.registerLayer({
            commands: [
              { name: "task_ui.dialog.next", run: ctx.view.next },
              { name: "task_ui.dialog.previous", run: ctx.view.previous },
              { name: "task_ui.dialog.page_down", run: page(1) },
              { name: "task_ui.dialog.page_up", run: page(-1) },
            ],
            bindings: [
              { key: "j,down", cmd: "task_ui.dialog.next", desc: "Select the next task" },
              { key: "k,up", cmd: "task_ui.dialog.previous", desc: "Select the previous task" },
              { key: "pagedown", cmd: "task_ui.dialog.page_down", desc: "Scroll the shared region down" },
              { key: "pageup", cmd: "task_ui.dialog.page_up", desc: "Scroll the shared region up" },
            ],
          })
          onCleanup(dispose)
          return (
            <TickerDialog
              theme={ctx.theme}
              view={ctx.view}
              sessions={ctx.sessions}
              leader={ctx.leader}
              onScroll={(box) => (region = box)}
            />
          )
        },
        () => {
          shown = false
          ctx.view.setExpanded(false)
        },
      )
      ctx.api.ui.dialog.setSize("xlarge")
    }
    if (!open && shown) {
      shown = false
      ctx.api.ui.dialog.clear()
    }
  })
}
