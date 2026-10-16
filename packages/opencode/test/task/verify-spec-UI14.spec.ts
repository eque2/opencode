import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Option, Result } from "effect"
import path from "path"
import { TextAttributes, type CapturedFrame, type Renderable, type RGBA } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { jsx } from "@opentui/solid/jsx-runtime"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { Show, createComponent, createRoot, createSignal, type JSX } from "solid-js"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type {
  TuiDialogSelectProps,
  TuiDispose,
  TuiPluginApi,
  TuiPluginMeta,
  TuiSlotPlugin,
  TuiToast,
} from "@opencode-ai/plugin/tui"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, observed, trustLeaf } from "./lib/machine"
import { TuiKeybind } from "../../../tui/src/config/keybind"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../tui/src/keymap"
import { createSlots } from "../../../tui/src/plugin/slots"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import TaskUi from "../../../tui/src/task-ui/index"
import { Peek, type Sessions } from "../../../tui/src/task-ui/peek"
import { MARK, parse, tagged, type Status } from "../../../tui/src/task-ui/store"
import { ShortcutBar } from "../../../tui/src/task-ui/ui"
import { WatchBand, chooseWatch } from "../../../tui/src/task-ui/watch"
import { LedgerView } from "../../../tui/src/task-ui/designs/1-ledger"
import { DockView } from "../../../tui/src/task-ui/designs/2-dock"
import { HudView } from "../../../tui/src/task-ui/designs/6-hud"
import { TickerDialog } from "../../../tui/src/task-ui/designs/7-ticker"
import { Screen } from "../../../tui/src/task-ui/designs/screen"
import { createTuiPluginApi } from "../../../tui/test/fixture/tui-plugin"
import { viewFor } from "../../../tui/test/task-ui/view"

// Scenario UI14 (spec task-harness-feedback, D23, AD-16, owner ruling 5; task T4.9): the In the Flow diamond grows and
// melts while the run is live.
//
//   Given a live run
//   When any In the Flow mark renders
//   Then its diamond plays the frames · ⬩ ⬪ ⬥ ◆ ⬥ ⬪ ⬩ at about 120 ms each through the spinner element
//   And it is a static ◆ when the run has ended or animations are off
//   And the Peek border title and the toast title stay static
//   And the diamond is not bold in either form
//
// The statuses are the harness's own: release-notes facts folded by the engine, projected by `TaskStatus.project` and
// written by `TaskStatus.write` (a live run: running with the `active` tag; an ended run: the same facts then a cancel).
// Every mark site is the real task-ui code on a real taskView actor (the tui test helper `viewFor`, whose clock sits at
// the heartbeat), rendered by the opentui test renderer: the Ledger, the Dock, the HUD, the full screen (Board, Matrix,
// Gantt), the Ticker dialog, the shortcut bar of each design, and the watch band. The spinner element is the
// `opentui-spinner` renderable the task-ui registers (it is found by its `frames` and `interval`); its frames are
// sampled over time from the rendered cells. The animations setting is the host's: the real plugin entry reads kv
// `animations_enabled`, and the design props carry it as `motion`. This file is .spec.ts, so components render through
// `createComponent`, which is what JSX compiles to, and intrinsic elements through the opentui `jsx` runtime.

const it = testEffect(NodeServices.layer)

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }
/** The heartbeat the status writer stamps for the rendered sites; the view's clock sits there, so a run is live. */
const ALIVE_AT = 1_791_000_000_000
const FRAMES = ["·", "⬩", "⬪", "⬥", "◆", "⬥", "⬪", "⬩"]
const NAME = " In the Flow"

/** The release-notes run with T1.1 to T1.3 trusted and T1.4's builder at work. */
const building = (plan: Plan) => {
  const f = facts()
  return [
    f.runStarted(),
    ...trustLeaf(plan, f, "T1.1"),
    ...trustLeaf(plan, f, "T1.2"),
    ...trustLeaf(plan, f, "T1.3"),
    f.started("T1.4"),
  ]
}

/** T1.4's builder at work, then the developer's cancel: the run has ended. */
const cancelled = (plan: Plan) => {
  const f = facts()
  return [
    f.runStarted(),
    ...trustLeaf(plan, f, "T1.1"),
    ...trustLeaf(plan, f, "T1.2"),
    ...trustLeaf(plan, f, "T1.3"),
    f.started("T1.4"),
    f.cancelled("stopped by the developer"),
  ]
}

/** The observed run, then a spec check that finds two failures: T1.4 is budget exhausted and the run is warned. */
const warned = (plan: Plan) => {
  const f = facts()
  return [
    ...observed(plan, f),
    f.checked([
      { rule: "R3", path: "T1.4/VERIFY.md", message: "obligation T1.4.c9 is not in the loaded plan" },
      { rule: "R4", path: "T1.4/TASK.md", message: "the task has no H1" },
    ]),
  ]
}

/** Writes the status the harness writes after `list`, stamped `aliveAt`, into `directory` (a new one by default). */
const written = Effect.fnUntraced(function* (
  list: (plan: Plan) => ReadonlyArray<Fact>,
  aliveAt = ALIVE_AT,
  into?: string,
) {
  const plan = yield* loadPlan("release-notes.spec")
  const snapshot = list(plan).reduce(
    (each, fact) => TaskEngineXState.apply(plan, each, fact),
    TaskEngineXState.initial(plan),
  )
  const fs = yield* FileSystem.FileSystem
  const directory = into ?? (yield* fs.makeTempDirectoryScoped())
  yield* TaskStatus.write(directory, TaskStatus.project(plan, snapshot), aliveAt)
  const text = yield* fs.readFileString(path.join(directory, ".opencode", "task", "status.json"))
  return { directory, status: Option.getOrThrow(parse(text)) }
})

type ViewOf = Awaited<ReturnType<typeof viewFor>>["view"]

/** A real taskView actor over `status`, disposed with the test's scope. */
const viewOf = (status: Status, design: number) =>
  Effect.acquireRelease(
    Effect.promise(() => viewFor(status, { design })),
    (made) => Effect.sync(made.dispose),
  )

/** The spinner element the task-ui registers, as the test sees it. */
type Spinner = { readonly frames: ReadonlyArray<string>; readonly interval: number; readonly color: unknown }

const isSpinner = (node: object): node is Spinner =>
  "frames" in node && Array.isArray(node.frames) && "interval" in node && typeof node.interval === "number"

/** The spinner elements under a renderable. */
const spinners = (node: Renderable): ReadonlyArray<Spinner> => [
  ...(isSpinner(node) ? [node] : []),
  ...node.getChildren().flatMap(spinners),
]

/** The cell before `after` on the first line that holds it, and that cell's style. */
const markOf = (text: string, spans: CapturedFrame, after: string) => {
  const row = text.split("\n").findIndex((line) => line.includes(after))
  if (row < 0) return { cell: "", bold: false, fg: [] as ReadonlyArray<number>, nameBold: false }
  const line = text.split("\n")[row]
  const cell = line.slice(line.indexOf(after) - 1, line.indexOf(after))
  // The spans of the row, in order: the diamond is the last cell of the span before the one that starts the name.
  const list = spans.lines[row]?.spans ?? []
  const name = list.findIndex((span) => span.text.startsWith(NAME) || span.text.includes(`${cell}${NAME}`))
  const own = list[name]?.text.includes(`${cell}${NAME}`) ? list[name] : list[name - 1]
  return {
    cell,
    bold: ((own?.attributes ?? 0) & TextAttributes.BOLD) !== 0,
    fg: rgb(own?.fg),
    nameBold: ((list[name]?.attributes ?? 0) & TextAttributes.BOLD) !== 0,
  }
}

const rgb = (value: RGBA | undefined): ReadonlyArray<number> => (value ? [value.r, value.g, value.b] : [])

/** Renders `node` once: its spinner elements, its text and its spans. */
const render = (node: () => JSX.Element, width = 160, height = 40) =>
  Effect.promise(async () => {
    const app = await testRender(node, { width, height })
    try {
      await app.renderOnce()
      return { found: spinners(app.renderer.root), text: app.captureCharFrame(), spans: app.captureSpans() }
    } finally {
      app.renderer.destroy()
    }
  })

/** Renders `node` and samples the cell before `after` every few milliseconds for `ms`, with the time of each sample. */
const sample = (node: () => JSX.Element, after: string, ms: number, width = 160, height = 40) =>
  Effect.promise(async () => {
    const app = await testRender(node, { width, height })
    try {
      const seen: Array<{ at: number; cell: string; bold: boolean }> = []
      const end = performance.now() + ms
      while (performance.now() < end) {
        await app.renderOnce()
        const mark = markOf(app.captureCharFrame(), app.captureSpans(), after)
        seen.push({ at: performance.now(), cell: mark.cell, bold: mark.bold })
        await Bun.sleep(8)
      }
      return seen
    } finally {
      app.renderer.destroy()
    }
  })

/** Each In the Flow site of the task-ui over `view`, and the text after its mark. */
const sites = (status: Status, view: (design: number) => ViewOf, motion: boolean) => {
  const props = (design: number) => ({
    theme: () => theme,
    view: view(design),
    sessions: none,
    leader: "ctrl+x",
    motion: () => motion,
  })
  const watch = chooseWatch({
    status,
    task: "T1.4",
    children: [{ id: "ses_b1", role: "builder", again: false, created: 1, updated: 1 }],
    loaded: () => true,
  })
  return [
    { site: "Ledger", after: `${NAME} run:`, node: () => createComponent(LedgerView, { ...props(1), width: 38 }) },
    { site: "Dock", after: NAME, node: () => createComponent(DockView, { ...props(2), width: 160 }) },
    {
      site: "Board",
      after: `${NAME} Board`,
      node: () => createComponent(Screen, { ...props(3), width: 160, height: 40 }),
    },
    {
      site: "Matrix",
      after: `${NAME} Matrix`,
      node: () => createComponent(Screen, { ...props(4), width: 160, height: 40 }),
    },
    {
      site: "Gantt",
      after: `${NAME} Gantt`,
      node: () => createComponent(Screen, { ...props(5), width: 160, height: 40 }),
    },
    { site: "HUD", after: NAME, node: () => createComponent(HudView, props(6)) },
    { site: "Ticker dialog", after: `${NAME} tasks`, node: () => createComponent(TickerDialog, props(7)) },
    ...[1, 2, 3, 4, 5, 6, 7].map((design) => ({
      site: `bar ${design}`,
      after: NAME,
      node: () => createComponent(ShortcutBar, { ...props(design), width: 200 }),
    })),
    {
      site: "watch band",
      after: NAME,
      node: () =>
        createComponent(WatchBand, {
          theme: () => theme,
          watch,
          width: 120,
          live: view(1).live(),
          motion,
        }),
    },
  ]
}

/** One real view actor per design over `status`, made before the sites render. */
const viewsOf = Effect.fnUntraced(function* (status: Status) {
  const views: Array<ViewOf> = []
  for (const design of [1, 2, 3, 4, 5, 6, 7]) views.push((yield* viewOf(status, design)).view)
  return (design: number) => views[design - 1]
})

it.live(
  "[UI14] while the run is live, every In the Flow mark's diamond is the spinner element: · ⬩ ⬪ ⬥ ◆ ⬥ ⬪ ⬩ at 120 ms, accent, not bold",
  () =>
    Effect.gen(function* () {
      const { status } = yield* written(building)
      expect(status.run.state).toBe("running")
      expect(tagged(status.run, "ended")).toBe(false)
      const view = yield* viewsOf(status)
      expect([1, 2, 3, 4, 5, 6, 7].map((design) => view(design).live())).toEqual([
        true,
        true,
        true,
        true,
        true,
        true,
        true,
      ])
      // Every frame is one cell wide, so the name after the diamond never moves.
      expect(FRAMES.every((cell) => Bun.stringWidth(cell) === 1)).toBe(true)
      for (const site of sites(status, view, true)) {
        const shown = yield* render(site.node)
        // One spinner element at the site, with the diamond's frames and interval, in the accent tone.
        expect({ site: site.site, spinners: shown.found.length }).toEqual({ site: site.site, spinners: 1 })
        const spinner = shown.found[0]
        expect({ site: site.site, frames: [...spinner.frames], interval: spinner.interval }).toEqual({
          site: site.site,
          frames: FRAMES,
          interval: 120,
        })
        expect({ site: site.site, accent: spinner.color === theme.accent }).toEqual({ site: site.site, accent: true })
        // The drawn diamond is one of the frames, not bold, in the accent tone; the name after it is bold.
        const mark = markOf(shown.text, shown.spans, site.after)
        expect({
          site: site.site,
          frame: FRAMES.includes(mark.cell),
          bold: mark.bold,
          nameBold: mark.nameBold,
        }).toEqual({
          site: site.site,
          frame: true,
          bold: false,
          nameBold: true,
        })
        expect({ site: site.site, fg: mark.fg }).toEqual({ site: site.site, fg: rgb(theme.accent) })
      }
    }),
  180_000,
)

/** The distinct cells of a sample in order, each with how long it showed (from its first sample to the next cell's). */
const runs = (seen: ReadonlyArray<{ at: number; cell: string }>) =>
  seen.reduce<Array<{ cell: string; from: number; to: number }>>((list, item) => {
    const last = list.at(-1)
    if (last && last.cell === item.cell) return [...list.slice(0, -1), { ...last, to: item.at }]
    return [...list, { cell: item.cell, from: item.at, to: item.at }]
  }, [])

/** The frames that may follow `cell` in the cycle (a frame shown twice in a row is one longer showing). */
const NEXT: Record<string, ReadonlyArray<string>> = {
  "·": ["⬩"],
  "⬩": ["⬪", "·"],
  "⬪": ["⬥", "⬩"],
  "⬥": ["◆", "⬪"],
  "◆": ["⬥"],
}

it.live(
  "[UI14] the live diamond grows and melts: it steps through the frames in their order, about 120 ms each, never bold",
  () =>
    Effect.gen(function* () {
      const { status } = yield* written(building)
      const { view } = yield* viewOf(status, 1)
      expect(view.live()).toBe(true)
      const props = { theme: () => theme, view, sessions: none, leader: "ctrl+x", motion: () => true }
      const seen = yield* sample(
        () => createComponent(LedgerView, { ...props, width: 38 }),
        `${NAME} run:`,
        3_000,
        60,
        30,
      )
      const shown = runs(seen)
      // Every sampled cell is a frame, never bold.
      expect(seen.filter((item) => !FRAMES.includes(item.cell))).toEqual([])
      expect(seen.filter((item) => item.bold)).toEqual([])
      // It moves: the whole cycle shows, from the dot to the full diamond.
      expect(new Set(shown.map((item) => item.cell))).toEqual(new Set(["·", "⬩", "⬪", "⬥", "◆"]))
      // Each change goes to a neighbouring frame of the cycle: it grows to ◆ and melts back to ·.
      const steps = shown.slice(1).map((item, index) => `${shown[index].cell}${item.cell}`)
      expect(steps.filter((step) => !(NEXT[step[0]] ?? []).includes(step[1]))).toEqual([])
      expect(steps).toContain("⬥◆")
      expect(steps).toContain("◆⬥")
      expect(steps).toContain("⬩·")
      expect(steps).toContain("·⬩")
      // About 120 ms each: the dot and the full diamond show once per cycle, so a showing of either whose start and
      // end were both sampled lasts one frame.
      const whole = shown.slice(1, -1).filter((item) => item.cell === "◆" || item.cell === "·")
      const times = whole.map((item) => {
        const next = shown[shown.indexOf(item) + 1]
        return Math.round((next?.from ?? item.to) - item.from)
      })
      expect(whole.length).toBeGreaterThanOrEqual(3)
      const sorted = [...times].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]
      expect({ median, about120: median >= 80 && median <= 260 }).toEqual({ median, about120: true })
      // Over 3 s at 120 ms a frame, the cycle of 8 frames turns about 3 times: between 12 and 26 changes of cell.
      expect({ changes: steps.length, about: steps.length >= 12 && steps.length <= 26 }).toEqual({
        changes: steps.length,
        about: true,
      })
    }),
  60_000,
)

it.live(
  "[UI14] the mark is a static ◆, not bold, at every site when the run has ended or animations are off",
  () =>
    Effect.gen(function* () {
      const live = yield* written(building)
      const ended = yield* written(cancelled)
      expect(ended.status.run.state).toBe("cancelled")
      expect(tagged(ended.status.run, "ended")).toBe(true)
      const liveViews = yield* viewsOf(live.status)
      const endedViews = yield* viewsOf(ended.status)
      expect(endedViews(1).liveness()).toBe("ended")
      for (const [form, status, view, motion] of [
        ["ended, animations on", ended.status, endedViews, true],
        ["live, animations off", live.status, liveViews, false],
      ] as const) {
        for (const site of sites(status, view, motion)) {
          const shown = yield* render(site.node)
          expect({ form, site: site.site, spinners: shown.found.length }).toEqual({
            form,
            site: site.site,
            spinners: 0,
          })
          const mark = markOf(shown.text, shown.spans, site.after)
          expect({ form, site: site.site, cell: mark.cell, bold: mark.bold, nameBold: mark.nameBold }).toEqual({
            form,
            site: site.site,
            cell: "◆",
            bold: false,
            nameBold: true,
          })
          expect({ form, site: site.site, fg: mark.fg }).toEqual({ form, site: site.site, fg: rgb(theme.accent) })
        }
        // Over time it stays a ◆: sampled for a second in the Ledger and the bar.
        for (const [site, node, after] of [
          [
            "Ledger",
            () =>
              createComponent(LedgerView, {
                theme: () => theme,
                view: view(1),
                sessions: none,
                leader: "ctrl+x",
                motion: () => motion,
                width: 38,
              }),
            `${NAME} run:`,
          ],
          [
            "bar",
            () =>
              createComponent(ShortcutBar, {
                theme: () => theme,
                view: view(1),
                sessions: none,
                leader: "ctrl+x",
                motion: () => motion,
                width: 200,
              }),
            NAME,
          ],
        ] as const) {
          const seen = yield* sample(node, after, 1_000, 200, 30)
          expect({
            form,
            site,
            cells: [...new Set(seen.map((item) => item.cell))],
            bold: seen.some((item) => item.bold),
          }).toEqual({
            form,
            site,
            cells: ["◆"],
            bold: false,
          })
        }
      }
    }),
  180_000,
)

it.live(
  "[UI14] the Peek border title stays static while the run is live",
  () =>
    Effect.gen(function* () {
      const { status } = yield* written(building)
      const { view } = yield* viewOf(status, 1)
      expect(view.live()).toBe(true)
      for (const [width, title] of [
        [60, `${MARK} · T1.4 details · read-only`],
        [40, "◆ T1.4 details · read-only"],
      ] as const) {
        const node = () =>
          createComponent(Peek, { theme: () => theme, view, sessions: none, unit: "T1.4", width, lines: 3 })
        const shown = yield* render(node, 80, 30)
        expect({ width, spinners: shown.found.length }).toEqual({ width, spinners: 0 })
        expect({ width, title: shown.text.includes(title) }).toEqual({ width, title: true })
        // Sampled for a second: the title's diamond never changes.
        const seen = yield* sample(node, title.slice(1), 1_000, 80, 30)
        expect({ width, cells: [...new Set(seen.map((item) => item.cell))] }).toEqual({ width, cells: ["◆"] })
      }
    }),
  60_000,
)

// --- the real plugin in a host with opencode's keymap and slots ------------------------------------------------------

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

/** Solid's `Show` at its unkeyed signature, for `createComponent` (which would infer its keyed overload). */
const ShowWhen: (props: { when: boolean; children: JSX.Element }) => JSX.Element = Show

/**
 * Loads the plugin entry the way the runtime does, with no options, over `directory`, with the TUI's kv store `kv` (a
 * fresh one by default). The shortcut bar's slot and the sidebar are on screen. The design picker chooses at once.
 */
async function load(directory: string, kv?: TuiPluginApi["kv"]) {
  const toasts: TuiToast[] = []
  const pickers: Array<(value: number) => void> = []
  const disposers: TuiDispose[] = []
  const slots = createSlots()
  const handles: { api?: TuiPluginApi } = {}
  const [loaded, setLoaded] = createSignal(false)

  function Host(): JSX.Element {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const keybinds = createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse({})), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    })
    registerOpencodeKeymap(keymap, renderer, { keybinds, leader_timeout: 2000 })
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      fetch: Object.assign(async () => Response.json([]), { preconnect: fetch.preconnect }),
    })
    const base = createTuiPluginApi({ renderer, keymap, client })
    const host = slots.setup(base)
    const registered = { count: 0 }
    handles.api = {
      ...base,
      kv: kv ?? base.kv,
      state: { ...base.state, path: { ...base.state.path, directory } },
      slots: {
        register(plugin: TuiSlotPlugin) {
          registered.count += 1
          const id = `${meta.id}:${registered.count}`
          host.register({ ...plugin, id })
          return id
        },
      },
      ui: {
        ...base.ui,
        toast: (toast) => void toasts.push(toast),
        DialogSelect: <Value>(props: TuiDialogSelectProps<Value>) => {
          pickers.push((value) => {
            const option = props.options.find((item) => item.value === value)
            if (option) props.onSelect?.(option)
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
    return createComponent(OpencodeKeymapProvider, {
      keymap,
      get children() {
        return jsx("box", {
          flexDirection: "column",
          get children() {
            return createComponent(ShowWhen, {
              get when() {
                return loaded()
              },
              get children() {
                return [
                  createComponent(slots.Slot, { name: "session_prompt_right", session_id: "" }),
                  createComponent(slots.Slot, { name: "sidebar_content", session_id: "" }),
                ]
              },
            })
          },
        })
      },
    })
  }

  const app = await testRender(() => createComponent(Host, {}), { width: 200, height: 30 })
  const { api } = handles
  if (!api) throw new Error("the host did not render")
  await TaskUi.tui(api, undefined, meta)
  setLoaded(true)

  const frame = async () => {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  /** Waits until the screen shows `text`, within a few feed reads. */
  const shows = async (text: string, within = 5000) => {
    const end = Date.now() + within
    while (Date.now() < end) {
      if ((await frame()).includes(text)) return true
      await Bun.sleep(25)
    }
    return (await frame()).includes(text)
  }
  /** The cells before `after`, sampled for `ms`. */
  const marks = async (after: string, ms = 1200) => {
    const seen = new Set<string>()
    const end = Date.now() + ms
    while (Date.now() < end) {
      const line = (await frame()).split("\n").find((item) => item.includes(after)) ?? ""
      seen.add(line.slice(line.indexOf(after) - 1, line.indexOf(after)))
      await Bun.sleep(20)
    }
    return [...seen]
  }
  /** Chooses a design through `/task-design`'s command, as the command list does. */
  const choose = (design: number) => {
    api.keymap.dispatchCommand("task_ui.pick")
    pickers.at(-1)?.(design)
  }
  return {
    toasts,
    kv: api.kv,
    shows,
    marks,
    choose,
    async [Symbol.asyncDispose]() {
      for (const dispose of disposers.splice(0)) await dispose()
      app.renderer.destroy()
    },
  }
}

it.live(
  "[UI14] the real plugin: the marks move for a live run with animations on, stay ◆ with them off; toast titles are static",
  () =>
    Effect.gen(function* () {
      // A heartbeat a minute ahead: the run stays live for the whole test.
      const live = yield* written(building, Date.now() + 60_000)
      const first = yield* Effect.acquireRelease(
        Effect.promise(() => load(live.directory)),
        (made) => Effect.promise(() => made[Symbol.asyncDispose]()),
      )
      expect(yield* Effect.promise(() => first.shows(`${NAME} run: running`))).toBe(true)
      // The host's default allows animations: the Ledger's mark and the bar's mark step through frames.
      for (const after of [`${NAME} run: running`, `${NAME} Ledger  `]) {
        const cells = yield* Effect.promise(() => first.marks(after))
        expect({ after, moving: cells.length > 1, frames: cells.every((cell) => FRAMES.includes(cell)) }).toEqual({
          after,
          moving: true,
          frames: true,
        })
      }
      // The toast titles while the marks move: the Ticker's toast for T1.4's change, and the run warning's toast.
      first.choose(7)
      expect(yield* Effect.promise(() => first.shows(`${NAME} Ticker  `))).toBe(true)
      const next = yield* written(warned, Date.now() + 60_000, live.directory)
      expect(next.status.run.warning?.split("\n")).toHaveLength(2)
      expect(next.status.tasks["T1.4"]?.state).toBe("budget_exhausted")
      expect(yield* Effect.promise(() => first.shows("! spec"))).toBe(true)
      const toasted = () => first.toasts.filter((toast) => !toast.title?.startsWith("Task design"))
      for (let tries = 0; tries < 200 && !toasted().some((toast) => toast.message.startsWith("T1.4 ")); tries++)
        yield* Effect.promise(() => Bun.sleep(25))
      const titled = toasted()
      expect(titled.map((toast) => toast.message)).toContain(
        "The spec no longer validates (2 failures). The run keeps the plan it loaded.",
      )
      expect(titled.some((toast) => toast.message.startsWith("T1.4 "))).toBe(true)
      // Each title is the plain text of the mark: a static ◆, whatever frame the marks on screen show.
      expect(titled.map((toast) => toast.title)).toEqual(titled.map(() => MARK))

      // Animations off in the host: the plugin loaded with that kv shows a static ◆ for a live run.
      first.kv.set("animations_enabled", false)
      const still = yield* written(building, Date.now() + 60_000)
      const second = yield* Effect.acquireRelease(
        Effect.promise(() => load(still.directory, first.kv)),
        (made) => Effect.promise(() => made[Symbol.asyncDispose]()),
      )
      second.choose(1)
      expect(yield* Effect.promise(() => second.shows(`${NAME} run: running`))).toBe(true)
      for (const after of [`${NAME} run: running`, `${NAME} Ledger  `]) {
        const cells = yield* Effect.promise(() => second.marks(after))
        expect({ after, cells }).toEqual({ after, cells: ["◆"] })
      }
    }),
  120_000,
)
