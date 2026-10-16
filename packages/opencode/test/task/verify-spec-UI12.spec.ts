import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { type CapturedSpan, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { SpinnerRenderable } from "opentui-spinner"
import { Effect, FileSystem, Option, Result } from "effect"
import path from "path"
import { createComponent, type JSX } from "solid-js"
import type { Fact, Plan } from "@/task/core/model"
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
import { facts, loadPlan, obligationsOf, pass } from "./lib/machine"

// Scenario UI12 (spec task-harness-feedback, owner ruling 5, AD-16, D21, D23; tasks T4.1, T4.2, T4.9): a run that
// stands still freezes its durations and its diamond.
//
//   Given a status whose heartbeat is older than 15 seconds and whose run has not ended
//   When the task-ui renders
//   Then a running task's duration stops at the heartbeat time
//   And the diamond is a static ◆
//
// The status is the harness's own: facts of a release-notes run with explicit times (T1.1 trusted 3m 12s after its
// start; T1.2 started and still building), folded by the engine (`TaskEngineXState`), projected by
// `TaskStatus.project` and written by `TaskStatus.write`, which stamps the heartbeat `run.aliveAt` 1m 40s after T1.2's
// start. The run has not ended. The task-ui reads it later: the real `taskView` actor (the tui test helper `viewFor`,
// whose read gives the clock `now`) decides the liveness from `now - run.aliveAt`. The views are the real ones,
// imported by relative path and rendered with the opentui test renderer at 200 x 50, with the host's animations on:
// the Ledger, the Dock, the full-screen Board, Matrix and Gantt, the HUD, the Ticker dialog and the shortcut bar. The
// controls read the same file exactly 15 s after the heartbeat, when the view is still live.

const it = testEffect(NodeServices.layer)
const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }
const motion = () => true

const T0 = 1_790_000_000_000
const T11_START = T0 + 2_000
const T11_END = T11_START + 192_000
const T12_START = T11_END + 5_000
/** The heartbeat: 1m 40s after T1.2 started. */
const ALIVE_AT = T12_START + 100_000
const AT_HEARTBEAT = "1m 40s"

// A fact at an explicit time.
const at = (fact: Fact, time: number): Fact => ({ ...fact, at: time })

// The status the harness writes with the heartbeat ALIVE_AT: T1.1 trusted, T1.2 building, the run not ended.
const status = (plan: Plan) =>
  Effect.gen(function* () {
    const f = facts()
    const list: ReadonlyArray<Fact> = [
      at(f.runStarted(), T0),
      at(f.started("T1.1"), T11_START),
      at(f.ready("T1.1"), T11_START + 60_000),
      at(f.proved("T1.1", obligationsOf(plan, "T1.1").map(pass)), T11_START + 120_000),
      at(f.verified("T1.1", []), T11_END),
      at(f.started("T1.2"), T12_START),
    ]
    const snapshot = list.reduce(
      (current, fact) => TaskEngineXState.apply(plan, current, fact),
      TaskEngineXState.initial(plan),
    )
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    yield* TaskStatus.write(directory, TaskStatus.project(plan, snapshot), ALIVE_AT)
    return Option.getOrThrow(parse(yield* fs.readFileString(path.join(directory, ".opencode", "task", "status.json"))))
  })

const linesOf = (frame: string) => frame.split("\n").map((line) => line.trimEnd())
const rowOf = (lines: ReadonlyArray<string>, label: string) => lines.find((line) => line.includes(label)) ?? ""

// The text inside the Board card whose first line is `label`, line by line.
const cardOf = (lines: ReadonlyArray<string>, label: string) => {
  const top = lines.findIndex((line) => line.includes(`│ ${label} `))
  if (top < 0) return []
  const x = lines[top].indexOf(`│ ${label} `)
  const right = lines[top].indexOf("│", x + 1)
  const end = lines.findIndex((line, row) => row > top && line[x] === "╰")
  return lines.slice(top, end).map((line) => line.slice(x + 1, right).trim())
}

// The Peek's BUILDER heading line for `unit`.
const builderOf = (lines: ReadonlyArray<string>, unit: string) => {
  const top = lines.findIndex((line) => line.includes(`${unit} details · read-only`))
  const row = lines.slice(top + 1).find((line) => line.includes("║ BUILDER  ")) ?? ""
  return row.slice(row.indexOf("BUILDER  ") + 9, row.lastIndexOf("║")).trim()
}

// The spinner elements under a renderable: the moving diamond.
const spinners = (node: Renderable): ReadonlyArray<SpinnerRenderable> => [
  ...(node instanceof SpinnerRenderable ? [node] : []),
  ...node.getChildren().flatMap(spinners),
]

type View = Awaited<ReturnType<typeof viewFor>>["view"]

// A real view of `current` in `design`, read at `now`, with T1.2 selected and expanded or not.
const viewAt = (current: Status, design: number, now: number, expanded: boolean) =>
  Effect.promise(async () => {
    const shown = await viewFor(current, { design, now })
    shown.view.select("T1.2")
    shown.view.setExpanded(expanded)
    // The actor takes each event on its own fiber: wait until the view follows.
    for (let tries = 0; tries < 200; tries++) {
      if (shown.view.selected() === "T1.2" && shown.view.expanded() === expanded) break
      await settle()
    }
    expect({ design, selected: shown.view.selected(), expanded: shown.view.expanded() }).toEqual({
      design,
      selected: "T1.2",
      expanded,
    })
    return shown
  })

// Renders `node` at 200 x 50: the frame's lines, its spans, and the spinner elements in it.
const render = (node: () => JSX.Element) =>
  Effect.promise(async () => {
    const app = await testRender(node, { width: 200, height: 50 })
    try {
      await app.renderOnce()
      return {
        lines: linesOf(app.captureCharFrame()),
        spans: app.captureSpans().lines.flatMap((line) => line.spans),
        spinners: spinners(app.renderer.root).length,
      }
    } finally {
      app.renderer.destroy()
    }
  })

const props = (view: View) => ({ theme: () => theme, view, sessions: none, leader: "ctrl+x", motion })
const screen = (view: View) => () => createComponent(Screen, { ...props(view), width: 200, height: 50 })

// T1.2's duration in every placement, read at `now`: the Gantt right column, the Matrix time column, the Board card,
// the HUD selected-task line and the Peek heading (in the Board, Matrix, Gantt and HUD views).
const durations = (current: Status, now: number) =>
  Effect.gen(function* () {
    const views = [3, 4, 5, 6].map((design) => viewAt(current, design, now, true))
    const shown: Array<{ lines: ReadonlyArray<string>; liveness: string }> = []
    for (const [index, make] of views.entries()) {
      const { view, dispose } = yield* make
      const frame = yield* render(index === 3 ? () => createComponent(HudView, props(view)) : screen(view))
      shown.push({ lines: frame.lines, liveness: view.liveness() })
      dispose()
    }
    const [board, matrix, gantt, hud] = shown
    const hudRow = rowOf(hud?.lines ?? [], "▾ ◐ T1.2 ")
    return {
      liveness: shown.map((item) => item.liveness),
      gantt: rowOf(gantt?.lines ?? [], "◐ T1.2 "),
      matrix: rowOf(matrix?.lines ?? [], "◐ T1.2 "),
      card: cardOf(board?.lines ?? [], "◐ T1.2")[2] ?? "",
      hud: hudRow.slice(hudRow.indexOf("▾")).replace(/\s*║$/, ""),
      peek: shown.map((item) => builderOf(item.lines, "T1.2")),
    }
  })

// Every In the Flow mark of the task-ui, read at `now` with the host's animations on: the Ledger, the Dock, the HUD,
// the full screen, the Ticker dialog and the shortcut bar.
const marks = (current: Status, now: number) =>
  Effect.gen(function* () {
    const sites: Array<{
      site: string
      spinners: number
      lines: ReadonlyArray<string>
      spans: ReadonlyArray<CapturedSpan>
      liveness: string
    }> = []
    for (const [site, design, node] of [
      ["Ledger", 1, (view: View) => () => createComponent(LedgerView, { ...props(view), width: 38 })],
      ["Dock", 2, (view: View) => () => createComponent(DockView, { ...props(view), width: 160 })],
      ["HUD", 6, (view: View) => () => createComponent(HudView, props(view))],
      ["full screen", 3, screen],
      ["Ticker dialog", 7, (view: View) => () => createComponent(TickerDialog, props(view))],
      ["shortcut bar", 1, (view: View) => () => createComponent(ShortcutBar, { ...props(view), width: 200 })],
    ] as const) {
      const { view, dispose } = yield* viewAt(current, design, now, false)
      const frame = yield* render(node(view))
      sites.push({ site, spinners: frame.spinners, lines: frame.lines, spans: frame.spans, liveness: view.liveness() })
      dispose()
    }
    return sites
  })

it.live(
  "[UI12] the given status: the heartbeat is 1m 40s after T1.2's start and the run has not ended; read more than 15 s later the view stands still",
  () =>
    Effect.gen(function* () {
      const current = yield* status(yield* loadPlan("release-notes.spec"))
      expect(current.run.aliveAt).toBe(ALIVE_AT)
      expect(current.run.tags).toEqual(["active"])
      expect(current.run.endedAt).toBeUndefined()
      expect(current.tasks["T1.2"]).toMatchObject({ state: "building", tags: ["active"], startedAt: T12_START })
      expect(current.tasks["T1.2"]?.endedAt).toBeUndefined()
      // The liveness the real view decides: live up to 15 s after the heartbeat, still after it.
      for (const [after, liveness] of [
        [0, "live"],
        [15_000, "live"],
        [15_001, "still"],
        [60_000, "still"],
        [3_600_000, "still"],
      ] as const) {
        const { view, dispose } = yield* viewAt(current, 1, ALIVE_AT + after, false)
        expect({ after, liveness: view.liveness() }).toEqual({ after, liveness })
        dispose()
      }
    }),
  60_000,
)

it.live(
  "[UI12] a running task's duration stops at the heartbeat time in every placement, however late the view reads; at 15 s it still counts",
  () =>
    Effect.gen(function* () {
      const current = yield* status(yield* loadPlan("release-notes.spec"))
      // Standing still: every placement shows heartbeat - start, 1m 40s, at each later read.
      for (const after of [15_001, 60_000, 3_600_000]) {
        const shown = yield* durations(current, ALIVE_AT + after)
        expect({ after, liveness: shown.liveness }).toEqual({ after, liveness: ["still", "still", "still", "still"] })
        expect({ after, gantt: shown.gantt.endsWith(` ${AT_HEARTBEAT.padStart(7)} building · attempt 1`) }).toEqual({
          after,
          gantt: true,
        })
        expect({ after, matrix: shown.matrix.endsWith(` ${AT_HEARTBEAT}`) }).toEqual({ after, matrix: true })
        expect({ after, card: shown.card }).toEqual({ after, card: `attempt 1 · ${AT_HEARTBEAT}` })
        expect({ after, hud: shown.hud }).toEqual({ after, hud: `▾ ◐ T1.2 building · attempt 1 · ${AT_HEARTBEAT}` })
        expect({ after, peek: shown.peek }).toEqual({
          after,
          peek: [0, 1, 2, 3].map(() => `building · attempt 1 · ${AT_HEARTBEAT}`),
        })
      }
      // The control: read 15 s after the heartbeat, the view is live and the duration counts to now (1m 55s).
      const live = yield* durations(current, ALIVE_AT + 15_000)
      expect(live.liveness).toEqual(["live", "live", "live", "live"])
      expect(live.card).toBe("attempt 1 · 1m 55s")
      expect(live.hud).toBe("▾ ◐ T1.2 building · attempt 1 · 1m 55s")
      expect(live.peek).toEqual([0, 1, 2, 3].map(() => "building · attempt 1 · 1m 55s"))
      expect(live.matrix.endsWith(" 1m 55s")).toBe(true)
      expect(live.gantt.endsWith(` ${"1m 55s".padStart(7)} building · attempt 1`)).toBe(true)
    }),
  180_000,
)

it.live(
  "[UI12] the diamond is a static ◆ at every In the Flow mark while the run stands still, with the host's animations on; while live it moves",
  () =>
    Effect.gen(function* () {
      const current = yield* status(yield* loadPlan("release-notes.spec"))
      for (const after of [15_001, 60_000]) {
        for (const site of yield* marks(current, ALIVE_AT + after)) {
          const where = { after, site: site.site }
          expect({ ...where, liveness: site.liveness }).toEqual({ ...where, liveness: "still" })
          // No spinner element: the diamond is the static ◆, then " In the Flow".
          expect({ ...where, spinners: site.spinners }).toEqual({ ...where, spinners: 0 })
          expect({ ...where, mark: site.lines.some((line) => line.includes("◆ In the Flow")) }).toEqual({
            ...where,
            mark: true,
          })
          // The ◆ is its own cell in the accent tone, not bold.
          const diamond = site.spans.find(
            (span) => span.text.trimStart().startsWith("◆") && !span.text.includes("details"),
          )
          expect({ ...where, diamond: diamond?.text.trim() }).toEqual({ ...where, diamond: "◆" })
          expect({ ...where, fg: [diamond?.fg.r, diamond?.fg.g, diamond?.fg.b] }).toEqual({
            ...where,
            fg: [theme.accent.r, theme.accent.g, theme.accent.b],
          })
        }
      }
      // The control: at 15 s the view is live, and every mark is the moving spinner.
      for (const site of yield* marks(current, ALIVE_AT + 15_000)) {
        expect({ site: site.site, liveness: site.liveness, spinners: site.spinners }).toEqual({
          site: site.site,
          liveness: "live",
          spinners: 1,
        })
      }
    }),
  180_000,
)
