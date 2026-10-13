// The task-ui candidates: seven ways to show a running `/task` in the TUI, as one external TUI plugin. Nothing in
// opencode imports this folder; `launch.sh` loads it through OPENCODE_TUI_CONFIG with `{ "design": <1-7> }`.
// Delete the folder once a candidate is chosen.
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { Clock, Effect, Option } from "effect"
import { createEffect, createMemo, createRoot, createSignal, onCleanup } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { liveSessions } from "./peek"
import { DESIGNS, NAME, createView, parse, poll, statusFile, type Status } from "./store"
import { ShortcutBar, leaderOf, type Ctx } from "./ui"
import { registerLedger } from "./designs/1-ledger"
import { registerDock } from "./designs/2-dock"
import { registerHud } from "./designs/6-hud"
import { registerTicker } from "./designs/7-ticker"
import { registerScreen } from "./designs/screen"

const tui: TuiPlugin = (api, options) =>
  Effect.runPromise(
    Effect.sync(() => {
      const asked = Number(options?.design)
      const design = DESIGNS.some((item) => item.id === asked) ? asked : 1
      createRoot((dispose) => {
        api.lifecycle.onDispose(dispose)
        start(api, design)
      })
    }),
  )

function start(api: Parameters<TuiPlugin>[0], design: number) {
  // The status file and the clock, read once a second. The text is compared before parsing, and a text that does
  // not parse (absent, or the harness is mid-write) keeps the last good status on screen.
  const file = statusFile(api.state.path.directory)
  const sample = poll(
    { text: "", now: 0 },
    "1 second",
    Effect.all({
      text: Effect.tryPromise(() => Bun.file(file).text()).pipe(Effect.orElseSucceed(() => "")),
      now: Clock.currentTimeMillis,
    }),
  )
  const text = createMemo(() => sample().text)
  const status = createMemo<Status | undefined>((last) => Option.getOrElse(parse(text()), () => last))
  const now = createMemo(() => sample().now)

  // The root session: the session on screen, or its parent when the developer opened a builder or verifier.
  const [root, setRoot] = createSignal("")
  createEffect(() => {
    const current = api.route.current
    const id = "params" in current ? current.params?.sessionID : ""
    if (typeof id === "string" && id) setRoot(api.state.session.get(id)?.parentID ?? id)
  })

  const view = createView({ status, now, design })
  const base = {
    api,
    view,
    root,
    sessions: liveSessions(api, root),
    theme: () => api.theme.current,
    leader: leaderOf(api),
  }
  const ctx = (id: number): Ctx => ({ ...base, active: () => view.design() === id })
  registerLedger(ctx(1))
  registerDock(ctx(2))
  // Designs 3, 4 and 5 share one route; it renders the selected one.
  registerScreen({ ...base, active: () => true })
  registerHud(ctx(6))
  registerTicker(ctx(7))
  // One shortcut bar for every design, at the bottom right of the input box.
  api.slots.register({
    order: 50,
    slots: {
      session_prompt_right() {
        const dimensions = useTerminalDimensions()
        return <ShortcutBar {...base} width={dimensions().width} />
      },
    },
  })

  // Every switch says where the new design shows, so a one-line design is never hard to find.
  const announce = () => {
    const current = DESIGNS[view.design() - 1]
    api.ui.toast({
      title: `Task design ${current.id}: ${current.name}`,
      message: `${current.where[0].toUpperCase()}${current.where.slice(1)}. ${base.leader} o expands it.`,
    })
  }
  const cycle = () => {
    view.cycleDesign()
    announce()
  }
  const pick = () =>
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title="Task design"
        current={view.design()}
        options={DESIGNS.map((item) => ({ title: `${item.id} ${item.name}`, value: item.id, description: item.where }))}
        onSelect={(option) => {
          view.setDesign(option.value)
          api.ui.dialog.clear()
          announce()
        }}
      />
    ))
  const command = (name: string, title: string, run: () => void) => ({
    name,
    title,
    category: NAME,
    namespace: "palette",
    run,
  })
  onCleanup(
    api.keymap.registerLayer({
      commands: [
        command("task_ui.next", "Select the next harness task", view.next),
        command("task_ui.previous", "Select the previous harness task", view.previous),
        command("task_ui.expand", "Expand or collapse the task design", view.toggleExpanded),
        command("task_ui.design", "Next task UI design", cycle),
        { ...command("task_ui.pick", "Choose a task design", pick), slashName: "task-design" },
      ],
      bindings: [
        { key: "<leader>j", cmd: "task_ui.next", desc: "Select the next harness task" },
        { key: "<leader>k", cmd: "task_ui.previous", desc: "Select the previous harness task" },
        { key: "<leader>o", cmd: "task_ui.expand", desc: "Expand or collapse the task design" },
        { key: "<leader>v", cmd: "task_ui.design", desc: "Next task UI design" },
      ],
    }),
  )
}

export default { id: "task-ui", tui }
