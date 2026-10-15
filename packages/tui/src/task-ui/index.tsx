// The built-in task-ui plugin: the `/task` harness's task tree, read once a second from
// `<directory>/.opencode/task/status.json`, in one of seven designs. `/task-design` picks the design and `ctrl+x v`
// cycles it. The chosen design is kept in the TUI's kv store and restored at the next launch. Without a stored design
// it starts on a host's `design` option (1-7) where a host passes one, else on design 1 (Ledger); built-in plugins get
// no options. The view state and every cadence are one taskView actor (machine.ts, AD-16); README.md describes the
// designs and the keys.
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { Effect, Exit, Scope } from "effect"
import { createActor } from "@jambudipa/xstate-effect"
import { createEffect, createMemo, createRoot, on, onCleanup } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { TaskView } from "./machine"
import { liveSessions } from "./peek"
import { DESIGNS, NAME } from "./store"
import { ShortcutBar, leaderOf, registerTab, registerWarning, type Ctx } from "./ui"
import { viewOf, type ViewActor } from "./view"
import { registerWatch, type Listen } from "./watch"
import { registerLedger } from "./designs/1-ledger"
import { registerDock } from "./designs/2-dock"
import { registerHud } from "./designs/6-hud"
import { registerTicker } from "./designs/7-ticker"
import { registerScreen } from "./designs/screen"

const tui: TuiPlugin = (api, options) =>
  Effect.runPromise(
    Effect.gen(function* () {
      // A stored value that is not a design (an older or hand-edited kv file) is passed over.
      const design = [api.kv.get(KV_DESIGN), Number(options?.design)].find(isDesign) ?? 1
      // One taskView actor for each plugin instance, in a scope that closes with the plugin's reactive root.
      const scope = yield* Scope.make()
      const actor = yield* Scope.provide(scope)(
        createActor(TaskView.machine, { input: { directory: api.state.path.directory, design } }),
      )
      yield* actor.start
      createRoot((dispose) => {
        api.lifecycle.onDispose(() => {
          dispose()
          Effect.runFork(Scope.close(scope, Exit.void))
        })
        const listen: Listen = (type, run) => {
          Effect.runFork(Scope.provide(scope)(actor.on(type, () => Effect.sync(run))))
        }
        start(api, actor, listen)
      })
    }),
  )

/** The kv key that keeps the chosen design across launches. */
const KV_DESIGN = "task_ui_design"

const isDesign = (value: unknown): value is number => DESIGNS.some((item) => item.id === value)

function start(api: Parameters<TuiPlugin>[0], actor: ViewActor, listen: Listen) {
  const view = viewOf(actor)

  // The root session: the session on screen, or its parent when the developer opened a builder or verifier. Only a
  // change of session or parent is a route change: the watch view's own `watch` parameter is not.
  const route = createMemo(() => {
    const current = api.route.current
    const id = "params" in current ? current.params?.sessionID : ""
    if (typeof id !== "string" || !id) return ""
    return [id, api.state.session.get(id)?.parentID ?? ""].join("\n")
  })
  createEffect(
    on(route, (key) => {
      if (!key) return
      const [session, parent] = key.split("\n")
      view.send(parent ? { type: "route.changed", session, parent } : { type: "route.changed", session })
    }),
  )

  // The root's harness sessions, read on the view's session cadence; the machine learns whether the root owns any.
  const sessions = liveSessions(api, view)
  const harness = sessions.all()
  createEffect(
    on(harness, (list) =>
      view.send({ type: "sessions.changed", owns: list.length > 0, updated: Math.max(0, ...list.map((item) => item.updated)) }),
    ),
  )

  // Every change is kept, whichever key made it (the picker, `ctrl+x v`, or a full-screen design's own key).
  createEffect(on(view.design, (id) => api.kv.set(KV_DESIGN, id), { defer: true }))
  const base = {
    api,
    view,
    root: view.root,
    sessions,
    owns: view.owns,
    harness,
    logs: view.logs,
    theme: () => api.theme.current,
    leader: leaderOf(api),
    motion: () => api.kv.get("animations_enabled", true),
  }
  const ctx = (id: number): Ctx => ({ ...base, active: () => view.design() === id })
  registerLedger(ctx(1))
  registerDock(ctx(2))
  // Designs 3, 4 and 5 share one route; it renders the selected one.
  registerScreen({ ...base, active: () => true })
  registerHud(ctx(6))
  registerTicker(ctx(7))
  // The run warning's toast, in every design.
  registerWarning({ view, toast: (toast) => api.ui.toast(toast) })
  // The watch view works with every design.
  const toggleWatch = registerWatch({ ...base, active: () => true }, listen)
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

  // Every switch says where the new design shows, so a one-line design is never hard to find. The id is the one chosen:
  // the machine takes the event on its own fiber.
  const announce = (id: number) => {
    const current = DESIGNS[id - 1]
    api.ui.toast({
      title: `Task design ${current.id}: ${current.name}`,
      message: `${current.where[0].toUpperCase()}${current.where.slice(1)}. ${base.leader} o expands it.`,
    })
  }
  const cycle = () => {
    const next = (view.design() % DESIGNS.length) + 1
    view.setDesign(next)
    announce(next)
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
          announce(option.value)
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
        command("task_ui.watch", "Watch the selected task's running work", toggleWatch),
        { ...command("task_ui.pick", "Choose a task design", pick), slashName: "task-design" },
      ],
      bindings: [
        { key: "<leader>j", cmd: "task_ui.next", desc: "Select the next harness task" },
        { key: "<leader>k", cmd: "task_ui.previous", desc: "Select the previous harness task" },
        { key: "<leader>o", cmd: "task_ui.expand", desc: "Expand or collapse the task design" },
        { key: "<leader>v", cmd: "task_ui.design", desc: "Next task UI design" },
        { key: "<leader>w", cmd: "task_ui.watch", desc: "Watch the selected task's running work" },
      ],
    }),
  )

  // Tab selects tasks while the run is live; `ctrl+x j/k` above selects them at any time.
  registerTab({ ...base, active: () => true })
}

export default { id: "internal:task-ui", tui }
