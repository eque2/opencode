import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Option, Scope } from "effect"
import { createActor, SimulatedClock } from "@jambudipa/xstate-effect"
import { createBindingLookup } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type {
  TuiDispose,
  TuiPluginApi,
  TuiPluginMeta,
  TuiRouteCurrent,
  TuiSlotPlugin,
  TuiToast,
} from "@opencode-ai/plugin/tui"
import { Show, createComponent, createSignal } from "solid-js"
import { CLASS } from "@/task/engine-xstate/machine"
import { TuiKeybind } from "../../../tui/src/config/keybind"
import { OPENCODE_BASE_MODE, OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../tui/src/keymap"
import { createSlots } from "../../../tui/src/plugin/slots"
import TaskUi from "../../../tui/src/task-ui/index"
import { LIVE_MS, TaskView } from "../../../tui/src/task-ui/machine"
import { NAME, parse, statusFile, type Liveness, type Status } from "../../../tui/src/task-ui/store"
import { settle, viewFor } from "../../../tui/test/task-ui/view"
import { createTuiPluginApi } from "../../../tui/test/fixture/tui-plugin"

// Scenario UI3 (spec task-harness-feedback, D16, AD-16, owner ruling 5, @ASSUMPTION:A2.a; tasks T4.1, T4.3): liveness
// comes from the status tags and the heartbeat.
//
//   Given a status file
//   When the run lacks the ended tag and its heartbeat is at most 15 seconds old
//   Then the view is live, and Tab, esc twice and the watch keys act on the run when the session owns its harness
//     sessions
//   And an older or absent heartbeat makes the view still, an ended run makes it ended, and no file makes it absent
//   And the run keys leave a run alone when the view is not live or the session does not own it
//
// Liveness is read from the real `taskView` machine: its `liveness` region, over its own feed read of
// `<directory>/.opencode/task/status.json` with the real clock, and over the tui test helper `viewFor` (the real machine
// with a read that gives the clock) for the exact 15 s boundary. The keys are pressed on the real plugin entry
// (`TaskUi.tui`, as opencode loads it) on the route of the session ses_root, with opencode's keymap, the host's slot
// registry and opencode's agent key (Tab, when the plugin does not take it); a real SDK client over a fetch answers the
// root's children (its harness sessions) and records each abort. While a run is live the test rewrites the status file
// each 500 ms with a fresh `aliveAt`, as the harness's status writer does.

const ROOT = "ses_root"
const SPEC = "task-formats/blend/release-notes.spec"
const NOW = 1_791_000_000_000

type TaskState = keyof typeof CLASS.task

/** A task in `state`, with the name the status shows and the class tags the harness gives that state. */
const task = (state: TaskState, extra: Record<string, unknown> = {}) => ({
  state: CLASS.task[state].shows,
  tags: [...CLASS.task[state].tags],
  attempts: 1,
  waitingOn: [],
  waitingOnOutside: [],
  ...extra,
})

const TASKS = {
  T1: task("waiting", { attempts: 0, waitingOn: ["T1.4"] }),
  "T1.1": task("trusted"),
  "T1.2": task("building"),
  "T1.3": task("proving"),
  "T1.4": task("waiting", { attempts: 0, waitingOn: ["T1.2", "T1.3"] }),
}

/** A status text: a running run (or `run` over it) with its heartbeat `aliveAt`; none when `aliveAt` is undefined. */
const statusText = (aliveAt: number | undefined, run: Record<string, unknown> = {}) =>
  JSON.stringify({
    run: {
      state: "running",
      tags: [...CLASS.run.running.tags],
      spec: SPEC,
      path: SPEC,
      startedAt: 1,
      ...(aliveAt === undefined ? {} : { aliveAt }),
      ...run,
    },
    tasks: TASKS,
    obligations: {},
    scenarios: {},
    history: [],
  })

const ENDED = { state: "budget_exhausted", tags: [...CLASS.run.budget_exhausted.tags] }

const statusOf = (text: string): Status => Option.getOrThrow(parse(text))

async function tempDirectory() {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "verify-ui3-")))
}

async function writeStatus(directory: string, text: string) {
  await mkdir(path.dirname(statusFile(directory)), { recursive: true })
  await Bun.write(statusFile(directory), text)
}

/** Waits until `done` holds, polling every 20 ms for up to `within` ms. */
async function until(done: () => boolean | Promise<boolean>, within = 5_000) {
  const end = Date.now() + within
  while (Date.now() < end) {
    if (await done()) return true
    await Bun.sleep(20)
  }
  return done()
}

// --- liveness ------------------------------------------------------------------------------------------------------

/** The real taskView machine with its own feed read of `directory`, on a SimulatedClock that moves only on `advance`. */
async function machineOver(directory: string) {
  const scope = Effect.runSync(Scope.make())
  const clock = new SimulatedClock()
  const actor = await Effect.runPromise(
    Scope.provide(scope)(createActor(TaskView.machine, { input: { directory, design: 1 }, clock })),
  )
  await Effect.runPromise(actor.start)
  const snapshot = () => Effect.runSync(actor.getSnapshot)
  const reads = () => snapshot().context.now
  // The first read has finished when the context has the clock of a read.
  await until(() => reads() > 0)
  const region = () => {
    const value: unknown = snapshot().value
    return typeof value === "object" && value !== null ? String(Reflect.get(value, "liveness")) : ""
  }
  return {
    region,
    /** Moves the machine's clock past the feed's rest, and waits for the next read to land. */
    readAgain: async () => {
      const before = reads()
      await Effect.runPromise(clock.increment(1_000))
      await until(() => reads() > before)
      await Bun.sleep(20)
    },
    dispose: () => Effect.runSync(Scope.close(scope, Exit.void)),
  }
}

test("[UI3] the view is live while the run lacks ended and its heartbeat is at most 15 s old; still, ended or absent otherwise", async () => {
  // The exact boundary, on the real machine whose read gives the clock: 15 000 ms is live, 15 001 ms is still.
  const fresh = statusOf(statusText(NOW))
  for (const [age, liveness] of [
    [0, "live"],
    [LIVE_MS, "live"],
    [LIVE_MS + 1, "still"],
    [60_000, "still"],
  ] as const) {
    const made = await viewFor(fresh, { now: NOW + age })
    expect({ age, liveness: made.view.liveness(), live: made.view.live() }).toEqual({
      age,
      liveness,
      live: liveness === "live",
    })
    made.dispose()
  }
  expect(LIVE_MS).toBe(15_000)
  // No heartbeat at all is still; the ended tag is ended even with a fresh heartbeat; so is a refused run.
  const cases: ReadonlyArray<[string, Status | undefined, Liveness]> = [
    ["no heartbeat", statusOf(statusText(undefined)), "still"],
    ["ended, fresh heartbeat", statusOf(statusText(NOW, ENDED)), "ended"],
    ["done", statusOf(statusText(NOW, { state: "done", tags: [...CLASS.run.done.tags] })), "ended"],
    ["refused", statusOf(statusText(NOW, { state: "refused", tags: ["ended", "stopped"] })), "ended"],
    ["no status", undefined, "absent"],
  ]
  for (const [name, status, liveness] of cases) {
    const made = await viewFor(status, { now: NOW })
    expect({ name, liveness: made.view.liveness() }).toEqual({ name, liveness })
    made.dispose()
  }

  // A status file on disk, read by the machine's own feed with the real clock.
  const directory = await tempDirectory()
  try {
    const absent = await machineOver(directory)
    expect(absent.region()).toBe("absent")
    await writeStatus(directory, statusText(Date.now() - 5_000))
    await absent.readAgain()
    expect(absent.region()).toBe("live")
    absent.dispose()
    for (const [name, text, liveness] of [
      ["5 s old", statusText(Date.now() - 5_000), "live"],
      ["a minute old", statusText(Date.now() - 60_000), "still"],
      ["no heartbeat", statusText(undefined), "still"],
      ["ended", statusText(Date.now(), ENDED), "ended"],
    ] as const) {
      await writeStatus(directory, text)
      const machine = await machineOver(directory)
      expect({ name, liveness: machine.region() }).toEqual({ name, liveness })
      machine.dispose()
    }
    // A heartbeat that stops: 13 s old at the first read, more than 15 s old at a read 2.5 s later.
    await writeStatus(directory, statusText(Date.now() - 13_000))
    const aging = await machineOver(directory)
    expect(aging.region()).toBe("live")
    await Bun.sleep(2_500)
    await aging.readAgain()
    expect(aging.region()).toBe("still")
    // The heartbeat comes back: live again; the run ends: ended; the file goes: absent.
    await writeStatus(directory, statusText(Date.now()))
    await aging.readAgain()
    expect(aging.region()).toBe("live")
    await writeStatus(directory, statusText(Date.now(), ENDED))
    await aging.readAgain()
    expect(aging.region()).toBe("ended")
    await unlink(statusFile(directory))
    await aging.readAgain()
    expect(aging.region()).toBe("absent")
    aging.dispose()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

// --- the run keys, on the plugin -------------------------------------------------------------------------------------

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

/**
 * Loads the plugin entry on the route of ROOT, on design 7 (its bar names the selected task), with opencode's keymap,
 * the host's slot registry and opencode's agent key. The SDK answers ROOT's children with one harness session for each
 * title in `harness`.
 */
async function loadPlugin(directory: string, harness: ReadonlyArray<string>) {
  const requests: Array<string> = []
  const aborted: Array<string> = []
  const toasts: Array<TuiToast> = []
  const navigations: Array<Record<string, unknown> | undefined> = []
  const disposers: Array<TuiDispose> = []
  const agent = { moves: 0 }
  const slots = createSlots()
  const handles: { api?: TuiPluginApi } = {}
  const [loaded, setLoaded] = createSignal(false)

  function Host() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const keybinds = createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse({})), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    })
    registerOpencodeKeymap(keymap, renderer, { keybinds, leader_timeout: 2000 })
    // opencode's agent key, bound the way the app binds it: Tab that the plugin does not take reaches it.
    keymap.registerLayer({ commands: [{ name: "agent.cycle", run: () => void agent.moves++ }] })
    keymap.registerLayer({ mode: OPENCODE_BASE_MODE, bindings: keybinds.gather("app", ["agent.cycle"]) })
    const answer = async (request: RequestInfo | URL) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      requests.push(url.pathname)
      if (url.pathname === `/session/${ROOT}/children`)
        return Response.json(
          harness.map((title, index) => ({ id: `ses_harness_${index}`, title, time: { created: 1, updated: 1 } })),
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
    base.kv.set("task_ui_design", 7)
    const [current, setCurrent] = createSignal<TuiRouteCurrent>({ name: "session", params: { sessionID: ROOT } })
    const host = slots.setup(base)
    const registered = { count: 0 }
    handles.api = {
      ...base,
      route: {
        ...base.route,
        navigate: (name, params) => {
          navigations.push(params)
          setCurrent(params ? { name, params } : { name })
        },
        get current() {
          return current()
        },
      },
      state: { ...base.state, path: { ...base.state.path, directory } },
      slots: {
        register(plugin: TuiSlotPlugin) {
          registered.count += 1
          const id = `${meta.id}:${registered.count}`
          host.register({ ...plugin, id })
          return id
        },
      },
      ui: { ...base.ui, toast: (toast) => void toasts.push(toast) },
      lifecycle: {
        ...base.lifecycle,
        onDispose: (fn) => {
          disposers.push(fn)
          return () => {}
        },
      },
    }
    return createComponent(OpencodeKeymapProvider, {
      keymap,
      get children() {
        return createComponent(Show, {
          keyed: true,
          get when() {
            return loaded()
          },
          get children() {
            return slots.Slot({ name: "session_prompt_right", session_id: "" })
          },
        })
      },
    })
  }

  const app = await testRender(() => createComponent(Host, {}), { width: 250, height: 4 })
  const api = handles.api
  if (!api) throw new Error("the host did not render")
  await TaskUi.tui(api, undefined, meta)
  setLoaded(true)
  const frame = async () => {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  // The bar's line from the name on: the diamond before it is a spinner while the run is live.
  const bar = async () => {
    const line = (await frame()).split("\n").find((item) => item.includes(` ${NAME} `)) ?? ""
    return line.slice(line.indexOf(NAME)).trimEnd()
  }
  return {
    app,
    requests,
    aborted,
    toasts,
    navigations,
    agent,
    frame,
    bar,
    shows: (text: string, within?: number) => until(async () => (await bar()).includes(text), within),
    /** Waits until the plugin has read the status and the root's session list, so its keys know both. */
    ready: async () => {
      expect(await until(() => requests.includes(`/session/${ROOT}/children`))).toBe(true)
      await Bun.sleep(300)
    },
    leader: async (key: string) => {
      app.mockInput.pressKey("x", { ctrl: true })
      await Bun.sleep(40)
      app.mockInput.pressKey(key)
      await Bun.sleep(150)
    },
    async dispose() {
      for (const dispose of disposers.splice(0)) await dispose()
      app.renderer.destroy()
    },
  }
}

/** The harness's heartbeat: rewrites the status file with a fresh `aliveAt` every 500 ms until stopped. */
function beating(directory: string) {
  const write = () => Bun.write(statusFile(directory), statusText(Date.now()))
  const timer = setInterval(() => void write(), 500)
  return { first: write(), stop: () => clearInterval(timer) }
}

test("[UI3] while the view is live and the session owns its harness sessions, Tab, the watch key and esc twice act on the run", async () => {
  const directory = await tempDirectory()
  await mkdir(path.dirname(statusFile(directory)), { recursive: true })
  const heart = beating(directory)
  await heart.first
  const plugin = await loadPlugin(directory, ["T1.3 builder"])
  try {
    expect(await plugin.shows(`${NAME} Ticker`)).toBe(true)
    await plugin.ready()
    // Live: the bar offers Tab, and names the selected task, the focus T1.2.
    expect(await plugin.shows("tab select task")).toBe(true)
    expect(await plugin.shows("◐ T1.2 building")).toBe(true)
    // Tab selects the next task, in place of the agent key.
    plugin.app.mockInput.pressTab()
    expect(await plugin.shows("◑ T1.3 proving")).toBe(true)
    expect(plugin.agent.moves).toBe(0)
    // The watch key watches T1.3's builder in the root's frame.
    await plugin.leader("w")
    expect(await until(() => plugin.navigations.at(-1)?.watch === "ses_harness_0")).toBe(true)
    expect(await plugin.shows("esc stop run")).toBe(true)
    await Bun.sleep(200)
    // esc twice stops the run: the root session is aborted.
    plugin.app.mockInput.pressEscape()
    expect(await until(() => plugin.toasts.some((toast) => toast.message === "Press esc again to stop the run"))).toBe(
      true,
    )
    plugin.app.mockInput.pressEscape()
    expect(await until(() => plugin.aborted.length > 0)).toBe(true)
    expect(plugin.aborted).toEqual([ROOT])
    expect(
      await until(() => plugin.toasts.at(-1)?.message === `Run stopped. Type /task ${SPEC} to start it again.`),
    ).toBe(true)
    // Tab in the watch view still acts on the run: the next task in work.
    plugin.app.mockInput.pressTab()
    expect(await plugin.shows("◐ T1.2 building")).toBe(true)
    expect(plugin.agent.moves).toBe(0)
  } finally {
    heart.stop()
    await plugin.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

/** Presses Tab, the watch key and esc twice on a loaded plugin, and says what each one did to the run. */
async function pressRunKeys(plugin: Awaited<ReturnType<typeof loadPlugin>>) {
  const before = await plugin.bar()
  plugin.app.mockInput.pressTab()
  expect(await until(() => plugin.agent.moves === 1)).toBe(true)
  await plugin.leader("w")
  plugin.app.mockInput.pressEscape()
  await Bun.sleep(150)
  plugin.app.mockInput.pressEscape()
  await Bun.sleep(400)
  return {
    // Tab went to the agent key, and the selection did not move.
    agent: plugin.agent.moves,
    sameBar: (await plugin.bar()) === before,
    navigations: plugin.navigations,
    toasts: plugin.toasts.map((toast) => toast.message),
    aborted: plugin.aborted,
  }
}

test("[UI3] the run keys leave the run alone when the session does not own it, when the view is still or ended, and with no file", async () => {
  const alone = { agent: 1, sameBar: true, navigations: [], toasts: [], aborted: [] }
  {
    // Live, but the session owns no harness session of the run.
    const directory = await tempDirectory()
    await mkdir(path.dirname(statusFile(directory)), { recursive: true })
    const heart = beating(directory)
    await heart.first
    const plugin = await loadPlugin(directory, [])
    try {
      expect(await plugin.shows("◐ T1.2 building")).toBe(true)
      await plugin.ready()
      expect({ owner: "none", ...(await pressRunKeys(plugin)) }).toEqual({ owner: "none", ...alone })
    } finally {
      heart.stop()
      await plugin.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  }
  for (const [name, text] of [
    ["still: the heartbeat is a minute old", statusText(Date.now() - 60_000)],
    ["still: no heartbeat", statusText(undefined)],
    ["ended", statusText(Date.now(), ENDED)],
  ] as const) {
    const directory = await tempDirectory()
    await writeStatus(directory, text)
    const plugin = await loadPlugin(directory, ["T1.3 builder"])
    try {
      expect(await plugin.shows(`${NAME} Ticker`)).toBe(true)
      await plugin.ready()
      // Not live: the bar offers ctrl+x j/k instead of Tab.
      expect({ name, bar: (await plugin.bar()).includes("ctrl+x j/k select task") }).toEqual({ name, bar: true })
      expect({ name, ...(await pressRunKeys(plugin)) }).toEqual({ name, ...alone })
    } finally {
      await plugin.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  }
  {
    // No status file: nothing shows, and Tab reaches the agent key.
    const directory = await tempDirectory()
    const plugin = await loadPlugin(directory, ["T1.3 builder"])
    try {
      await plugin.ready()
      expect(await plugin.frame()).not.toContain(NAME)
      expect({ name: "no file", ...(await pressRunKeys(plugin)) }).toEqual({ name: "no file", ...alone })
    } finally {
      await plugin.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  }
}, 120_000)

test("[UI3] the stop key arms only while live, and a key armed while live stops nothing once the view is still or ended", async () => {
  const live = statusOf(statusText(NOW))
  /** The view over `first`, then `later` from the read a second on, with the clock of every read at NOW. */
  const watched = async (first: Status, later: ReadonlyArray<Status> = []) => {
    const made = await viewFor(first, { now: NOW, later })
    const heard: Array<string> = []
    made.listen("stop.warn", () => heard.push("warn"))
    made.listen("stop.run", () => heard.push("run"))
    await settle()
    const press = async () => {
      made.view.send({ type: "stop.key" })
      await settle()
    }
    return { ...made, heard, press }
  }
  // Still (the heartbeat 15 001 ms old) or ended: the key does not arm, so two presses neither warn nor stop.
  for (const [name, status] of [
    ["still", statusOf(statusText(NOW - LIVE_MS - 1))],
    ["ended", statusOf(statusText(NOW, ENDED))],
  ] as const) {
    const made = await watched(status)
    expect({ name, liveness: made.view.liveness() }).toEqual({ name, liveness: name })
    await made.press()
    await made.press()
    expect({ name, heard: made.heard }).toEqual({ name, heard: [] })
    made.dispose()
  }
  // Armed while live; before the second press the heartbeat goes stale, or the run ends: the second press stops nothing.
  for (const [name, later] of [
    ["still", statusOf(statusText(NOW - LIVE_MS - 1))],
    ["ended", statusOf(statusText(NOW, ENDED))],
  ] as const) {
    const made = await watched(live, [later])
    expect(made.view.liveness()).toBe("live")
    await made.press()
    expect({ name, heard: made.heard }).toEqual({ name, heard: ["warn"] })
    await made.advance(1_000)
    expect({ name, liveness: made.view.liveness() }).toEqual({ name, liveness: name })
    await made.press()
    expect({ name, heard: made.heard }).toEqual({ name, heard: ["warn"] })
    made.dispose()
  }
  // While live, the second press stops.
  const made = await watched(live)
  await made.press()
  await made.press()
  expect(made.heard).toEqual(["warn", "run"])
  made.dispose()
})
