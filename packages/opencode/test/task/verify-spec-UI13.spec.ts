import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Option, Result } from "effect"
import path from "path"
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
import { loadPlan, observed } from "./lib/machine"
import { TuiKeybind } from "../../../tui/src/config/keybind"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useCommandSlashes } from "../../../tui/src/keymap"
import { createSlots } from "../../../tui/src/plugin/slots"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import TaskUi from "../../../tui/src/task-ui/index"
import type { Sessions } from "../../../tui/src/task-ui/peek"
import { DESIGNS, parse, type Status } from "../../../tui/src/task-ui/store"
import { ShortcutBar, barKeys } from "../../../tui/src/task-ui/ui"
import { createTuiPluginApi } from "../../../tui/test/fixture/tui-plugin"
import { settle, viewFor } from "../../../tui/test/task-ui/view"

// Scenario UI13 (spec task-harness-feedback, D22; task T4.9): the shortcut bar no longer shows the task-design switch
// hint.
//
//   Given a live run in any design
//   When the shortcut bar renders
//   Then it shows no "/task-design switch" part
//   And /task-design still switches designs from the command list
//
// The status is the harness's own: the observed release-notes facts folded by the engine, projected by
// `TaskStatus.project` and written by `TaskStatus.write` (the run is still running, with the `active` tag). The bar is
// the real `ShortcutBar` on a real taskView actor (the tui test helper `viewFor`, whose clock sits at the heartbeat, so
// the run is live), rendered by the opentui test renderer. The command list is the real one: the real plugin entry
// (`TaskUi.tui`) loaded into a host with opencode's real keymap, slot registry and slash list (`useCommandSlashes`),
// over a status file whose heartbeat stays fresh for the test. Before T4.9 the bar's keys held
// `{ key: "/task-design", label: "switch" }` between the expand key and the select key (ui.tsx at ac870df79a).
// This file is .spec.ts, so components render through `jsx` from the opentui runtime, which is what JSX compiles to.

const it = testEffect(NodeServices.layer)

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }
/** The heartbeat the status writer stamps for the rendered bars; the view's clock sits there, so the run is live. */
const ALIVE_AT = 1_791_000_000_000
const HINT = "/task-design"

/** The status the harness writes after `list`, stamped `aliveAt`, and the directory that holds it. */
const written = Effect.fnUntraced(function* (list: (plan: Plan) => ReadonlyArray<Fact>, aliveAt: number) {
  const plan = yield* loadPlan("release-notes.spec")
  const snapshot = list(plan).reduce(
    (each, fact) => TaskEngineXState.apply(plan, each, fact),
    TaskEngineXState.initial(plan),
  )
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  yield* TaskStatus.write(directory, TaskStatus.project(plan, snapshot), aliveAt)
  const text = yield* fs.readFileString(path.join(directory, ".opencode", "task", "status.json"))
  return { directory, status: Option.getOrThrow(parse(text)) }
})

/** A real taskView actor over `status`, disposed with the test's scope. */
const viewOf = (status: Status, design: number) =>
  Effect.acquireRelease(
    Effect.promise(() => viewFor(status, { design })),
    (made) => Effect.sync(made.dispose),
  )

/** The line of the rendered bar that holds the mark. */
const barLine = (view: Awaited<ReturnType<typeof viewFor>>["view"], width: number) =>
  Effect.promise(async () => {
    const app = await testRender(
      () => createComponent(ShortcutBar, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width }),
      { width, height: 3 },
    )
    try {
      await app.renderOnce()
      return (
        app
          .captureCharFrame()
          .split("\n")
          .find((line) => line.includes("In the Flow"))
          ?.trim() ?? ""
      )
    } finally {
      app.renderer.destroy()
    }
  })

it.live(
  "[UI13] no design's shortcut bar shows a /task-design switch part while the run is live",
  () =>
    Effect.gen(function* () {
      const { status } = yield* written(observed, ALIVE_AT)
      // The run is live: it has not ended, and the view's clock sits at its heartbeat.
      expect(status.run.state).toBe("running")
      expect(status.run.tags).toEqual(["active"])
      for (const design of DESIGNS) {
        const { view } = yield* viewOf(status, design.id)
        expect({ design: design.name, live: view.live(), shown: view.design() }).toEqual({
          design: design.name,
          live: true,
          shown: design.id,
        })
        // Collapsed, expanded, and in the watch view: each form of the bar.
        const forms: Array<{ form: string; line: string; keys: ReadonlyArray<string> }> = []
        for (const form of ["collapsed", "expanded", "watching"] as const) {
          view.setExpanded(form !== "collapsed")
          view.setWatching(form === "watching")
          yield* Effect.promise(settle)
          forms.push({
            form,
            line: yield* barLine(view, 300),
            keys: barKeys(view, "ctrl+x").map((part) => `${part.key} ${part.label}`),
          })
        }
        view.setWatching(false)
        yield* Effect.promise(settle)
        for (const shown of forms) {
          // The bar renders, names the design, and has room for every key: the last key is on it.
          expect({
            design: design.name,
            form: shown.form,
            named: shown.line.includes(` In the Flow ${design.name}`),
          }).toEqual({
            design: design.name,
            form: shown.form,
            named: true,
          })
          expect({
            design: design.name,
            form: shown.form,
            last: shown.keys.every((key) => shown.line.includes(key)),
          }).toEqual({
            design: design.name,
            form: shown.form,
            last: true,
          })
          // No /task-design part and no "switch" label, in the drawn bar or in its key list.
          expect({
            design: design.name,
            form: shown.form,
            hint: shown.line.includes(HINT),
            word: shown.line.includes("switch"),
          }).toEqual({
            design: design.name,
            form: shown.form,
            hint: false,
            word: false,
          })
          expect({
            design: design.name,
            form: shown.form,
            keys: shown.keys.filter((key) => key.includes(HINT) || key.includes("switch")),
          }).toEqual({
            design: design.name,
            form: shown.form,
            keys: [],
          })
        }
        // The live keys: Tab selects, in place of `ctrl+x j/k`.
        expect(forms[0].keys).toEqual(["ctrl+x o expand", "tab select task", "ctrl+x w watch"])
        expect(forms[1].keys).toEqual(["ctrl+x o collapse", "tab select task", "ctrl+x w watch"])
        expect(forms[2].keys).toEqual(["tab next running", "ctrl+x w stop watching", "esc stop run"])
      }
    }),
  120_000,
)

it.live(
  "[UI13] a narrow bar of a live run drops keys from the end and never shows the /task-design part",
  () =>
    Effect.gen(function* () {
      const { status } = yield* written(observed, ALIVE_AT)
      for (const design of DESIGNS) {
        const { view } = yield* viewOf(status, design.id)
        for (const width of [100, 120, 140, 160, 200]) {
          const line = yield* barLine(view, width)
          expect({ design: design.name, width, named: line.includes(` In the Flow ${design.name}`) }).toEqual({
            design: design.name,
            width,
            named: true,
          })
          expect({ design: design.name, width, hint: line.includes(HINT), word: line.includes("switch") }).toEqual({
            design: design.name,
            width,
            hint: false,
            word: false,
          })
        }
      }
    }),
  120_000,
)

// --- the real plugin in a host with opencode's keymap, slots and slash list -----------------------------------------

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

type Slashes = ReturnType<typeof useCommandSlashes>

/** Solid's `Show` at its unkeyed signature, for `createComponent` (which would infer its keyed overload). */
const ShowWhen: (props: { when: boolean; children: JSX.Element }) => JSX.Element = Show

/**
 * Loads the plugin entry the way the runtime does, with no options, over `directory`. The shortcut bar's slot is on
 * screen; the slash list is opencode's own, read from the keymap the plugin registers its commands in. The SDK client
 * answers every request with an empty list.
 */
async function load(directory: string) {
  const toasts: TuiToast[] = []
  const pickers: Picker[] = []
  const disposers: TuiDispose[] = []
  const slots = createSlots()
  const handles: { api?: TuiPluginApi; slashes?: Slashes } = {}
  const [loaded, setLoaded] = createSignal(false)

  function SlashList(): JSX.Element {
    handles.slashes = useCommandSlashes()
    return jsx("box", {})
  }

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
    return createComponent(OpencodeKeymapProvider, {
      keymap,
      get children() {
        return jsx("box", {
          flexDirection: "column",
          get children() {
            return [
              // Mounted after the plugin loads: a mounted slot acts on one registry change per tick.
              createComponent(ShowWhen, {
                get when() {
                  return loaded()
                },
                get children() {
                  return createComponent(slots.Slot, { name: "session_prompt_right", session_id: "" })
                },
              }),
              createComponent(SlashList, {}),
            ]
          },
        })
      },
    })
  }

  const app = await testRender(() => createComponent(Host, {}), { width: 240, height: 20 })
  const { api, slashes } = handles
  if (!api || !slashes) throw new Error("the host did not render")
  await TaskUi.tui(api, undefined, meta)
  setLoaded(true)

  const frame = async () => {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  /** The bar's line once the screen shows `text` (within a few feed reads), else the last line seen. */
  const barWith = async (text: string, within = 5000) => {
    const end = Date.now() + within
    const line = async () =>
      (await frame())
        .split("\n")
        .find((item) => item.includes("In the Flow"))
        ?.trim() ?? ""
    while (Date.now() < end) {
      const shown = await line()
      if (shown.includes(text)) return shown
      await Bun.sleep(25)
    }
    return line()
  }
  const slash = (name: string) => slashes().find((entry) => entry.display === name)
  /** Opens the picker through its slash command, as choosing `/task-design` from the command list does. */
  const openPicker = () => {
    const count = pickers.length
    slash(HINT)?.onSelect()
    const picker = pickers.at(-1)
    if (pickers.length !== count + 1 || !picker) throw new Error("/task-design did not open the picker")
    return picker
  }
  return {
    toasts,
    slash,
    slashes,
    openPicker,
    barWith,
    async [Symbol.asyncDispose]() {
      for (const dispose of disposers.splice(0)) await dispose()
      app.renderer.destroy()
    },
  }
}

it.live(
  "[UI13] /task-design still switches every design from the command list, and the bar of the live run never shows it",
  () =>
    Effect.gen(function* () {
      // A heartbeat a minute ahead: the run stays live for the whole test.
      const { directory } = yield* written(observed, Date.now() + 60_000)
      const plugin = yield* Effect.acquireRelease(
        Effect.promise(() => load(directory)),
        (made) => Effect.promise(() => made[Symbol.asyncDispose]()),
      )
      // The plugin starts on design 1, and the run is live: Tab selects tasks.
      const first = yield* Effect.promise(() => plugin.barWith("tab select task"))
      expect(first).toContain(" In the Flow Ledger")
      expect(first).toContain("tab select task")
      expect(first).not.toContain(HINT)
      expect(first).not.toContain("switch")

      // /task-design is in opencode's command list, as one slash command with the plugin's title.
      const listed = plugin.slashes().filter((entry) => entry.display === HINT)
      expect(listed.map((entry) => ({ display: entry.display, description: entry.description }))).toEqual([
        { display: HINT, description: "Choose a task design" },
      ])
      const picker = plugin.openPicker()
      expect(picker.title).toBe("Task design")
      expect(picker.current).toBe(1)
      expect(picker.options).toEqual(DESIGNS.map((item) => ({ title: `${item.id} ${item.name}`, value: item.id })))

      // Every pick from the command list switches the design: 2 to 7, then back to 1. The bar follows each switch
      // and shows no /task-design part.
      for (const design of [...DESIGNS.slice(1), DESIGNS[0]]) {
        plugin.openPicker().select(design.id)
        expect(plugin.toasts.at(-1)?.title).toBe(`Task design ${design.id}: ${design.name}`)
        const line = yield* Effect.promise(() => plugin.barWith(` In the Flow ${design.name} `))
        expect({ design: design.name, named: line.includes(` In the Flow ${design.name} `) }).toEqual({
          design: design.name,
          named: true,
        })
        expect({ design: design.name, live: line.includes("tab select task") }).toEqual({
          design: design.name,
          live: true,
        })
        expect({ design: design.name, hint: line.includes(HINT), word: line.includes("switch") }).toEqual({
          design: design.name,
          hint: false,
          word: false,
        })
        expect(plugin.openPicker().current).toBe(design.id)
      }
    }),
  60_000,
)
