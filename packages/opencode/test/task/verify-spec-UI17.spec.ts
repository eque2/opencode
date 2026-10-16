import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Layer, Option, Result } from "effect"
import path from "path"
import type { CapturedFrame, RGBA } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { jsx } from "@opentui/solid/jsx-runtime"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { Show, createComponent, createSignal, type JSX } from "solid-js"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { TuiDispose, TuiPluginApi, TuiPluginMeta, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import { TaskHarness } from "@/task/core/harness"
import { testEffect } from "../lib/effect"
import { jobsOf, runTaskInputs, seed, statusFile } from "./lib/command"
import { TuiKeybind } from "../../../tui/src/config/keybind"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../tui/src/keymap"
import { createSlots } from "../../../tui/src/plugin/slots"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import TaskUi from "../../../tui/src/task-ui/index"
import type { Sessions } from "../../../tui/src/task-ui/peek"
import { parse, tagged, type Status } from "../../../tui/src/task-ui/store"
import { LedgerView } from "../../../tui/src/task-ui/designs/1-ledger"
import { Screen } from "../../../tui/src/task-ui/designs/screen"
import { createTuiPluginApi } from "../../../tui/test/fixture/tui-plugin"
import { viewFor } from "../../../tui/test/task-ui/view"

// Scenario UI17 (spec task-harness-feedback, D10, AD-14; task T4.8): a refused run shows every reason in the task-ui.
//
//   Given a refused status with three failure lines
//   When the Ledger and a full-screen design render
//   Then the Ledger shows "run: refused" and every failure line
//   And the full-screen body reads "No work started: the spec was refused." with every failure line
//
// The refused status is the harness's own: the real `/task` command (`TaskCommand.run` with the real harness root and
// loader) on a committed copy of task-formats/blend/example-format-faults.spec in a git instance, which the loader
// refuses with three failures (R1, R3, R4). The command writes `.opencode/task/status.json`; the task-ui decodes that
// file with its own `parse`. The Ledger and the full-screen designs (Board, Matrix, Gantt) are the real task-ui code
// on a real taskView actor (the tui test helper `viewFor`); the Ledger also renders through the real plugin entry,
// which reads the status file itself. EXPERIENCE "Refusal": the Ledger shows each line cut to its width (38 cells in
// the sidebar), the full-screen header the run reason line, and the body every line. This file is .spec.ts, so
// components render through `createComponent`.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }
const SPEC = "task-formats/blend/example-format-faults.spec"
const BODY = "No work started: the spec was refused."

/** `/task` on the format-faults folder: the loader's failure lines, and the status file the refusal wrote. */
const refusal = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* seed(SPEC)
  const loaded = yield* Blend.load(path.join(directory, SPEC))
  const lines = loaded.failures.map((failure) => `${failure.rule} ${failure.path}: ${failure.message}`)
  const harness = yield* TaskHarness.make
  const jobs = jobsOf()
  const inputs = yield* runTaskInputs(harness, SPEC, jobs)
  const text = yield* fs.readFileString(statusFile(directory))
  return { directory, lines, inputs, jobs, status: Option.getOrThrow(parse(text)) }
})

/** A real taskView actor over `status` in `design`, disposed with the test's scope. */
const viewOf = (status: Status, design: number) =>
  Effect.map(
    Effect.acquireRelease(
      Effect.promise(() => viewFor(status, { design })),
      (made) => Effect.sync(made.dispose),
    ),
    (made) => made.view,
  )

/** Renders `node` once: its rows, trimmed of the frame's padding and of box borders, and its spans. */
const render = (node: () => JSX.Element, width: number, height: number) =>
  Effect.promise(async () => {
    const app = await testRender(node, { width, height })
    try {
      await app.renderOnce()
      const text = app.captureCharFrame()
      return { text, rows: text.split("\n").map((line) => line.trimEnd()), spans: app.captureSpans() }
    } finally {
      app.renderer.destroy()
    }
  })

const rgb = (value: RGBA | undefined) => (value ? [value.r, value.g, value.b] : [])
const fgOf = (spans: CapturedFrame, text: string) =>
  rgb(spans.lines.flatMap((line) => line.spans).find((span) => span.text.includes(text))?.fg)

/** The Ledger at `width` cells over `status`. */
const ledger = (status: Status, width: number) =>
  Effect.flatMap(viewOf(status, 1), (view) =>
    render(
      () => createComponent(LedgerView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width }),
      width,
      30,
    ),
  )

/** Whether `row` is `line`, or `line` cut to `width` with … (EXPERIENCE "Refusal": each line cut to the width). */
const showsLine = (row: string, line: string, width: number) =>
  row === line ||
  (line.length > width && row.length === width && row.endsWith("…") && line.startsWith(row.slice(0, -1)))

it.instance(
  "[UI17] /task on the format-faults folder writes a refused status with three failure lines and no task",
  () =>
    Effect.gen(function* () {
      const { lines, inputs, jobs, status } = yield* refusal
      // The loader's three failures, in its rule order; the refusal message names them.
      expect(lines.map((line) => line.split(" ")[0])).toEqual(["R1", "R3", "R4"])
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.parts.map((part) => part.text).join("\n")).toContain(lines.join("\n"))
      expect(jobs.starts).toEqual([])
      // The status the task-ui reads: refused, stopped and ended, no task, and exactly the three lines as its reason.
      expect(status.run.state).toBe("refused")
      expect([tagged(status.run, "ended"), tagged(status.run, "stopped")]).toEqual([true, true])
      expect(status.tasks).toEqual({})
      expect(status.run.reason?.split("\n")).toEqual(lines)
    }),
  { git: true },
)

it.instance(
  "[UI17] the Ledger shows run: refused and every failure line in the error tone, each cut to its width",
  () =>
    Effect.gen(function* () {
      const { lines, status } = yield* refusal
      // The sidebar's 38 cells: the header, then one row per failure line, in order, each the line or the line cut
      // with …; the three rows follow one another.
      const side = yield* ledger(status, 38)
      expect(side.rows[0]?.trim()).toBe("◆ In the Flow run: refused")
      const first = side.rows.findIndex((row) => showsLine(row.trim(), lines[0], 38))
      expect(first).toBeGreaterThan(0)
      expect(lines.map((line, index) => showsLine(side.rows[first + index]?.trim() ?? "", line, 38))).toEqual([
        true,
        true,
        true,
      ])
      // Every line shows, not the one run reason line with its count.
      expect(side.text).not.toContain("(+2 more)")
      for (const line of lines)
        expect({ line, tone: fgOf(side.spans, line.slice(0, 20)) }).toEqual({ line, tone: rgb(theme.error) })
      // Wide enough for the lines: each failure line whole, in order.
      const wide = yield* ledger(status, 120)
      expect(wide.rows[0]?.trim()).toBe("◆ In the Flow run: refused")
      const whole = wide.rows.findIndex((row) => row.trim() === lines[0])
      expect(wide.rows.slice(whole, whole + 3).map((row) => row.trim())).toEqual(lines)
    }),
  { git: true },
)

it.instance(
  "[UI17] each full-screen design's body reads No work started: the spec was refused. with every failure line",
  () =>
    Effect.gen(function* () {
      const { lines, status } = yield* refusal
      for (const [design, name] of [
        [3, "Board"],
        [4, "Matrix"],
        [5, "Gantt"],
      ] as const) {
        const view = yield* viewOf(status, design)
        const shown = yield* render(
          () =>
            createComponent(Screen, {
              theme: () => theme,
              view,
              sessions: none,
              leader: "ctrl+x",
              width: 200,
              height: 40,
            }),
          200,
          40,
        )
        // The header: the design's name and run: refused, then the run reason line (the first line and its count).
        expect({
          name,
          header: shown.rows[0]?.includes(`${name} `) && shown.rows[0]?.includes("run: refused"),
        }).toEqual({
          name,
          header: true,
        })
        expect({
          name,
          reason: shown.rows.some((row) => row.trim().startsWith("R1 ") && row.trim().endsWith("(+2 more)")),
        }).toEqual({
          name,
          reason: true,
        })
        // The body: the sentence, then every failure line whole, in order, in the error tone.
        const body = shown.rows.findIndex((row) => row.trim() === BODY)
        expect({ name, body: body > 0 }).toEqual({ name, body: true })
        expect({ name, lines: shown.rows.slice(body + 1, body + 4).map((row) => row.trim()) }).toEqual({ name, lines })
        expect({ name, tone: lines.map((line) => fgOf(shown.spans, line)) }).toEqual({
          name,
          tone: lines.map(() => rgb(theme.error)),
        })
        // No task to draw: no board column, grid or lane takes the body.
        expect({ name, tasks: /\bT1(\.\d)?\b/.test(shown.text.replace(/T1[^ ]*\.task/g, "")) }).toEqual({
          name,
          tasks: false,
        })
      }
    }),
  { git: true },
)

// --- the real plugin over the status file the refusal wrote -----------------------------------------------------------

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

/** Loads the plugin entry the way the runtime does, with no options, over `directory`; the sidebar is on screen. */
async function load(directory: string) {
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
      ui: { ...base.ui, toast: () => {} },
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
          width: 38,
          get children() {
            return createComponent(ShowWhen, {
              get when() {
                return loaded()
              },
              get children() {
                return createComponent(slots.Slot, { name: "sidebar_content", session_id: "" })
              },
            })
          },
        })
      },
    })
  }

  const app = await testRender(() => createComponent(Host, {}), { width: 38, height: 30 })
  const { api } = handles
  if (!api) throw new Error("the host did not render")
  await TaskUi.tui(api, undefined, meta)
  setLoaded(true)

  /** The screen's rows once it shows `text`, within a few reads of the status file. */
  const rowsWith = async (text: string, within = 5000) => {
    const rows = async () => {
      await app.renderOnce()
      return app
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trim())
    }
    const end = Date.now() + within
    while (Date.now() < end) {
      const shown = await rows()
      if (shown.some((row) => row.includes(text))) return shown
      await Bun.sleep(25)
    }
    return rows()
  }
  return {
    rowsWith,
    async [Symbol.asyncDispose]() {
      for (const dispose of disposers.splice(0)) await dispose()
      app.renderer.destroy()
    },
  }
}

it.instance(
  "[UI17] the plugin's Ledger in the sidebar reads the refused status file: run: refused and every failure line",
  () =>
    Effect.gen(function* () {
      const { directory, lines } = yield* refusal
      const plugin = yield* Effect.acquireRelease(
        Effect.promise(() => load(directory)),
        (made) => Effect.promise(() => made[Symbol.asyncDispose]()),
      )
      const rows = yield* Effect.promise(() => plugin.rowsWith("run: refused"))
      expect(rows[0]).toBe("◆ In the Flow run: refused")
      const first = rows.findIndex((row) => showsLine(row, lines[0], 38))
      expect(first).toBeGreaterThan(0)
      expect(lines.map((line, index) => showsLine(rows[first + index] ?? "", line, 38))).toEqual([true, true, true])
      expect(rows.join("\n")).not.toContain("(+2 more)")
    }),
  { git: true },
)
