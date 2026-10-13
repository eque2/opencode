// Design 7, Ticker: the quietest. Its line is the status part of the shortcut bar beside the prompt; it adds a toast
// when a task changes state, a notification when the run ends, and expands to a dialog over the session.
import { For, Show, createEffect, on, onCleanup } from "solid-js"
import { Peek } from "../peek"
import { ENDED, label, tone, type Status } from "../store"
import { Brand, TaskLine, type Ctx, type ViewProps } from "../ui"

const LIST = 30
const PEEK = 72

/** The state changes between two snapshots: the run's, then each task's, as `T1.4 building → proving`. */
export const changes = (before: Status, after: Status) => [
  ...(before.run.state === after.run.state ? [] : [{ unit: "run", from: before.run.state, to: after.run.state }]),
  ...Object.entries(after.tasks).flatMap(([id, task]) =>
    before.tasks[id]?.state === task.state ? [] : [{ unit: id, from: before.tasks[id]?.state, to: task.state }],
  ),
]

export function TickerDialog(props: ViewProps) {
  return (
    <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="column" width={LIST} flexShrink={0}>
        <text wrapMode="none">
          <Brand theme={props.theme} />
          <span style={{ fg: props.theme().textMuted }}> tasks</span>
        </text>
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
          j/k select task · esc collapse
        </text>
      </box>
      <Show when={props.view.selected()} keyed>
        {(unit) => <Peek theme={props.theme} view={props.view} sessions={props.sessions} unit={unit} width={PEEK} lines={6} />}
      </Show>
    </box>
  )
}

export function registerTicker(ctx: Ctx) {
  // A toast for each change, at most three at a time; the first snapshot is the baseline, not news.
  createEffect(
    on(ctx.view.status, (after, before) => {
      if (!ctx.active() || !before || !after) return
      const list = changes(before, after)
      for (const change of list.slice(0, 3)) {
        const value = tone(change.to)
        ctx.api.ui.toast({
          variant: value === "good" ? "success" : value === "bad" ? "error" : value === "warn" ? "warning" : "info",
          title: "◆ HARNESS",
          message: `${change.unit} ${change.from ? `${label(change.from)} → ` : ""}${label(change.to)}`,
        })
      }
      if (before.run.state !== after.run.state && ENDED.includes(after.run.state))
        void ctx.api.attention.notify({
          title: "Task harness",
          message: `Run ${label(after.run.state)}${after.run.reason ? `: ${after.run.reason}` : ""}`,
        })
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
          const dispose = ctx.api.keymap.registerLayer({
            commands: [
              { name: "task_ui.dialog.next", run: ctx.view.next },
              { name: "task_ui.dialog.previous", run: ctx.view.previous },
            ],
            bindings: [
              { key: "j,down", cmd: "task_ui.dialog.next", desc: "Select the next task" },
              { key: "k,up", cmd: "task_ui.dialog.previous", desc: "Select the previous task" },
            ],
          })
          onCleanup(dispose)
          return <TickerDialog theme={ctx.theme} view={ctx.view} sessions={ctx.sessions} leader={ctx.leader} />
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
