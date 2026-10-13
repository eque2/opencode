// The built-in task-ui plugin: the `/task` harness's task tree, read once a second from
// `<directory>/.opencode/task/status.json`, in one of seven designs. `/task-design` picks the design and `ctrl+x v`
// cycles it. Built-in plugins get no options, so it starts on design 1 (Ledger); a `design` option (1-7) is honoured
// where a host passes one. README.md describes the designs and the keys.
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { Clock, Effect, Option } from "effect"
import { createEffect, createMemo, createRoot, createSignal, onCleanup } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { liveSessions } from "./peek"
import {
  DESIGNS,
  LIVE_WINDOW,
  NAME,
  createView,
  parse,
  poll,
  runActive,
  statusFile,
  type ProofLog,
  type Status,
} from "./store"
import { ShortcutBar, leaderOf, registerTab, type Ctx } from "./ui"
import { registerWatch } from "./watch"
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

// When a file was last written, in epoch milliseconds; 0 when it cannot be read.
const modified = (file: string) =>
  Effect.tryPromise(() => Bun.file(file).stat()).pipe(
    Effect.map((stat) => stat.mtimeMs),
    Effect.orElseSucceed(() => 0),
  )

// The proof logs the harness writes as proofs run (`.opencode/task/proofs/<name>.log`); none when it wrote none.
const proofLogs = (directory: string) => {
  const folder = `${directory}/.opencode/task/proofs`
  return Effect.tryPromise(() => Array.fromAsync(new Bun.Glob("*.log").scan({ cwd: folder }))).pipe(
    Effect.flatMap((names) =>
      Effect.forEach(names, (name) =>
        modified(`${folder}/${name}`).pipe(Effect.map((mtime): ProofLog => ({ name: name.slice(0, -4), mtime }))),
      ),
    ),
    Effect.orElseSucceed((): ReadonlyArray<ProofLog> => []),
  )
}

function start(api: Parameters<TuiPlugin>[0], design: number) {
  // The status file, its age, the proof logs and the clock, read once a second. The text is compared before parsing,
  // and a text that does not parse (absent, or the harness is mid-write) keeps the last good status on screen.
  const file = statusFile(api.state.path.directory)
  const sample = poll<{ text: string; mtime: number; logs: ReadonlyArray<ProofLog>; now: number }>(
    { text: "", mtime: 0, logs: [], now: 0 },
    "1 second",
    Effect.all({
      text: Effect.tryPromise(() => Bun.file(file).text()).pipe(Effect.orElseSucceed(() => "")),
      mtime: modified(file),
      logs: proofLogs(api.state.path.directory),
      now: Clock.currentTimeMillis,
    }),
  )
  const text = createMemo(() => sample().text)
  const status = createMemo<Status | undefined>((last) => Option.getOrElse(parse(text()), () => last))
  const now = createMemo(() => sample().now)
  const logs = createMemo(() => sample().logs)

  // The root session: the session on screen, or its parent when the developer opened a builder or verifier.
  const [root, setRoot] = createSignal("")
  createEffect(() => {
    const current = api.route.current
    const id = "params" in current ? current.params?.sessionID : ""
    if (typeof id === "string" && id) setRoot(api.state.session.get(id)?.parentID ?? id)
  })

  // The run on screen is the root session's own when the root owns harness sessions. It is live while it has not
  // ended and something still moves: the status file, a harness session, or a proof log changed in the last five
  // minutes (the harness's stream-idle bound). A run whose server stopped keeps a running status, but nothing moves.
  const sessions = liveSessions(api, root)
  const harness = sessions.all()
  const owns = createMemo(() => harness().length > 0)
  const live = createMemo(() => {
    const current = status()
    if (!current || !runActive(current) || !owns()) return false
    const changed = Math.max(
      sample().mtime,
      ...harness().map((item) => item.updated),
      ...logs().map((log) => log.mtime),
    )
    return now() - changed <= LIVE_WINDOW
  })

  const view = createView({ status, now, design, live })
  const base = {
    api,
    view,
    root,
    sessions,
    owns,
    harness,
    logs,
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
  // The watch view works with every design.
  const toggleWatch = registerWatch({ ...base, active: () => true })
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
