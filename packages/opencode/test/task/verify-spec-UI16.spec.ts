import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Option, Result, Scope } from "effect"
import path from "path"
import type { CapturedFrame, RGBA } from "@opentui/core"
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
import { facts, loadPlan, trustLeaf } from "./lib/machine"
import { TuiKeybind } from "../../../tui/src/config/keybind"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../tui/src/keymap"
import { createSlots } from "../../../tui/src/plugin/slots"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import TaskUi from "../../../tui/src/task-ui/index"
import type { Sessions } from "../../../tui/src/task-ui/peek"
import { parse, type Status } from "../../../tui/src/task-ui/store"
import { ShortcutBar } from "../../../tui/src/task-ui/ui"
import { LedgerView } from "../../../tui/src/task-ui/designs/1-ledger"
import { DockView } from "../../../tui/src/task-ui/designs/2-dock"
import { HudView } from "../../../tui/src/task-ui/designs/6-hud"
import { TickerDialog } from "../../../tui/src/task-ui/designs/7-ticker"
import { Screen } from "../../../tui/src/task-ui/designs/screen"
import { createTuiPluginApi } from "../../../tui/test/fixture/tui-plugin"
import { settle, viewFor } from "../../../tui/test/task-ui/view"

// Scenario UI16 (spec task-harness-feedback, D12, AD-12, AD-14; tasks T4.4, T4.8, T4.9): a run warning shows in the
// task-ui and goes when the spec validates again.
//
//   Given a status with a run warning of two failures
//   When the task-ui renders
//   Then every run-state surface shows "! spec no longer validates · 2 failures"
//   And the shared region lists each failure line
//   And a warning toast appears once, and the warning goes from every surface when the status loses it
//
// The statuses are the harness's own: the release-notes run (T1.1 to T1.3 trusted, T1.4's builder at work) folded by
// the engine, then a `spec.checked` fact with two failures (the warned status), then a `spec.checked` with none (the
// next reload validates: the cleared status); each projected by `TaskStatus.project` and written by
// `TaskStatus.write`. Every run-state surface is the real task-ui code on a real taskView actor (the tui test helper
// `viewFor`): the Ledger, the Dock strip, the HUD panel and the full-screen headers (the one line, in full or cut with
// … to its width, EXPERIENCE "Run warning"), the shortcut bar of each design (its "! spec" part), and the shared region
// of every expanded view. The toast is the real plugin entry in a host that keeps its toasts, over a status file that
// the test rewrites. This file is .spec.ts, so components render through `createComponent`.

const it = testEffect(NodeServices.layer)

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }
const ALIVE_AT = 1_791_000_000_000
const HEAD = "! spec no longer validates · 2 failures"
const NOTE = "The run keeps the plan it loaded."
const TOAST = "The spec no longer validates (2 failures). The run keeps the plan it loaded."
const FAILURES = [
  { rule: "R3", path: "T1.4/VERIFY.md", message: "no ensures" },
  { rule: "R4", path: "T1.5/TASK.md", message: "no H1" },
]
const LINES = ["R3 T1.4/VERIFY.md: no ensures", "R4 T1.5/TASK.md: no H1"]

/** The release-notes run with T1.1 to T1.3 trusted and T1.4's builder at work, then `more` of its facts. */
const run =
  (more: (f: ReturnType<typeof facts>) => ReadonlyArray<Fact>) =>
  (plan: Plan): ReadonlyArray<Fact> => {
    const f = facts()
    return [
      f.runStarted(),
      ...trustLeaf(plan, f, "T1.1"),
      ...trustLeaf(plan, f, "T1.2"),
      ...trustLeaf(plan, f, "T1.3"),
      f.started("T1.4"),
      ...more(f),
    ]
  }

const base = run(() => [])
const warned = run((f) => [f.checked(FAILURES)])
const cleared = run((f) => [f.checked(FAILURES), f.checked([])])

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

/** A real taskView actor over `status` in `design`, expanded or not with T1.4 selected, disposed with the scope. */
const viewOf = (status: Status, design: number, expanded: boolean) =>
  Effect.gen(function* () {
    const { view } = yield* Effect.acquireRelease(
      Effect.promise(() => viewFor(status, { design })),
      (made) => Effect.sync(made.dispose),
    )
    view.select("T1.4")
    view.setExpanded(expanded)
    yield* Effect.promise(settle)
    return view
  })

/** Renders `node` once: its rows, trimmed of the frame's padding and of box borders, and its spans. */
const render = (node: () => JSX.Element, width: number, height: number) =>
  Effect.promise(async () => {
    const app = await testRender(node, { width, height })
    try {
      await app.renderOnce()
      const text = app.captureCharFrame()
      return {
        text,
        rows: text.split("\n").map((line) => line.replace(/[║│]/g, " ").trim()),
        spans: app.captureSpans(),
      }
    } finally {
      app.renderer.destroy()
    }
  })

const rgb = (value: RGBA | undefined) => (value ? [value.r, value.g, value.b] : [])
const fgOf = (spans: CapturedFrame, text: string) =>
  rgb(spans.lines.flatMap((line) => line.spans).find((span) => span.text.includes(text))?.fg)

/**
 * The shared region's run warning list in a frame: the row that starts with the warning's line and whose next row, at
 * the same column, starts with the first failure line, then the three rows under it, each read from that column up to
 * a border or a gap (a side-by-side layout puts another pane on the same rows).
 */
const regionOf = (text: string) => {
  const rows = text.split("\n")
  const from = (row: number, column: number) =>
    (rows[row] ?? "")
      .slice(column)
      .replace(/(\s{2,}|[║│]).*$/, "")
      .trim()
  for (const [row, line] of rows.entries())
    for (let column = line.indexOf("! spec"); column >= 0; column = line.indexOf("! spec", column + 1))
      if (from(row + 1, column).startsWith(LINES[0])) return [0, 1, 2, 3].map((offset) => from(row + offset, column))
  return []
}

/** The surfaces that show the run state, collapsed: each with the one line it shows for the warning. */
const collapsed = (view: (design: number) => Effect.Effect<ViewOf, never, Scope.Scope>) => [
  {
    surface: "Ledger (sidebar, 38 cells)",
    line: "! spec no longer validates · 2 failur…",
    shown: Effect.flatMap(view(1), (v) =>
      render(
        () => createComponent(LedgerView, { theme: () => theme, view: v, sessions: none, leader: "ctrl+x", width: 38 }),
        38,
        30,
      ),
    ),
  },
  {
    surface: "Ledger (60 cells)",
    line: HEAD,
    shown: Effect.flatMap(view(1), (v) =>
      render(
        () => createComponent(LedgerView, { theme: () => theme, view: v, sessions: none, leader: "ctrl+x", width: 60 }),
        60,
        30,
      ),
    ),
  },
  {
    surface: "Dock strip",
    line: "! spec",
    shown: Effect.flatMap(view(2), (v) =>
      render(
        () => createComponent(DockView, { theme: () => theme, view: v, sessions: none, leader: "ctrl+x", width: 200 }),
        200,
        10,
      ),
    ),
  },
  {
    surface: "HUD panel",
    line: "! spec no longer validates · 2 failures",
    shown: Effect.flatMap(view(6), (v) =>
      render(
        () => createComponent(HudView, { theme: () => theme, view: v, sessions: none, leader: "ctrl+x" }),
        120,
        30,
      ),
    ),
  },
  ...[3, 4, 5].map((design) => ({
    surface: `full-screen header ${["Board", "Matrix", "Gantt"][design - 3]}`,
    line: HEAD,
    shown: Effect.flatMap(view(design), (v) =>
      render(
        () =>
          createComponent(Screen, {
            theme: () => theme,
            view: v,
            sessions: none,
            leader: "ctrl+x",
            width: 160,
            height: 60,
          }),
        160,
        60,
      ),
    ),
  })),
  ...[1, 2, 3, 4, 5, 6, 7].map((design) => ({
    surface: `shortcut bar ${design}`,
    line: "! spec",
    shown: Effect.flatMap(view(design), (v) =>
      render(
        () =>
          createComponent(ShortcutBar, { theme: () => theme, view: v, sessions: none, leader: "ctrl+x", width: 240 }),
        240,
        3,
      ),
    ),
  })),
]

/** The expanded views, each with its shared region. */
const expanded = (view: (design: number) => Effect.Effect<ViewOf, never, Scope.Scope>) => [
  {
    surface: "Ledger",
    shown: Effect.flatMap(view(1), (v) =>
      render(
        () => createComponent(LedgerView, { theme: () => theme, view: v, sessions: none, leader: "ctrl+x", width: 38 }),
        38,
        120,
      ),
    ),
  },
  {
    surface: "Dock",
    shown: Effect.flatMap(view(2), (v) =>
      render(
        () =>
          createComponent(DockView, {
            theme: () => theme,
            view: v,
            sessions: none,
            leader: "ctrl+x",
            width: 160,
            height: 80,
          }),
        160,
        80,
      ),
    ),
  },
  ...[3, 4, 5].map((design) => ({
    surface: ["Board", "Matrix", "Gantt"][design - 3],
    shown: Effect.flatMap(view(design), (v) =>
      render(
        () =>
          createComponent(Screen, {
            theme: () => theme,
            view: v,
            sessions: none,
            leader: "ctrl+x",
            width: 160,
            height: 120,
          }),
        160,
        120,
      ),
    ),
  })),
  {
    surface: "HUD",
    shown: Effect.flatMap(view(6), (v) =>
      render(
        () => createComponent(HudView, { theme: () => theme, view: v, sessions: none, leader: "ctrl+x" }),
        120,
        120,
      ),
    ),
  },
  {
    surface: "Ticker dialog",
    shown: Effect.flatMap(view(7), (v) =>
      render(
        () => createComponent(TickerDialog, { theme: () => theme, view: v, sessions: none, leader: "ctrl+x" }),
        120,
        120,
      ),
    ),
  },
]

it.live(
  "[UI16] the harness's warned status holds the two failure lines; every run-state surface shows the warning's one line",
  () =>
    Effect.gen(function* () {
      const { status } = yield* written(warned)
      // Two failures, one line each, as the run's spec check recorded them (AD-14); the run keeps working.
      expect(status.run.warning).toBe(LINES.join("\n"))
      expect(status.run.state).toBe("running")
      for (const surface of collapsed((design) => viewOf(status, design, false))) {
        const shown = yield* surface.shown
        expect({ surface: surface.surface, shown: shown.rows.some((row) => row.includes(surface.line)) }).toEqual({
          surface: surface.surface,
          shown: true,
        })
        expect({ surface: surface.surface, tone: fgOf(shown.spans, surface.line.slice(0, 6)) }).toEqual({
          surface: surface.surface,
          tone: rgb(theme.warning),
        })
      }
      // The one line is the full text wherever it fits: in the full-screen headers, in the HUD panel and in a wide Ledger.
      const board = yield* collapsed((design) => viewOf(status, design, false))[4].shown
      expect(board.rows.filter((row) => row === HEAD)).toHaveLength(1)
    }),
  180_000,
)

it.live(
  "[UI16] the shared region of every expanded view lists the warning's line, each failure line, then the note",
  () =>
    Effect.gen(function* () {
      const { status } = yield* written(warned)
      for (const surface of expanded((design) => viewOf(status, design, true))) {
        const shown = yield* surface.shown
        // The region's run warning list: the one line, the two failure lines in order, then the note, in one column.
        expect({ surface: surface.surface, rows: regionOf(shown.text) }).toEqual({
          surface: surface.surface,
          rows: [expect.stringMatching(/^! spec no longer validates · 2 fa/), ...LINES, NOTE],
        })
        // The lines in the warning tone, the note muted.
        expect({ surface: surface.surface, line: fgOf(shown.spans, LINES[0]), note: fgOf(shown.spans, NOTE) }).toEqual({
          surface: surface.surface,
          line: rgb(theme.warning),
          note: rgb(theme.textMuted),
        })
      }
    }),
  180_000,
)

it.live(
  "[UI16] the warning goes from every surface and every shared region once the next spec check validates",
  () =>
    Effect.gen(function* () {
      const { status } = yield* written(cleared)
      // The next check found no failures: the status has no run warning.
      expect(status.run.warning).toBeUndefined()
      for (const surface of [
        ...collapsed((design) => viewOf(status, design, false)),
        ...expanded((design) => viewOf(status, design, true)),
      ]) {
        const shown = yield* surface.shown
        expect({
          surface: surface.surface,
          spec: shown.text.includes("! spec"),
          head: shown.text.includes("no longer validates"),
          lines: LINES.filter((line) => shown.text.includes(line)),
          note: shown.text.includes(NOTE),
        }).toEqual({ surface: surface.surface, spec: false, head: false, lines: [], note: false })
      }
    }),
  180_000,
)

// --- the real plugin's toast ----------------------------------------------------------------------------------------

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
 * Loads the plugin entry the way the runtime does, with no options, over `directory`. The shortcut bar's slot and the
 * sidebar are on screen; the host keeps every toast; the design picker chooses at once.
 */
async function load(directory: string) {
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
  /** Waits until `done` holds of the screen, over several reads of the status file (one each second). */
  const until = async (done: (screen: string) => boolean, within = 6000) => {
    const end = Date.now() + within
    while (Date.now() < end) {
      if (done(await frame())) return true
      await Bun.sleep(25)
    }
    return done(await frame())
  }
  const choose = (design: number) => {
    api.keymap.dispatchCommand("task_ui.pick")
    pickers.at(-1)?.(design)
  }
  return {
    toasts,
    until,
    choose,
    async [Symbol.asyncDispose]() {
      for (const dispose of disposers.splice(0)) await dispose()
      app.renderer.destroy()
    },
  }
}

it.live(
  "[UI16] the real plugin toasts the warning once while the status keeps it, and the warning goes when the status loses it",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* written(base, Date.now() + 60_000)
      const plugin = yield* Effect.acquireRelease(
        Effect.promise(() => load(directory)),
        (made) => Effect.promise(() => made[Symbol.asyncDispose]()),
      )
      expect(yield* Effect.promise(() => plugin.until((screen) => screen.includes("run: running")))).toBe(true)
      const warnings = () => plugin.toasts.filter((toast) => toast.variant === "warning")
      expect(warnings()).toEqual([])

      // The spec stops validating: the Ledger's line and the bar's part show, and one warning toast.
      yield* written(warned, Date.now() + 60_000, directory)
      expect(
        yield* Effect.promise(() =>
          plugin.until(
            (screen) => screen.includes("! spec no longer validates · 2 failur") && screen.includes("Ledger  ! spec"),
          ),
        ),
      ).toBe(true)
      for (let tries = 0; tries < 100 && warnings().length === 0; tries++) yield* Effect.promise(() => Bun.sleep(25))
      expect(warnings()).toEqual([{ variant: "warning", title: "◆ In the Flow", message: TOAST }])

      // The status keeps the warning through more writes and design switches: no second toast.
      for (const design of [3, 7, 1]) {
        yield* written(warned, Date.now() + 60_000, directory)
        plugin.choose(design)
        yield* Effect.promise(() => Bun.sleep(1_200))
        expect(yield* Effect.promise(() => plugin.until((screen) => screen.includes("! spec")))).toBe(true)
      }
      expect(warnings()).toEqual([{ variant: "warning", title: "◆ In the Flow", message: TOAST }])

      // The next check validates: the warning goes from the Ledger and from the bar, and no toast follows.
      yield* written(cleared, Date.now() + 60_000, directory)
      expect(
        yield* Effect.promise(() =>
          plugin.until(
            (screen) =>
              screen.includes("run: running") && !screen.includes("! spec") && !screen.includes("no longer validates"),
          ),
        ),
      ).toBe(true)
      expect(warnings()).toEqual([{ variant: "warning", title: "◆ In the Flow", message: TOAST }])
    }),
  60_000,
)
