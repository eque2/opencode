/** @jsxImportSource @opentui/solid */
// The task-ui plugin as opencode loads it: in the built-in list, and through its entry with the plugin API, a real
// keymap and the host's slot registry, over a status file in a temporary directory.
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { Show, createRoot, createSignal } from "solid-js"
import type {
  TuiDialogSelectProps,
  TuiDispose,
  TuiPluginApi,
  TuiPluginMeta,
  TuiSlotPlugin,
  TuiToast,
} from "@opencode-ai/plugin/tui"
import { TuiKeybind } from "../../src/config/keybind"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useCommandSlashes } from "../../src/keymap"
import { createSlots } from "../../src/plugin/slots"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"
import TaskUi from "../../src/task-ui/index"
import { DESIGNS, statusFile } from "../../src/task-ui/store"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { tmpdir } from "../fixture/fixture"
import fixture from "./fixture-status.json"

const meta = {
  id: "internal:task-ui",
  source: "internal",
  spec: "internal:task-ui",
  target: "internal:task-ui",
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: "test",
  state: "same",
} satisfies TuiPluginMeta

/** One opening of the design picker: what it offered, and a way to choose one of its options by value. */
type Picker = {
  readonly title: string
  readonly current: unknown
  readonly options: ReadonlyArray<{ readonly title: string; readonly value: unknown }>
  readonly select: (value: unknown) => void
}

type Slash = ReturnType<typeof useCommandSlashes>

async function writeStatus(directory: string, status: unknown) {
  await mkdir(path.dirname(statusFile(directory)), { recursive: true })
  await Bun.write(statusFile(directory), JSON.stringify(status))
}

// Loads the plugin entry the way the runtime does, with no options. The shortcut bar's slot is on screen.
async function load(directory: string) {
  const toasts: TuiToast[] = []
  const pickers: Picker[] = []
  const disposers: TuiDispose[] = []
  const slots = createSlots()
  const handles: { api?: TuiPluginApi; slashes?: Slash } = {}
  const [loaded, setLoaded] = createSignal(false)

  function Slashes() {
    handles.slashes = useCommandSlashes()
    return <box />
  }

  function Host() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const keybinds = createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse({})), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    })
    registerOpencodeKeymap(keymap, renderer, { keybinds, leader_timeout: 2000 })
    const base = createTuiPluginApi({ renderer, keymap })
    const host = slots.setup(base)
    let count = 0
    handles.api = {
      ...base,
      state: { ...base.state, path: { ...base.state.path, directory } },
      slots: {
        register(plugin: TuiSlotPlugin) {
          count += 1
          const id = `${meta.id}:${count}`
          host.register({ ...plugin, id })
          return id
        },
      },
      ui: {
        ...base.ui,
        toast: (toast) => void toasts.push(toast),
        DialogSelect: <Value,>(props: TuiDialogSelectProps<Value>) => {
          pickers.push({
            title: props.title,
            current: props.current,
            options: props.options.map((option) => ({ title: option.title, value: option.value })),
            select: (value) => {
              const option = props.options.find((item) => item.value === value)
              if (option) props.onSelect?.(option)
            },
          })
          return null
        },
        dialog: {
          ...base.ui.dialog,
          replace: (render) =>
            createRoot((dispose) => {
              render()
              dispose()
            }),
        },
      },
      lifecycle: {
        ...base.lifecycle,
        onDispose: (fn) => {
          disposers.push(fn)
          return () => {}
        },
      },
    }
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <box flexDirection="column">
          {/* Mounted after the plugin loads: a mounted slot acts on one registry change per tick, and the plugin
              registers five slots in one tick. */}
          <Show when={loaded()}>
            <slots.Slot name="session_prompt_right" session_id="" />
          </Show>
          <Slashes />
        </box>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Host />, { width: 200, height: 4 })
  const { api, slashes } = handles
  if (!api || !slashes) throw new Error("the host did not render")
  await TaskUi.tui(api, undefined, meta)
  setLoaded(true)

  const frame = async () => {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  // Waits until the screen shows `text`: the status poll and the keymap answer on later ticks. The bound is several
  // poll intervals, so a loaded machine does not fail the test.
  const shows = async (text: string, within = 5000) => {
    const end = Date.now() + within
    while (Date.now() < end) {
      if ((await frame()).includes(text)) return true
      await Bun.sleep(25)
    }
    return (await frame()).includes(text)
  }
  const slash = (name: string) => slashes().find((entry) => entry.display === name)
  // Opens the picker through its slash command, as typing `/task-design` does, and returns what it offered.
  const openPicker = () => {
    const count = pickers.length
    slash("/task-design")?.onSelect()
    const picker = pickers.at(-1)
    if (pickers.length !== count + 1 || !picker) throw new Error("/task-design did not open the picker")
    return picker
  }
  return {
    toasts,
    slash,
    openPicker,
    shows,
    async [Symbol.asyncDispose]() {
      for (const dispose of disposers) await dispose()
      app.renderer.destroy()
    },
  }
}

test("the built-in plugins include task-ui, enabled, with the entry opencode loads", () => {
  const builtin = createBuiltinPlugins({ experimentalEventSystem: false }).find((item) => item.id === "internal:task-ui")
  expect(builtin?.tui).toBe(TaskUi.tui)
  expect(builtin?.enabled).not.toBe(false)
})

test("the plugin registers /task-design and switches to each of the seven designs through it", async () => {
  await using dir = await tmpdir()
  await writeStatus(dir.path, fixture)
  await using plugin = await load(dir.path)

  // No option: the plugin starts on design 1.
  expect(await plugin.shows("◆ In the Flow Ledger")).toBe(true)
  expect(plugin.slash("/task-design")?.description).toBe("Choose a task design")
  const first = plugin.openPicker()
  expect(first.title).toBe("Task design")
  expect(first.current).toBe(1)
  expect(first.options).toEqual(DESIGNS.map((item) => ({ title: `${item.id} ${item.name}`, value: item.id })))

  // Every pick is a change: designs 2 to 7, then back to 1.
  for (const design of [...DESIGNS.slice(1), DESIGNS[0]]) {
    plugin.openPicker().select(design.id)
    expect(plugin.toasts.at(-1)?.title).toBe(`Task design ${design.id}: ${design.name}`)
    expect(await plugin.shows(`◆ In the Flow ${design.name} `)).toBe(true)
    expect(plugin.openPicker().current).toBe(design.id)
  }
})

test("the plugin follows a new status file through its one-second poll", async () => {
  await using dir = await tmpdir()
  await writeStatus(dir.path, fixture)
  await using plugin = await load(dir.path)
  expect(await plugin.shows("◆ In the Flow Ledger")).toBe(true)

  // Ticker puts the run's progress and the selected task in the shortcut bar.
  plugin.openPicker().select(7)
  expect(await plugin.shows("◆ In the Flow Ticker  3/6 trusted  ⊘ T1.4 budget exhausted")).toBe(true)

  const next = structuredClone(fixture)
  next.tasks["T1.4"].state = "trusted"
  await writeStatus(dir.path, next)
  expect(await plugin.shows("4/6 trusted")).toBe(true)
  expect(plugin.toasts.map((toast) => toast.message)).toContain("T1.4 budget exhausted → trusted")
})
