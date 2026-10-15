/** @jsxImportSource @opentui/solid */
// The task-ui plugin as opencode loads it: in the built-in list, and through its entry with the plugin API, a real
// keymap and the host's slot registry, over a status file (or none) in a temporary directory.
import { expect, spyOn, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { Show, createRoot, createSignal } from "solid-js"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type {
  TuiDialogSelectProps,
  TuiDispose,
  TuiPluginApi,
  TuiPluginMeta,
  TuiSlotPlugin,
  TuiToast,
} from "@opencode-ai/plugin/tui"
import { TuiKeybind } from "../../src/config/keybind"
import { OPENCODE_BASE_MODE, OpencodeKeymapProvider, registerOpencodeKeymap, useCommandSlashes } from "../../src/keymap"
import { createSlots } from "../../src/plugin/slots"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"
import TaskUi from "../../src/task-ui/index"
import { DESIGNS, MARK, statusFile } from "../../src/task-ui/store"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { tmpdir } from "../fixture/fixture"
// The shared projected status (AD-13, with tags): T1.4 budget exhausted, T1.5 and T1 blocked by it.
import fixture from "./fixture-projected.json"

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

// Loads the plugin entry the way the runtime does, with no options. The sidebar and the shortcut bar's slot are on
// screen, and Tab that the plugin does not take reaches opencode's agent key. `kv` is the TUI's kv store from an
// earlier load (a fresh one by default); `session` opens that session's route instead of home, and `navigate` moves
// it. The SDK client records each request path; it answers a session's children with one harness session for each
// title in `harness` (none by default), records an abort, and answers anything else with an empty list.
async function load(
  directory: string,
  options: { kv?: TuiPluginApi["kv"]; session?: string; harness?: ReadonlyArray<string> } = {},
) {
  const requests: string[] = []
  const aborted: string[] = []
  const toasts: TuiToast[] = []
  const agent = { moves: 0 }
  const pickers: Picker[] = []
  const disposers: TuiDispose[] = []
  const slots = createSlots()
  const handles: { api?: TuiPluginApi; slashes?: Slash; navigate?: (sessionID: string) => void } = {}
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
    // opencode's agent key, bound the way the app binds it.
    keymap.registerLayer({ commands: [{ name: "agent.cycle", run: () => void agent.moves++ }] })
    keymap.registerLayer({ mode: OPENCODE_BASE_MODE, bindings: keybinds.gather("app", ["agent.cycle"]) })
    const answer = async (request: RequestInfo | URL) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      requests.push(url.pathname)
      if (/^\/session\/[^/]+\/children$/.test(url.pathname))
        return Response.json(
          (options.harness ?? []).map((title, index) => ({
            id: `ses_harness_${index}`,
            title,
            time: { created: index + 1, updated: index + 1 },
          })),
        )
      const abort = /^\/session\/([^/]+)\/abort$/.exec(url.pathname)
      if (abort) {
        aborted.push(decodeURIComponent(abort[1]))
        return Response.json(true)
      }
      return Response.json([])
    }
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      fetch: Object.assign(answer, { preconnect: fetch.preconnect }),
    })
    const base = createTuiPluginApi({ renderer, keymap, client })
    const [current, setCurrent] = createSignal(
      options.session ? { name: "session", params: { sessionID: options.session } } : base.route.current,
    )
    handles.navigate = (sessionID: string) => setCurrent({ name: "session", params: { sessionID } })
    const host = slots.setup(base)
    let count = 0
    handles.api = {
      ...base,
      kv: options.kv ?? base.kv,
      route: {
        ...base.route,
        navigate: (name, params) => setCurrent(params ? { name, params } : { name }),
        get current() {
          return current()
        },
      },
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
            <slots.Slot name="sidebar_content" session_id="" />
          </Show>
          <Slashes />
        </box>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Host />, { width: 200, height: 30 })
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
    frame,
    shows,
    agent,
    kv: api.kv,
    requests,
    aborted,
    navigate: (sessionID: string) => handles.navigate?.(sessionID),
    pressTab: () => app.mockInput.pressTab(),
    /** Disposes the plugin only, as the runtime does on a reload; the host stays on screen. */
    async unload() {
      for (const dispose of disposers.splice(0)) await dispose()
    },
    async [Symbol.asyncDispose]() {
      for (const dispose of disposers.splice(0)) await dispose()
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
  // T4.9 re-baselined: the trusted count has its stopped count.
  expect(await plugin.shows("◆ In the Flow Ticker  3/6 trusted  · 3 stopped  ⊘ T1.4 budget exhausted")).toBe(true)

  const next = structuredClone(fixture)
  Object.assign(next.tasks["T1.4"], { state: "trusted", tags: ["ended"] })
  await writeStatus(dir.path, next)
  expect(await plugin.shows("4/6 trusted")).toBe(true)
  expect(plugin.toasts.map((toast) => toast.message)).toContain("T1.4 budget exhausted → trusted")
})

test("UI16 the plugin toasts the run warning once when the status gains it, in any design", async () => {
  await using dir = await tmpdir()
  await writeStatus(dir.path, fixture)
  await using plugin = await load(dir.path)
  expect(await plugin.shows("◆ In the Flow Ledger")).toBe(true)
  const warned = structuredClone(fixture)
  Object.assign(warned.run, { warning: "R3 a: b\nR4 c: d" })
  await writeStatus(dir.path, warned)
  expect(await plugin.shows("! spec no longer validates · 2 failur")).toBe(true)
  const message = "The spec no longer validates (2 failures). The run keeps the plan it loaded."
  expect(plugin.toasts.filter((toast) => toast.message === message)).toEqual([
    { variant: "warning", title: "◆ In the Flow", message },
  ])
})

test("UI14 the plugin's mark moves for a live run with animations on, and stays a ◆ with them off", async () => {
  await using dir = await tmpdir()
  // A fresh heartbeat: the run is live for the next 15 s.
  await writeStatus(dir.path, { ...fixture, run: { ...fixture.run, aliveAt: Date.now() } })
  const first = await load(dir.path)
  expect(await first.shows("In the Flow run: running")).toBe(true)
  // The cell before the name, sampled for a second, in the Ledger's header and in the shortcut bar: the spinner's
  // frames, more than one of them.
  const marks = async (plugin: typeof first, after: string) => {
    const seen = new Set<string>()
    for (let sample = 0; sample < 20; sample++) {
      const line = (await plugin.frame()).split("\n").find((item) => item.includes(after)) ?? ""
      seen.add(line.slice(line.indexOf(after) - 1, line.indexOf(after)))
      await Bun.sleep(50)
    }
    return seen
  }
  for (const after of [" In the Flow run: running", " In the Flow Ledger  "]) {
    const moving = await marks(first, after)
    expect({ after, moving: moving.size > 1 }).toEqual({ after, moving: true })
    expect([...moving].every((cell) => ["·", "⬩", "⬪", "⬥", "◆"].includes(cell))).toBe(true)
  }
  first.kv.set("animations_enabled", false)
  await first.unload()
  await using second = await load(dir.path, { kv: first.kv })
  expect(await second.shows("In the Flow run: running")).toBe(true)
  for (const after of [" In the Flow run: running", " In the Flow Ledger  "])
    expect({ after, cells: [...(await marks(second, after))] }).toEqual({ after, cells: ["◆"] })
  await first[Symbol.asyncDispose]()
})

test("a chosen design survives a reload of the plugin with the same kv", async () => {
  await using dir = await tmpdir()
  await writeStatus(dir.path, fixture)
  const first = await load(dir.path)
  expect(await first.shows("◆ In the Flow Ledger")).toBe(true)
  first.openPicker().select(6)
  expect(await first.shows("◆ In the Flow HUD ")).toBe(true)
  await first[Symbol.asyncDispose]()

  const second = await load(dir.path, { kv: first.kv })
  expect(second.openPicker().current).toBe(6)
  expect(await second.shows("◆ In the Flow HUD ")).toBe(true)
  await second[Symbol.asyncDispose]()

  // A stored value that is not a design falls back to design 1.
  first.kv.set("task_ui_design", 9)
  await using third = await load(dir.path, { kv: first.kv })
  expect(third.openPicker().current).toBe(1)
  expect(await third.shows("◆ In the Flow Ledger")).toBe(true)
})

test("without a status file the plugin shows nothing in its slots and leaves Tab to the agent key", async () => {
  await using dir = await tmpdir()
  await using plugin = await load(dir.path, { session: "ses_root" })

  // Past two polls of the status file: still no mark in the sidebar or beside the prompt.
  const end = Date.now() + 2500
  while (Date.now() < end) {
    expect(await plugin.frame()).not.toContain(MARK)
    await Bun.sleep(100)
  }

  plugin.pressTab()
  for (let tries = 0; tries < 100 && plugin.agent.moves === 0; tries++) await Bun.sleep(10)
  expect(plugin.agent.moves).toBe(1)
})

// --- the view actor (T4.3) ----------------------------------------------------------------------------------------

const ROOT = "ses_root"

// The projected status with its heartbeat moved: fresh for the next minute (live), or a minute old (still).
const beating = (offset: number) => ({ ...structuredClone(fixture), run: { ...fixture.run, aliveAt: Date.now() + offset } })

// Waits until `done` holds, polling every 10 ms for up to 3 s.
async function until(done: () => boolean) {
  for (let tries = 0; tries < 300 && !done(); tries++) await Bun.sleep(10)
  return done()
}

// Presses Tab once the plugin has read the status and the root's harness sessions, and says whether Tab was taken.
async function tabTaken(plugin: Awaited<ReturnType<typeof load>>) {
  expect(await plugin.shows(MARK)).toBe(true)
  expect(await until(() => plugin.requests.includes(`/session/${ROOT}/children`))).toBe(true)
  await Bun.sleep(300)
  plugin.pressTab()
  await Bun.sleep(300)
  return plugin.agent.moves === 0
}

test("each plugin instance has its own view actor: a design chosen in one leaves the other on its own", async () => {
  await using one = await tmpdir()
  await using two = await tmpdir()
  await writeStatus(one.path, fixture)
  await writeStatus(two.path, fixture)
  await using first = await load(one.path)
  await using second = await load(two.path)
  first.openPicker().select(6)
  expect(await first.shows("◆ In the Flow HUD ")).toBe(true)
  expect(second.openPicker().current).toBe(1)
  expect(await second.shows("◆ In the Flow Ledger")).toBe(true)
})

test("an unloaded plugin's view actor stops: no more reads, no more toasts for a rewritten status", async () => {
  await using dir = await tmpdir()
  await writeStatus(dir.path, fixture)
  // Every read of the status file goes through Bun.file: the actor's feed reads it once a second while it runs.
  const files = spyOn(Bun, "file")
  const reads = () => files.mock.calls.filter(([file]) => String(file) === statusFile(dir.path)).length
  await using plugin = await load(dir.path, { session: ROOT })
  plugin.openPicker().select(7)
  expect(await plugin.shows("◆ In the Flow Ticker  3/6 trusted")).toBe(true)
  const before = reads()
  expect(await until(() => reads() > before)).toBe(true)
  await plugin.unload()
  await Bun.sleep(100)
  const after = reads()
  const requests = plugin.requests.length
  const toasts = plugin.toasts.length
  const next = structuredClone(fixture)
  Object.assign(next.tasks["T1.4"], { state: "trusted", tags: ["ended"] })
  await writeStatus(dir.path, next)
  await Bun.sleep(2500)
  // The actor stopped with the plugin's scope: the feed reads the file no more.
  expect(reads()).toBe(after)
  expect(plugin.requests.length).toBe(requests)
  expect(plugin.toasts.length).toBe(toasts)
  files.mockRestore()
})

test("UI3 Tab selects tasks only while the run is live and the root owns its harness sessions", async () => {
  await using dir = await tmpdir()
  await writeStatus(dir.path, beating(60_000))
  {
    await using plugin = await load(dir.path, { session: ROOT, harness: ["T1.4 builder"] })
    expect(await tabTaken(plugin)).toBe(true)
  }
  {
    // Live, but the root owns no harness session: Tab goes to the agent.
    await using plugin = await load(dir.path, { session: ROOT })
    expect(await tabTaken(plugin)).toBe(false)
  }
  await writeStatus(dir.path, beating(-60_000))
  {
    // The heartbeat is a minute old: the run stands still, and Tab goes to the agent.
    await using plugin = await load(dir.path, { session: ROOT, harness: ["T1.4 builder"] })
    expect(await tabTaken(plugin)).toBe(false)
  }
})

test("the root follows the route into the machine: the session list is read for the session on screen", async () => {
  await using dir = await tmpdir()
  await writeStatus(dir.path, beating(60_000))
  await using plugin = await load(dir.path, { session: ROOT })
  expect(await until(() => plugin.requests.includes(`/session/${ROOT}/children`))).toBe(true)
  plugin.navigate("ses_other")
  expect(await until(() => plugin.requests.includes("/session/ses_other/children"))).toBe(true)
})

test("the plugin's view state and reads live in the machine: no signal, poll or timer of their own", async () => {
  const source = async (file: string) => Bun.file(path.join(import.meta.dir, "../../src/task-ui", file)).text()
  for (const file of ["index.tsx", "watch.tsx", "peek.tsx", "store.ts", "view.ts"]) {
    const text = await source(file)
    for (const construct of ["createSignal", "poll(", "Effect.sleep", "Effect.repeat", "Schedule.", "setInterval", "LIVE_WINDOW"])
      expect({ file, construct, found: text.includes(construct) }).toEqual({ file, construct, found: false })
  }
})
