import { expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Option, Scope } from "effect"
import { createActor, SimulatedClock } from "@jambudipa/xstate-effect"
import { createTestRenderer } from "@opentui/core/testing"
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
import { Show, createComponent, createRoot, createSignal } from "solid-js"
import { CLASS } from "@/task/engine-xstate/machine"
import { TuiKeybind } from "../../../tui/src/config/keybind"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../tui/src/keymap"
import { createSlots } from "../../../tui/src/plugin/slots"
import TaskUi from "../../../tui/src/task-ui/index"
import { TaskView } from "../../../tui/src/task-ui/machine"
import { liveSessions } from "../../../tui/src/task-ui/peek"
import { NAME, statusFile } from "../../../tui/src/task-ui/store"
import { viewOf, type View, type ViewActor } from "../../../tui/src/task-ui/view"
import { liveTail } from "../../../tui/src/task-ui/watch"
import { createTuiPluginApi } from "../../../tui/test/fixture/tui-plugin"

// Scenario UI2 (spec task-harness-feedback, D16, AD-16, AD-17; tasks T4.1, T4.3): the task-ui view state is one machine.
//
//   Given the task-ui plugin started for a session
//   When the user switches design, selects a task, expands, watches and presses the stop key once
//   Then the design, the selection, the expansion, the watch target and the stop-key arming are states and context of
//     one view machine
//   And the stop key disarms 5 seconds after it was armed
//   And the status, session list, activity lines and proof-log tail are read by delayed transitions every 1 s, 2 s,
//     1.5 s and 500 ms
//   And a status text that does not parse keeps the last good status
//
// The first test loads the real plugin entry (`TaskUi.tui`, as opencode loads it) on the route of the session ses_root,
// with opencode's own keymap and the host's slot registry, over a status file in a temporary directory; the keys are
// pressed on the opentui test renderer and the shortcut bar is read from its frame. The SDK client is a real client
// over a fetch that answers the root's children (one harness session) and records each abort. A scoped spy observes
// the actor passed to the plugin's real viewOf call without replacing its behavior. The other tests drive the
// real `taskView` machine (with its own feed `read` of `<directory>/.opencode/task/status.json`) on a SimulatedClock
// that moves only when a test moves it, with the view (`viewOf`), the Peek's session reads (`liveSessions`) and the
// watch's proof tail (`liveTail`) that the plugin builds over it.

const ROOT = "ses_root"
const SPEC = "task-formats/blend/release-notes.spec"

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

/** A live run (its heartbeat `aliveAt`): T1.1 trusted, T1.2 building, T1.3 proving, T1.4 and T1 waiting. */
const statusText = (aliveAt: number, change: Record<string, object> = {}) =>
  JSON.stringify({
    run: { state: "running", tags: [...CLASS.run.running.tags], spec: SPEC, path: SPEC, startedAt: 1, aliveAt },
    tasks: {
      T1: task("waiting", { attempts: 0, waitingOn: ["T1.4"] }),
      "T1.1": task("trusted"),
      "T1.2": task("building"),
      "T1.3": task("proving"),
      "T1.4": task("waiting", { attempts: 0, waitingOn: ["T1.2", "T1.3"] }),
      ...change,
    },
    obligations: {},
    scenarios: {},
    history: [],
  })

async function directoryWith(text: string) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "verify-ui2-")))
  await mkdir(path.dirname(statusFile(directory)), { recursive: true })
  await Bun.write(statusFile(directory), text)
  return directory
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

// --- the plugin, as opencode loads it --------------------------------------------------------------------------------

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
 * Loads the plugin entry on the route of ROOT, with opencode's keymap and the host's slot registry. The shortcut bar's
 * slot is on screen. The SDK answers ROOT's children with one harness session for each title in `harness`.
 */
async function loadPlugin(directory: string, harness: ReadonlyArray<string>, mounted: ReadonlyArray<string> = []) {
  const requests: Array<string> = []
  const aborted: Array<string> = []
  const toasts: Array<TuiToast> = []
  const navigations: Array<Record<string, unknown> | undefined> = []
  const disposers: Array<TuiDispose> = []
  const slots = createSlots()
  const handles: { api?: TuiPluginApi; actors: ViewActor[]; view?: View } = { actors: [] }
  const [loaded, setLoaded] = createSignal(false)

  function Host() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const keybinds = createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse({})), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    })
    registerOpencodeKeymap(keymap, renderer, { keybinds, leader_timeout: 2000 })
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
            return mounted.length
              ? ["session_prompt_right", ...mounted].map((name) => slots.Slot({ name, session_id: "" }))
              : slots.Slot({ name: "session_prompt_right", session_id: "" })
          },
        })
      },
    })
  }

  const app = await testRender(() => createComponent(Host, {}), { width: 250, height: mounted.length ? 30 : 4 })
  const api = handles.api
  if (!api) throw new Error("the host did not render")
  // Instrument only this plugin load. The original viewOf still creates the Solid adapter for the real actor.
  const module = await import("../../../tui/src/task-ui/view")
  const original = module.viewOf
  const capture = spyOn(module, "viewOf").mockImplementation((actor) => {
    handles.actors.push(actor)
    handles.view = original(actor)
    return handles.view
  })
  try {
    await TaskUi.tui(api, undefined, meta)
  } finally {
    capture.mockRestore()
  }
  const actor = handles.actors[0]
  const view = handles.view
  if (handles.actors.length !== 1 || !actor || !view) throw new Error("the plugin did not install one view actor")
  setLoaded(true)
  const frame = async () => {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  // The bar's line: the mark's diamond is a spinner while the run is live, so the line is found by the name after it.
  const bar = async () =>
    (await frame())
      .split("\n")
      .find((line) => line.includes(` ${NAME} `))
      ?.trimEnd() ?? ""
  return {
    app,
    api,
    actor,
    view,
    snapshot: () => Effect.runSync(actor.getSnapshot),
    requests,
    aborted,
    toasts,
    navigations,
    frame,
    bar,
    shows: (text: string, within?: number) => until(async () => (await bar()).includes(text), within),
    /** A leader chord: ctrl+x, then `key`. */
    leader: async (key: string) => {
      app.mockInput.pressKey("x", { ctrl: true })
      await Bun.sleep(40)
      app.mockInput.pressKey(key)
      await Bun.sleep(80)
    },
    async dispose() {
      for (const dispose of disposers.splice(0)) await dispose()
      app.renderer.destroy()
    },
  }
}

test("[UI2] the plugin started for a session: design, selection, expansion, watch and one stop key, then the 5 s disarm and a status that does not parse", async () => {
  const directory = await directoryWith(statusText(Date.now() + 120_000))
  const plugin = await loadPlugin(directory, ["T1.3 builder"])
  try {
    // Started on design 1, the run live, the root owning its harness session.
    expect(await plugin.shows(`${NAME} Ledger`)).toBe(true)
    expect(await until(() => plugin.requests.includes(`/session/${ROOT}/children`))).toBe(true)
    expect(await plugin.shows("tab select task")).toBe(true)
    expect(plugin.snapshot().value).toMatchObject({ expansion: "collapsed", watch: "off", stopKey: "disarmed" })
    expect(plugin.snapshot().context).toMatchObject({ directory, design: 1, root: ROOT, owns: true })
    expect(plugin.view.selected()).toBe("T1.2")

    // Switch the design: ctrl+x v six times, Ledger to Ticker; the plugin keeps it in kv.
    for (let press = 0; press < 6; press++) await plugin.leader("v")
    expect(await plugin.shows(`${NAME} Ticker`)).toBe(true)
    expect(plugin.api.kv.get("task_ui_design", 0)).toBe(7)
    expect(plugin.toasts.at(-1)?.title).toBe("Task design 7: Ticker")
    expect(plugin.snapshot().context.design).toBe(7)
    // The Ticker's bar names the selected task: the focus, T1.2, the first task in work.
    expect(await plugin.shows("◐ T1.2 building")).toBe(true)

    // Select: ctrl+x j moves to the next task.
    await plugin.leader("j")
    expect(await plugin.shows("◑ T1.3 proving")).toBe(true)
    expect(plugin.snapshot().context.chosen).toEqual(Option.some("T1.3"))

    // Expand: ctrl+x o; the bar's key now collapses.
    expect(await plugin.bar()).toContain("ctrl+x o expand")
    await plugin.leader("o")
    expect(await plugin.shows("ctrl+x o collapse")).toBe(true)
    expect(plugin.snapshot().value).toMatchObject({ expansion: "expanded" })

    // Watch: ctrl+x w puts T1.3's builder in the root's watch frame and the bar shows the watch keys.
    await plugin.leader("w")
    expect(await until(() => plugin.navigations.at(-1)?.watch === "ses_harness_0")).toBe(true)
    expect(plugin.navigations.at(-1)).toEqual({ sessionID: ROOT, watch: "ses_harness_0" })
    expect(await plugin.shows("tab next running  ctrl+x w stop watching  esc stop run")).toBe(true)
    expect(plugin.snapshot().value).toMatchObject({ expansion: "collapsed", watch: "on" })
    expect(plugin.snapshot().context.target).toBe("ses_harness_0")
    await Bun.sleep(200)

    // The stop key once: it warns and arms. (The design switches toasted before: count from here.)
    const from = plugin.toasts.length
    const since = () => plugin.toasts.slice(from).map((toast) => toast.message)
    plugin.app.mockInput.pressEscape()
    expect(await until(() => since().length > 0)).toBe(true)
    expect(since()).toEqual(["Press esc again to stop the run"])
    expect(plugin.snapshot()).toMatchObject({
      value: { expansion: "collapsed", watch: "on", stopKey: "armed" },
      context: { design: 7, chosen: Option.some("T1.3"), target: "ses_harness_0" },
    })
    // Five seconds later it has disarmed: the next esc warns again and stops nothing.
    await Bun.sleep(5_300)
    expect(await until(() => plugin.snapshot().matches({ stopKey: "disarmed" }), 3_000)).toBe(true)
    plugin.app.mockInput.pressEscape()
    expect(await until(() => since().length > 1)).toBe(true)
    expect(since()).toEqual(["Press esc again to stop the run", "Press esc again to stop the run"])
    expect(plugin.snapshot().value).toMatchObject({ stopKey: "armed" })
    expect(plugin.aborted).toEqual([])
    // Armed again, a second esc within the window stops the run: the root session is aborted.
    plugin.app.mockInput.pressEscape()
    expect(await until(() => since().length > 2)).toBe(true)
    expect(plugin.aborted).toEqual([ROOT])
    expect(since().at(-1)).toBe(`Run stopped. Type /task ${SPEC} to start it again.`)
    expect(plugin.snapshot().value).toMatchObject({ stopKey: "disarmed" })

    // A status text that does not parse (a half-written file) keeps the last good status on screen.
    await Bun.write(statusFile(directory), "{")
    await Bun.sleep(2_500)
    expect(await plugin.bar()).toContain(`${NAME} Ticker`)
    expect(await plugin.bar()).toContain("◑ T1.3 proving")
    expect(plugin.snapshot().context.text).toBe("{")
    expect(plugin.view.status()?.tasks["T1.3"].state).toBe("proving")
    // A file that is gone clears it: the bar goes.
    await unlink(statusFile(directory))
    expect(await until(async () => !(await plugin.frame()).includes(NAME), 5_000)).toBe(true)
    expect(Option.isNone(plugin.snapshot().context.status)).toBe(true)
  } finally {
    await plugin.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

test("[UI2] the plugin's installed readers follow the same actor's delayed feed, session, activity and tail ticks", async () => {
  const directory = await directoryWith(statusText(Date.now() + 120_000))
  const log = path.join(directory, ".opencode", "task", "proofs", "T1.3.log")
  await mkdir(path.dirname(log), { recursive: true })
  await Bun.write(log, "$ bun test\n")
  const plugin = await loadPlugin(directory, ["T1.2 builder", "T1.3 builder"], ["sidebar_content", "session_watch"])
  const count = (path: string) => plugin.requests.filter((request) => request === path).length
  const children = `/session/${ROOT}/children`
  const activity = "/session/ses_harness_0/message"
  try {
    expect(await until(() => Option.isSome(plugin.snapshot().context.status) && count(children) > 0)).toBe(true)
    expect(Object.keys(plugin.snapshot().context.ticks)).toEqual(["sessions", "activity", "tail"])
    // The installed Ledger Peek starts its activity reader when expansion mounts it.
    await plugin.leader("o")
    expect(await until(() => plugin.snapshot().matches({ expansion: "expanded" }) && count(activity) > 0)).toBe(true)
    const before = plugin.snapshot().context.ticks
    const activityReads = count(activity)
    const sessionReads = count(children)
    expect(await until(() => plugin.snapshot().context.ticks.activity > before.activity)).toBe(true)
    expect(await until(() => count(activity) > activityReads)).toBe(true)
    expect(await until(() => plugin.snapshot().context.ticks.sessions > before.sessions)).toBe(true)
    expect(await until(() => count(children) > sessionReads)).toBe(true)
    await plugin.leader("j")
    expect(await until(() => Option.getOrUndefined(plugin.snapshot().context.chosen) === "T1.3")).toBe(true)

    // The same actor's feed reads the changed status; no independent plugin poll is installed.
    await Bun.write(statusFile(directory), statusText(Date.now() + 120_000, { "T1.2": task("trusted") }))
    const feed = plugin.snapshot().context.text
    expect(await until(() => plugin.snapshot().context.text !== feed)).toBe(true)
    expect(plugin.view.status()?.tasks["T1.2"].state).toBe("trusted")

    // Watch a proving task: the mounted session_watch slot installs the proof-tail reader.
    await plugin.leader("w")
    expect(await until(() => plugin.snapshot().context.target === "ses_harness_1")).toBe(true)
    expect(await until(async () => (await plugin.frame()).includes("$ bun test"))).toBe(true)
    const tail = plugin.snapshot().context.ticks.tail
    await Bun.write(log, "$ bun test\n 3 pass\n")
    expect(await until(() => plugin.snapshot().context.ticks.tail > tail)).toBe(true)
    expect(await until(async () => (await plugin.frame()).includes("3 pass"))).toBe(true)
  } finally {
    await plugin.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

// --- the view machine --------------------------------------------------------------------------------------------

/** The real taskView machine over `directory` on a SimulatedClock, with the view the plugin builds over it. */
async function machineOver(directory: string, design = 1) {
  const scope = Effect.runSync(Scope.make())
  const clock = new SimulatedClock()
  const actor = await Effect.runPromise(
    Scope.provide(scope)(createActor(TaskView.machine, { input: { directory, design }, clock })),
  )
  const emitted: Array<string> = []
  await Effect.runPromise(
    Scope.provide(scope)(actor.on("*", (event) => Effect.sync(() => void emitted.push(event.type)))),
  )
  await Effect.runPromise(actor.start)
  const root = createRoot((dispose) => ({ view: viewOf(actor), dispose }))
  const snapshot = () => Effect.runSync(actor.getSnapshot)
  // The feed's read runs on its own fiber: wait for it to reach the context.
  const settle = async () => {
    for (let round = 0; round < 3; round++) {
      await Bun.sleep(5)
      for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve))
    }
  }
  await until(() => Option.isSome(snapshot().context.status))
  return {
    actor,
    view: root.view,
    emitted,
    snapshot,
    settle,
    send: async (event: TaskView.Event) => {
      await Effect.runPromise(actor.send(event))
      await settle()
    },
    advance: async (ms: number) => {
      await Effect.runPromise(clock.increment(ms))
      await settle()
    },
    dispose: () => {
      root.dispose()
      Effect.runSync(Scope.close(scope, Exit.void))
    },
  }
}

test("[UI2] the design, the selection, the expansion, the watch target and the stop-key arming are states and context of one view machine", async () => {
  const directory = await directoryWith(statusText(Date.now() + 120_000))
  const machine = await machineOver(directory)
  try {
    // One machine: its regions run in parallel, a region for each kind of view state and each cadence.
    expect(TaskView.machine.root.type).toBe("parallel")
    expect(Object.keys(TaskView.machine.root.states)).toEqual([
      "feed",
      "expansion",
      "watch",
      "stopKey",
      "liveness",
      "sessions",
      "activity",
      "tail",
    ])
    expect(machine.snapshot().value).toMatchObject({
      expansion: "collapsed",
      watch: "off",
      stopKey: "disarmed",
      liveness: "live",
    })

    await machine.send({ type: "design.set", id: 4 })
    await machine.send({ type: "select", id: "T1.3" })
    await machine.send({ type: "expand.toggle" })
    await machine.send({ type: "watch.set", on: true })
    await machine.send({ type: "watch.target", session: "ses_harness_0", keep: false })
    await machine.send({ type: "stop.key" })

    // All of it is in one snapshot of the one actor: three states and three context values.
    const after = machine.snapshot()
    expect(after.value).toMatchObject({ expansion: "expanded", watch: "on", stopKey: "armed", liveness: "live" })
    expect({ design: after.context.design, chosen: after.context.chosen, target: after.context.target }).toEqual({
      design: 4,
      chosen: Option.some("T1.3"),
      target: "ses_harness_0",
    })
    expect(Option.getOrUndefined(TaskView.selected(after.context))).toBe("T1.3")
    expect(machine.emitted).toEqual(["stop.warn"])
    // The view the designs read gives back the machine's values; it keeps none of its own.
    expect({
      design: machine.view.design(),
      selected: machine.view.selected(),
      expanded: machine.view.expanded(),
      watching: machine.view.watching(),
      target: machine.view.target(),
    }).toEqual({ design: 4, selected: "T1.3", expanded: true, watching: true, target: "ses_harness_0" })

    // The stop key disarms 5 s after it was armed: still armed at 4 999 ms, disarmed at 5 000 ms, with no stop.
    await machine.advance(4_999)
    expect(machine.snapshot().value).toMatchObject({ stopKey: "armed" })
    await machine.advance(1)
    expect(machine.snapshot().value).toMatchObject({ stopKey: "disarmed" })
    expect(machine.emitted).toEqual(["stop.warn"])
    // Armed again, a second press within the window stops.
    await machine.send({ type: "stop.key" })
    await machine.send({ type: "stop.key" })
    expect(machine.emitted).toEqual(["stop.warn", "stop.warn", "stop.run"])
    expect(machine.snapshot().value).toMatchObject({ stopKey: "disarmed" })
    // Watch off clears the target: the target is the watch's context.
    await machine.send({ type: "watch.set", on: false })
    expect(machine.snapshot().context.target).toBe("")
  } finally {
    machine.dispose()
    await rm(directory, { recursive: true, force: true })
  }

  // One actor for the plugin, and the adapter's one signal: no other view state in the task-ui.
  const TASK_UI = path.resolve(import.meta.dir, "../../../tui/src/task-ui")
  const files = (await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: TASK_UI }))).sort()
  const uses = async (construct: string) =>
    (
      await Promise.all(
        files.map(async (file) => {
          const text = await Bun.file(path.join(TASK_UI, file)).text()
          return text.split(construct).length > 1 ? [`${file}:${text.split(construct).length - 1}`] : []
        }),
      )
    ).flat()
  expect(await uses("createActor(")).toEqual(["index.tsx:1"])
  expect(await uses("createSignal(")).toEqual(["actor.ts:1"])
  const index = await Bun.file(path.join(TASK_UI, "index.tsx")).text()
  expect(index).toContain("createActor(TaskView.machine, { input: { directory: api.state.path.directory, design } })")
})

test("[UI2] the status, the session list, the activity lines and the proof-log tail are read by delayed transitions every 1 s, 2 s, 1.5 s and 500 ms", async () => {
  // The cadences are the machine's delays, and each is a delayed (`after`) transition of its region.
  expect(TaskView.machine.implementations.delays).toEqual({
    feed: 1_000,
    sessions: 2_000,
    activity: 1_500,
    tail: 500,
    stopWindow: 5_000,
  })
  const afterOf = (region: string, state: string) =>
    TaskView.machine.root.states[region].states[state].after.map((transition) => transition.delay)
  expect(afterOf("feed", "resting")).toEqual(["feed"])
  expect(afterOf("sessions", "ticking")).toEqual(["sessions"])
  expect(afterOf("activity", "ticking")).toEqual(["activity"])
  expect(afterOf("tail", "ticking")).toEqual(["tail"])
  expect(afterOf("stopKey", "armed")).toEqual(["stopWindow"])

  const directory = await directoryWith(statusText(Date.now() + 120_000))
  const log = path.join(directory, ".opencode", "task", "proofs", "T1.3.log")
  await mkdir(path.dirname(log), { recursive: true })
  await Bun.write(log, "$ bun test\n")
  const machine = await machineOver(directory)
  const counts = { children: 0, messages: 0 }
  const answer = async (request: RequestInfo | URL) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    if (url.pathname === `/session/${ROOT}/children`) counts.children++
    if (url.pathname === "/session/ses_b/message") counts.messages++
    return Response.json([])
  }
  const client = createOpencodeClient({
    baseUrl: "http://localhost:4096",
    fetch: Object.assign(answer, { preconnect: fetch.preconnect }),
  })
  const screen = await createTestRenderer({ width: 40, height: 4 })
  const api = createTuiPluginApi({ renderer: screen.renderer, client })
  try {
    await machine.send({ type: "route.changed", session: ROOT })
    const reads = createRoot((dispose) => {
      const sessions = liveSessions(api, machine.view)
      return { all: sessions.all(), activity: sessions.activity("ses_b"), tail: liveTail(log, machine.view), dispose }
    })
    // Read each once at the start.
    expect(await until(() => counts.children === 1 && counts.messages === 1 && reads.tail().text !== "")).toBe(true)
    expect(reads.tail().text).toBe("$ bun test\n")
    expect(machine.snapshot().context.ticks).toEqual({ sessions: 0, activity: 0, tail: 0 })

    // The status: a new file is read 1 s after the last read, not before.
    await Bun.write(statusFile(directory), statusText(Date.now() + 120_000, { "T1.2": task("trusted") }))
    await Bun.write(log, "$ bun test\n 3 pass\n")
    await machine.advance(499)
    expect(machine.view.status()?.tasks["T1.2"].state).toBe("building")
    expect(reads.tail().text).toBe("$ bun test\n")
    // 500 ms: the proof tail is read again.
    await machine.advance(1)
    expect(await until(() => reads.tail().text === "$ bun test\n 3 pass\n")).toBe(true)
    await machine.advance(499)
    expect(machine.view.status()?.tasks["T1.2"].state).toBe("building")
    // 1 000 ms: the status is read again.
    await machine.advance(1)
    expect(await until(() => machine.view.status()?.tasks["T1.2"].state === "trusted")).toBe(true)
    expect(counts).toEqual({ children: 1, messages: 1 })
    // 1 500 ms: the activity lines are read again; the session list is not.
    await machine.advance(499)
    expect(counts).toEqual({ children: 1, messages: 1 })
    await machine.advance(1)
    expect(await until(() => counts.messages === 2)).toBe(true)
    expect(counts.children).toBe(1)
    // 2 000 ms: the session list is read again.
    await machine.advance(499)
    expect(counts.children).toBe(1)
    await machine.advance(1)
    expect(await until(() => counts.children === 2)).toBe(true)
    // 3 000 ms: activity again; 4 000 ms: the session list again. Each cadence counts its ticks in the context.
    await machine.advance(1_000)
    expect(await until(() => counts.messages === 3)).toBe(true)
    await machine.advance(1_000)
    expect(await until(() => counts.children === 3)).toBe(true)
    expect(counts.messages).toBe(3)
    expect(machine.snapshot().context.ticks).toEqual({ sessions: 2, activity: 2, tail: 8 })
    reads.dispose()
  } finally {
    machine.dispose()
    screen.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test("[UI2] a status text that does not parse keeps the last good status", async () => {
  const directory = await directoryWith(statusText(Date.now() + 120_000))
  const machine = await machineOver(directory)
  try {
    const good = machine.snapshot().context.status
    expect(Option.getOrUndefined(good)?.tasks["T1.2"].state).toBe("building")
    // Half written, empty, and another shape: each read takes the text and keeps the status.
    for (const text of ["{", "", '{"run":{}}']) {
      await Bun.write(statusFile(directory), text)
      await machine.advance(1_000)
      expect(await until(() => machine.snapshot().context.text === text)).toBe(true)
      expect({ text, status: machine.snapshot().context.status }).toEqual({ text, status: good })
      expect({ text, state: machine.view.status()?.tasks["T1.2"].state }).toEqual({ text, state: "building" })
      expect({ text, liveness: machine.view.liveness() }).toEqual({ text, liveness: "live" })
    }
    // The next good text replaces it.
    await Bun.write(statusFile(directory), statusText(Date.now() + 120_000, { "T1.2": task("trusted") }))
    await machine.advance(1_000)
    expect(await until(() => machine.view.status()?.tasks["T1.2"].state === "trusted")).toBe(true)
    // A file that is gone is no status at all.
    await unlink(statusFile(directory))
    await machine.advance(1_000)
    expect(await until(() => Option.isNone(machine.snapshot().context.status))).toBe(true)
    expect(machine.view.liveness()).toBe("absent")
  } finally {
    machine.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
