import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { ScrollBoxRenderable, type CapturedSpan, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { Effect, FileSystem, Option, Result } from "effect"
import path from "path"
import { createComponent, type JSX } from "solid-js"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import type { Sessions } from "../../../tui/src/task-ui/peek"
import { parse, type Status } from "../../../tui/src/task-ui/store"
import { ShortcutBar } from "../../../tui/src/task-ui/ui"
import { LedgerView } from "../../../tui/src/task-ui/designs/1-ledger"
import { DockView } from "../../../tui/src/task-ui/designs/2-dock"
import { HudView } from "../../../tui/src/task-ui/designs/6-hud"
import { TickerDialog } from "../../../tui/src/task-ui/designs/7-ticker"
import { Screen } from "../../../tui/src/task-ui/designs/screen"
import { settle, viewFor } from "../../../tui/test/task-ui/view"
import { testEffect } from "../lib/effect"
import { exhaustLeaf, facts, loadPlan, obligationsOf, trustLeaf } from "./lib/machine"

// Scenario UI9 (spec task-harness-feedback, D19, EXPERIENCE "STOPPED list", "Peek BUILDER heading"; tasks T4.4,
// T4.5): failure reasons appear in every expanded view and in the Peek heading.
//
//   Given a status with a budget-exhausted task, a failed task and a blocked task
//   When each of the seven designs is expanded
//   Then the shared region lists each stopped task with its reason or upstream cause
//   And the Peek BUILDER heading shows the selected task's reason in full, wrapped
//   And the collapsed views keep only the glyph
//
// The status is the harness's own: facts of a release-notes run (T1.1 trusted; T1.2 budget exhausted after three
// failed proofs; T1.3 failed on a merge, with a long reason) folded by the engine (`TaskEngineXState`), projected by
// `TaskStatus.project` and written by `TaskStatus.write` with a fresh heartbeat. The engine blocks T1.4 (after T1.2
// and T1.3), T1.5 (after T1.4) and the parent T1. The task-ui side is the real code, imported by relative path: the
// store's `parse` on the written file, the real `taskView` actor (the tui test helper `viewFor`, which feeds the
// status to the machine's own read), and each design's real component rendered with the opentui test renderer: the
// Ledger, the Dock, the full-screen Board, Matrix and Gantt, the HUD, the Ticker dialog, and the shortcut bar that
// every design shows at the prompt.

const it = testEffect(NodeServices.layer)

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }

const EXHAUSTED = "T1.2.c1: the test asserts only that 'topic change' appears"
const MERGE =
  "the merge of task/T1.3 into dev failed: CONFLICT (content): Merge conflict in src/render.ts; the builder's branch and dev both changed the heading helper"
const START = 1_790_000_000_000

// The run's facts: T1.2 exhausts its budget, then T1.3 fails; the engine blocks T1.4, T1.5 and T1.
const status = Effect.gen(function* () {
  const plan = yield* loadPlan("release-notes.spec")
  const f = facts(START)
  const list = [
    f.runStarted(),
    ...trustLeaf(plan, f, "T1.1"),
    ...exhaustLeaf(f, "T1.2", obligationsOf(plan, "T1.2")[0] ?? ""),
    f.started("T1.3"),
    f.failed("T1.3", MERGE),
  ]
  const snapshot = list.reduce(
    (current, fact) => TaskEngineXState.apply(plan, current, fact),
    TaskEngineXState.initial(plan),
  )
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  // The writer stamps a heartbeat a second after the last fact: the run is live.
  yield* TaskStatus.write(directory, TaskStatus.project(plan, snapshot), START + 1_000)
  const text = yield* fs.readFileString(path.join(directory, ".opencode", "task", "status.json"))
  return Option.getOrThrow(parse(text))
})

type View = Awaited<ReturnType<typeof viewFor>>["view"]

// One design: its number, and its expanded view as the plugin draws it (the full-screen route for 3–5, the dialog for
// 7), in a 120-cell terminal. The Ledger sits in the sidebar, which scrolls: it gets the rows it needs.
const DESIGNS: ReadonlyArray<{ name: string; design: number; height: number; node: (view: View) => JSX.Element }> = [
  {
    name: "Ledger",
    design: 1,
    height: 120,
    node: (view) =>
      createComponent(LedgerView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 38 }),
  },
  {
    name: "Dock",
    design: 2,
    height: 40,
    node: (view) =>
      createComponent(DockView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 120, height: 40 }),
  },
  ...[
    ["Board", 3],
    ["Matrix", 4],
    ["Gantt", 5],
  ].map(([name, design]) => ({
    name: String(name),
    design: Number(design),
    height: 40,
    node: (view: View) =>
      createComponent(Screen, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 120, height: 40 }),
  })),
  {
    name: "HUD",
    design: 6,
    height: 40,
    node: (view) => createComponent(HudView, { theme: () => theme, view, sessions: none, leader: "ctrl+x" }),
  },
  {
    name: "Ticker",
    design: 7,
    height: 40,
    node: (view) => createComponent(TickerDialog, { theme: () => theme, view, sessions: none, leader: "ctrl+x" }),
  },
]

type App = Awaited<ReturnType<typeof testRender>>

const linesOf = (frame: string) => frame.split("\n").map((line) => line.trimEnd())

// The scroll boxes under a renderable.
const scrollBoxes = (node: Renderable): ReadonlyArray<ScrollBoxRenderable> => [
  ...(node instanceof ScrollBoxRenderable ? [node] : []),
  ...node.getChildren().flatMap(scrollBoxes),
]

// The rows of the frame inside `box`, cut to its cells.
const inBox = (frame: string, box: ScrollBoxRenderable) =>
  linesOf(frame)
    .slice(box.y, box.y + box.height)
    .map((line) => line.slice(box.x, box.x + box.width).trimEnd())

// The shared region's whole content, row by row: the scroll box that shows the STOPPED heading, scrolled with the
// mouse wheel until it stops moving, each row kept at its content offset.
const regionOf = async (app: App) => {
  const box = scrollBoxes(app.renderer.root).find((item) =>
    inBox(app.captureCharFrame(), item).some((line) => line.startsWith("STOPPED ")),
  )
  if (!box) throw new Error(`no shared region with a STOPPED list in:\n${app.captureCharFrame()}`)
  const content: string[] = []
  for (let tries = 0; tries < 40; tries++) {
    inBox(app.captureCharFrame(), box).forEach((line, index) => {
      content[box.scrollTop + index] = line
    })
    const top = box.scrollTop
    await app.mockMouse.scroll(box.x + 1, box.y + 1, "down")
    await app.renderOnce()
    if (box.scrollTop === top) break
  }
  return { width: box.width, content }
}

// The rows of the Peek whose title names `unit`, inside its border and padding.
const peekOf = (frame: string, unit: string) => {
  const lines = linesOf(frame)
  const top = lines.findIndex((line) => line.includes(`${unit} details · read-only`))
  if (top < 0) throw new Error(`no Peek for ${unit}`)
  const left = lines[top].indexOf("╔")
  const right = lines[top].indexOf("╗")
  const bottom = lines.findIndex((line, row) => row > top && line[left] === "╚")
  return lines.slice(top + 1, bottom).map((line) => line.slice(left + 2, right - 1).trimEnd())
}

// The BUILDER heading's lines: the first after the 9-cell label, then each row that continues under it.
const headingOf = (peek: ReadonlyArray<string>) => {
  if (!peek[0]?.startsWith("BUILDER  ")) throw new Error(`no BUILDER heading: ${peek[0]}`)
  const rest = peek.slice(1)
  const end = rest.findIndex((line) => line.slice(0, 9).trim() !== "" || line.slice(9).trim() === "")
  return [peek[0].slice(9), ...rest.slice(0, end < 0 ? rest.length : end).map((line) => line.slice(9))]
}

const render = (node: () => JSX.Element, height: number, width = 120) =>
  Effect.promise(async () => {
    const app = await testRender(node, { width, height })
    await app.renderOnce()
    return app
  })

const spansOf = (app: App): ReadonlyArray<CapturedSpan> => app.captureSpans().lines.flatMap((line) => line.spans)
const rgb = (value: { r: number; g: number; b: number } | undefined) => (value ? [value.r, value.g, value.b] : [])

// A view of the status in `design`, with `unit` selected and the view expanded or not.
const viewOf = (current: Status, design: number, unit: string, expanded: boolean) =>
  Effect.promise(async () => {
    const shown = await viewFor(current, { design })
    shown.view.select(unit)
    shown.view.setExpanded(expanded)
    // The actor takes each event on its own fiber: wait until the view follows (a loaded machine can be slow).
    for (let tries = 0; tries < 200; tries++) {
      await settle()
      if (shown.view.selected() === unit && shown.view.expanded() === expanded) break
    }
    expect({ design, selected: shown.view.selected(), expanded: shown.view.expanded() }).toEqual({
      design,
      selected: unit,
      expanded,
    })
    return shown
  })

// Each stopped task's line in full, read from the status: the dead tasks with their state and reason, then the
// blocked tasks with their upstream cause (the tasks that share one cause share a line).
const STOPPED = [
  `⊘ T1.2 budget exhausted — ${EXHAUSTED}`,
  `✗ T1.3 failed — ${MERGE}`,
  "⊖ T1, T1.4 blocked by T1.2: budget exhausted",
  "⊖ T1.5 blocked by T1.4: blocked",
]

it.live(
  "[UI9] the given status: T1.2 budget exhausted, T1.3 failed, and T1.4, T1.5 and T1 blocked by them, each with its reason",
  () =>
    Effect.gen(function* () {
      const current = yield* status
      expect(current.run.tags).toEqual(["active"])
      expect(current.tasks["T1.2"]).toMatchObject({ state: "budget_exhausted", reason: EXHAUSTED, attempts: 3 })
      expect(current.tasks["T1.2"]?.tags).toContain("dead")
      expect(current.tasks["T1.3"]).toMatchObject({ state: "failed", reason: MERGE })
      expect(current.tasks["T1.3"]?.tags).toContain("dead")
      for (const [id, cause] of [
        ["T1", "blocked by T1.2: budget exhausted"],
        ["T1.4", "blocked by T1.2: budget exhausted"],
        ["T1.5", "blocked by T1.4: blocked"],
      ]) {
        expect({ id, task: current.tasks[id] }).toMatchObject({ id, task: { state: "blocked", reason: cause } })
        expect(current.tasks[id]?.tags).toContain("blocked")
      }
      expect(Object.entries(current.tasks).filter(([, task]) => task.tags?.includes("stopped")).length).toBe(5)
    }),
  60_000,
)

it.live(
  "[UI9] each of the seven designs expanded: the shared region lists each stopped task with its reason or upstream cause",
  () =>
    Effect.gen(function* () {
      const current = yield* status
      for (const item of DESIGNS) {
        const { view, dispose } = yield* viewOf(current, item.design, "T1.2", true)
        const app = yield* render(() => item.node(view), item.height)
        const region = yield* Effect.promise(() => regionOf(app))
        app.renderer.destroy()
        dispose()
        const content = region.content
        const from = content.findIndex((line) => line.startsWith("STOPPED "))
        const to = content.findIndex((line) => line.startsWith("SCENARIOS "))
        // The STOPPED heading counts the five stopped tasks; its lines run dead, then blocked.
        expect({ design: item.name, heading: content[from] }).toEqual({ design: item.name, heading: "STOPPED 5" })
        const shown = content.slice(from + 1, to).filter(Boolean)
        expect({ design: item.name, lines: shown.length }).toEqual({ design: item.name, lines: STOPPED.length })
        STOPPED.forEach((full, index) => {
          const line = shown[index] ?? ""
          // The line is the whole text, or its start cut with … at the region's width.
          const whole = line === full
          const cutAtWidth = line.endsWith("…") && line.length === region.width && full.startsWith(line.slice(0, -1))
          expect({ design: item.name, full, line, ok: whole || cutAtWidth }).toEqual({
            design: item.name,
            full,
            line,
            ok: true,
          })
          // Each line names its tasks with the state's glyph, and shows the reason or the upstream cause.
          const shows = full.startsWith("⊖")
            ? line.includes(full.slice(full.indexOf("blocked by"), full.indexOf(":")))
            : line.includes(" — ") && line.split(" — ")[1].length >= 4
          expect({ design: item.name, line, shows }).toEqual({ design: item.name, line, shows: true })
        })
        // Where the region is wide enough, the reason is whole.
        if (region.width >= 90) {
          expect({ design: item.name, lines: shown.filter((line) => STOPPED.includes(line)) }).toEqual({
            design: item.name,
            lines: STOPPED.filter((line) => line.length <= region.width),
          })
        }
      }
    }),
  120_000,
)

it.live(
  "[UI9] each of the seven designs expanded: the Peek BUILDER heading shows the selected task's reason in full, wrapped, in its tone",
  () =>
    Effect.gen(function* () {
      const current = yield* status
      for (const item of DESIGNS) {
        // A dead task: line 1 is its state, attempt and duration; its whole reason follows, wrapped, in the error tone.
        const failed = yield* viewOf(current, item.design, "T1.3", true)
        const app = yield* render(() => item.node(failed.view), item.height)
        const heading = headingOf(peekOf(app.captureCharFrame(), "T1.3"))
        const spans = spansOf(app)
        app.renderer.destroy()
        failed.dispose()
        expect({ design: item.name, first: heading[0] }).toEqual({
          design: item.name,
          first: "failed · attempt 1 · 0s",
        })
        const reason = heading.slice(1)
        expect({ design: item.name, wrapped: reason.length > 1 }).toEqual({ design: item.name, wrapped: true })
        expect({ design: item.name, reason: reason.join(" ") }).toEqual({ design: item.name, reason: MERGE })
        expect(reason.some((line) => line.endsWith("…"))).toBe(false)
        // Every line of the reason is its own piece of the heading, in the error tone (the task has the dead tag).
        const tones = reason.map((line) => rgb(spans.find((span) => span.text === line)?.fg))
        expect({ design: item.name, tones }).toEqual({ design: item.name, tones: reason.map(() => rgb(theme.error)) })

        // A blocked task: its heading starts with the upstream cause, in the warning tone.
        const blocked = yield* viewOf(current, item.design, "T1.4", true)
        const other = yield* render(() => item.node(blocked.view), item.height)
        const cause = headingOf(peekOf(other.captureCharFrame(), "T1.4"))
        const causeSpans = spansOf(other)
        other.renderer.destroy()
        blocked.dispose()
        expect({ design: item.name, cause: cause.join(" ") }).toEqual({
          design: item.name,
          cause: "blocked by T1.2: budget exhausted",
        })
        const causeTones = cause.map((line) => rgb(causeSpans.find((span) => span.text === line)?.fg))
        expect({ design: item.name, causeTones }).toEqual({
          design: item.name,
          causeTones: cause.map(() => rgb(theme.warning)),
        })
      }
    }),
  120_000,
)

it.live(
  "[UI9] the collapsed views keep only the glyph: no reason and no cause, and each stopped task shown by its glyph",
  () =>
    Effect.gen(function* () {
      const current = yield* status
      const reasons = [EXHAUSTED, MERGE, "blocked by"].map((text) => text.slice(0, 10))
      const glyphs = { "T1.2": "⊘ T1.2", "T1.3": "✗ T1.3", "T1.4": "⊖ T1.4", "T1.5": "⊖ T1.5", T1: "⊖ T1" }
      for (const item of DESIGNS) {
        const { view, dispose } = yield* viewOf(current, item.design, "T1.3", false)
        // The collapsed view: the Ledger, the Dock strip and the HUD panel draw their own; every design shows the
        // shortcut bar at the prompt, the only presence of the Board, the Matrix, the Gantt and the Ticker.
        const own = [1, 2, 6].includes(item.design) ? yield* render(() => item.node(view), item.height) : undefined
        // The bar at the prompt of a 200-cell terminal (the demo's tmux window), so no part is dropped for room.
        const bar = yield* render(
          () =>
            createComponent(ShortcutBar, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 200 }),
          4,
          200,
        )
        const frame = [own?.captureCharFrame() ?? "", bar.captureCharFrame()].join("\n")
        own?.renderer.destroy()
        bar.renderer.destroy()
        dispose()
        expect({ design: item.name, expanded: view.expanded() }).toEqual({ design: item.name, expanded: false })
        // No reason and no upstream cause in a collapsed view; nor a Peek or a STOPPED list.
        expect({ design: item.name, reasons: reasons.filter((text) => frame.includes(text)) }).toEqual({
          design: item.name,
          reasons: [],
        })
        expect(frame).not.toContain("BUILDER")
        expect(frame).not.toContain("STOPPED")
        // The tasks it shows carry their glyph: the Ledger's tree and the Dock's chips every stopped task, the HUD's
        // selected-task line and the Ticker's bar part the selected one; the full-screen designs only count them.
        const expected =
          item.design === 1 || item.design === 2
            ? Object.values(glyphs)
            : item.design === 6 || item.design === 7
              ? [glyphs["T1.3"]]
              : []
        expect({ design: item.name, missing: expected.filter((text) => !frame.includes(text)) }).toEqual({
          design: item.name,
          missing: [],
        })
        expect({ design: item.name, count: frame.includes("5 stopped") }).toEqual({ design: item.name, count: true })
      }
    }),
  120_000,
)
