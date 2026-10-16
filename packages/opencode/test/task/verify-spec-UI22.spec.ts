import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Option, Result } from "effect"
import path from "path"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createComponent, createRoot, type JSX } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, trustLeaf } from "./lib/machine"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import type { Sessions } from "../../../tui/src/task-ui/peek"
import { parse, tagged, type Status } from "../../../tui/src/task-ui/store"
import type { Ctx } from "../../../tui/src/task-ui/ui"
import { Screen, registerScreen } from "../../../tui/src/task-ui/designs/screen"
import { settle, viewFor } from "../../../tui/test/task-ui/view"

// Scenario UI22 (spec task-harness-feedback, EXPERIENCE "Shared region" → Height, Accessibility; tasks T4.4, T4.6):
// every entry of the shared region stays reachable.
//
//   Given a full-screen design at 120 by 24 cells with 13 scenarios and 5 stopped tasks
//   When the user presses pagedown and clicks a STOPPED line
//   Then the region keeps at least 8 rows, the Peek activity lines shrink first, and every entry is reachable by scroll
//   And the click selects the first task of the line
//   And under 149 cells the Board's right pane sits below the board
//
// The status is the harness's own: release-notes facts (T1.1 trusted, T1.3 and T1.2 started, T1.2 failed with
// "merge conflict", then the user cancels) folded by the engine, projected by `TaskStatus.project`, written by
// `TaskStatus.write`, and read back with the task-ui's `parse`. It has 13 scenarios and 5 stopped tasks in 4 STOPPED
// lines: T1.2 failed; T1 and T1.4 blocked by T1.2; T1.5 blocked by T1.4; T1.3 cancelled.
// The full-screen design is the Board's route as the plugin opens it: the real `registerScreen` registers the route
// and, when it renders, the keymap layer that binds pagedown and pageup to the region's scroll box; a stub host keeps
// that layer, and a key press runs the command the layer binds to the key. The view is a real taskView actor (the tui
// test helper `viewFor`); a stub session source gives the selected task's builder 8 activity lines, so the Peek has
// lines to shrink. Components render through `createComponent` (this file is .spec.ts, so it has no JSX).

const it = testEffect(NodeServices.layer)

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
/** The heartbeat the status writer stamps. */
const ALIVE_AT = 1_791_000_000_000
const SCENARIOS = Array.from({ length: 13 }, (_, index) => `S${index + 1}`)
/** The start of each STOPPED line: dead, then blocked, then the rest. */
const STOPPED = [
  "✗ T1.2 failed — merge conflict",
  "⊖ T1, T1.4 blocked by T1.2: failed",
  "⊖ T1.5 blocked by T1.4",
  "– T1.3 cancelled",
]

/** Five stopped tasks: T1.2 fails while T1.3 builds, and the user cancels the run. */
const fiveStopped = (plan: Plan): ReadonlyArray<Fact> => {
  const f = facts()
  return [
    f.runStarted(),
    ...trustLeaf(plan, f, "T1.1"),
    f.started("T1.3"),
    f.started("T1.2"),
    f.failed("T1.2", "merge conflict"),
    f.cancelled("stopped by the user"),
  ]
}

/** The status file the harness writes after `list`, as the task-ui decodes it. */
const statusAfter = Effect.fnUntraced(function* (list: (plan: Plan) => ReadonlyArray<Fact>) {
  const plan = yield* loadPlan("release-notes.spec")
  const snapshot = list(plan).reduce(
    (each, fact) => TaskEngineXState.apply(plan, each, fact),
    TaskEngineXState.initial(plan),
  )
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  yield* TaskStatus.write(directory, TaskStatus.project(plan, snapshot), ALIVE_AT)
  const text = yield* fs.readFileString(path.join(directory, ".opencode", "task", "status.json"))
  return Option.getOrThrow(parse(text))
})

type View = Awaited<ReturnType<typeof viewFor>>["view"]

/** A real taskView actor over `status` on the Board, expanded, with T1.3 selected; disposed with the test's scope. */
const boardView = (status: Status) =>
  Effect.gen(function* () {
    const made = yield* Effect.acquireRelease(
      Effect.promise(() => viewFor(status, { design: 3 })),
      (each) => Effect.sync(each.dispose),
    )
    made.view.setExpanded(true)
    made.view.select("T1.3")
    yield* Effect.promise(settle)
    expect(made.view.selected()).toBe("T1.3")
    return made.view
  })

/** One builder session for every task, with 8 activity lines. */
const sessions: Sessions = {
  children: () => () => [{ id: "b", role: "builder", again: false, created: 1, updated: 1 }],
  activity: () => () =>
    Array.from({ length: 8 }, (_, index) => ({
      glyph: "›",
      tone: "idle" as const,
      text: `activity line ${index + 1}`,
    })),
  all: () => () => [],
}

/** The Board's full-screen route as `registerScreen` registers it, and the key presses of its keymap layer. */
const route = (view: View) => {
  const layers: Array<{
    commands: Array<{ name: string; run: () => unknown }>
    bindings: Array<{ key: string; cmd: string }>
  }> = []
  const routes: Array<{ name: string; render: () => JSX.Element }> = []
  const host = {
    route: {
      register: (list: typeof routes) => void routes.push(...list),
      current: { name: "task-ui" },
      navigate: () => {},
    },
    keymap: {
      registerLayer: (layer: (typeof layers)[number]) => {
        layers.push(layer)
        return () => {}
      },
    },
    ui: { toast: () => {}, dialog: { replace: () => {}, setSize: () => {}, clear: () => {} } },
    attention: { notify: async () => {} },
  }
  const ctx: Ctx = {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- registerScreen reads only the route, keymap, ui and attention members above
    api: host as unknown as TuiPluginApi,
    view,
    sessions,
    theme: () => theme,
    active: () => true,
    leader: "ctrl+x",
    root: () => "",
    owns: () => true,
    harness: () => [],
    logs: () => [],
  }
  const dispose = createRoot((stop) => {
    registerScreen(ctx)
    return stop
  })
  // A key press runs the command that the newest layer binding the key binds to it.
  const press = (key: string) => {
    const layer = layers.findLast((item) => item.bindings.some((binding) => binding.key === key))
    const name = layer?.bindings.find((binding) => binding.key === key)?.cmd
    const command = layer?.commands.find((item) => item.name === name)
    if (!command) throw new Error(`no command for ${key}`)
    command.run()
  }
  const page = routes.find((item) => item.name === "task-ui")
  if (!page) throw new Error("registerScreen registered no task-ui route")
  return { page: page.render, press, dispose }
}

const linesOf = (frame: string) => frame.split("\n").map((line) => line.trimEnd())

const scrollBoxes = (node: Renderable): ReadonlyArray<ScrollBoxRenderable> => [
  ...(node instanceof ScrollBoxRenderable ? [node] : []),
  ...node.getChildren().flatMap(scrollBoxes),
]

/** The rows of the frame inside `box`: the region's own cells, never the Board's cards around it. */
const inBox = (frame: string, box: ScrollBoxRenderable) =>
  linesOf(frame)
    .slice(box.y, box.y + box.height)
    .map((line) => line.slice(box.x, box.x + box.width).trim())

/** Where `text` first shows at or below row `from`. */
const at = (frame: string, text: string, from = 0) => {
  const lines = linesOf(frame)
  const y = lines.findIndex((line, index) => index >= from && line.includes(text))
  return { x: y < 0 ? -1 : lines[y].indexOf(text), y }
}

const activityLines = (frame: string) => linesOf(frame).filter((line) => line.includes("activity line")).length

it.live("[UI22] the harness's status has 13 scenarios and 5 stopped tasks", () =>
  Effect.gen(function* () {
    const status = yield* statusAfter(fiveStopped)
    expect(Object.keys(status.scenarios).toSorted()).toEqual(SCENARIOS.toSorted())
    expect(
      Object.entries(status.tasks)
        .filter(([, task]) => tagged(task, "stopped"))
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([id, task]) => [id, task.state, task.reason]),
    ).toEqual([
      ["T1", "blocked", "blocked by T1.2: failed"],
      ["T1.2", "failed", "merge conflict"],
      ["T1.3", "cancelled", "stopped by the user"],
      ["T1.4", "blocked", "blocked by T1.2: failed"],
      ["T1.5", "blocked", "blocked by T1.4: blocked"],
    ])
  }),
)

it.live(
  "[UI22] at 120 × 24 the region keeps 8 rows, the Peek's activity lines shrink first, pagedown reaches every entry, and a click on a STOPPED line selects its first task",
  () =>
    Effect.gen(function* () {
      const status = yield* statusAfter(fiveStopped)
      // With room, at 80 rows, the Peek shows several activity lines.
      const roomy = route(yield* boardView(status))
      const tall = yield* Effect.promise(async () => {
        const app = await testRender(roomy.page, { width: 120, height: 80 })
        await app.renderOnce()
        const frame = app.captureCharFrame()
        app.renderer.destroy()
        return frame
      })
      roomy.dispose()
      expect(activityLines(tall)).toBeGreaterThan(1)

      const view = yield* boardView(status)
      const screen = route(view)
      const app = yield* Effect.acquireRelease(
        Effect.promise(() => testRender(screen.page, { width: 120, height: 24 })),
        (made) =>
          Effect.sync(() => {
            made.renderer.destroy()
            screen.dispose()
          }),
      )
      yield* Effect.promise(() => app.renderOnce())
      const first = app.captureCharFrame()
      // The region is the scroll box whose cells hold the STOPPED heading.
      const region = scrollBoxes(app.renderer.root).find((box) => inBox(first, box).includes("STOPPED 5"))
      if (!region) throw new Error(`no shared region in\n${first}`)
      // The region keeps at least 8 rows; the Peek's activity lines shrank to one to leave them.
      expect(region.height).toBeGreaterThanOrEqual(8)
      expect(activityLines(first)).toBe(1)
      // The region's content is taller than the region: the first page does not hold every entry.
      const firstPage = inBox(first, region)
      expect(SCENARIOS.every((id) => firstPage.some((row) => row.startsWith(`${id} `, 2)))).toBe(false)

      // pagedown, page by page, brings every STOPPED line and every scenario into the region's own cells.
      const seen = [...firstPage]
      for (let page = 0; page < 10; page++) {
        screen.press("pagedown")
        yield* Effect.promise(() => app.renderOnce())
        seen.push(...inBox(app.captureCharFrame(), region))
      }
      expect(region.scrollTop).toBeGreaterThan(0)
      for (const line of STOPPED)
        expect({ line, reached: seen.some((row) => row.startsWith(line)) }).toEqual({ line, reached: true })
      for (const id of SCENARIOS)
        expect({ id, reached: seen.some((row) => row.startsWith(`${id} `, 2)) }).toEqual({ id, reached: true })
      // The scenario rows are the region's own: a glyph, the id, then its state or cause.
      expect(seen.find((row) => row.startsWith("S13 ", 2))).toStartWith("⊖ S13 blocked by T1.4: blocked")

      // pageup goes back to the top, where the STOPPED list is.
      for (let page = 0; page < 10; page++) screen.press("pageup")
      yield* Effect.promise(() => app.renderOnce())
      expect(region.scrollTop).toBe(0)
      const top = app.captureCharFrame()
      // A click on the STOPPED line of T1 and T1.4 selects T1, its first task.
      const line = at(top, "⊖ T1, T1.4", region.y)
      expect(line.y).toBeGreaterThanOrEqual(region.y)
      expect(line.y).toBeLessThan(region.y + region.height)
      expect(view.selected()).toBe("T1.3")
      yield* Effect.promise(() => app.mockMouse.pressDown(line.x + 2, line.y))
      yield* Effect.promise(settle)
      expect(view.selected()).toBe("T1")
      // The Board is under 149 cells: the Peek and the region sit below the board.
      yield* Effect.promise(() => app.renderOnce())
      const after = app.captureCharFrame()
      const peek = at(after, "T1 details")
      expect(peek.y).toBeGreaterThan(at(after, "WAITING").y)
      expect(region.y).toBeGreaterThan(at(after, "WAITING").y)
    }),
  180_000,
)

it.live(
  "[UI22] under 149 cells the Board's right pane sits below the board; from 149 it sits beside it",
  () =>
    Effect.gen(function* () {
      const status = yield* statusAfter(fiveStopped)
      const view = yield* boardView(status)
      const shown = (width: number) =>
        Effect.promise(async () => {
          const app = await testRender(
            () => createComponent(Screen, { theme: () => theme, view, sessions, leader: "ctrl+x", width, height: 60 }),
            { width, height: 60 },
          )
          await app.renderOnce()
          const frame = app.captureCharFrame()
          app.renderer.destroy()
          return frame
        })
      // 149 cells: the Peek, then the region, in a 56-cell pane on the right, from the board's top row.
      const wide = yield* shown(149)
      const board = at(wide, "WAITING")
      const peek = at(wide, "╔═ ◆ In the Flow · T1.3 details")
      expect(peek.y).toBe(board.y)
      expect(peek.x).toBe(149 - 1 - 56)
      expect(at(wide, "STOPPED 5", board.y + 1).x).toBe(peek.x)
      // 148 and 120 cells: the Peek and the region sit below the board, from its left edge.
      for (const width of [148, 120]) {
        const narrow = yield* shown(width)
        const top = at(narrow, "WAITING")
        const below = at(narrow, "╔═ ◆ In the Flow · T1.3 details")
        expect({ width, below: below.y > top.y, x: below.x }).toEqual({ width, below: true, x: 1 })
        expect({ width, region: at(narrow, "STOPPED 5", top.y + 1).y > top.y }).toEqual({ width, region: true })
      }
    }),
  120_000,
)
