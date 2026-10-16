import { expect, test } from "bun:test"
import type { CapturedFrame, RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { Option, Result } from "effect"
import { createComponent } from "solid-js"
import { CLASS } from "@/task/engine-xstate/machine"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import type { Sessions } from "../../../tui/src/task-ui/peek"
import { parse, type Status } from "../../../tui/src/task-ui/store"
import { GanttView, ganttRange } from "../../../tui/src/task-ui/designs/5-gantt"
import { viewFor } from "../../../tui/test/task-ui/view"

// Scenario UI4 (spec task-harness-feedback, D16, D21, AD-5, AD-16; task T4.7): the Gantt draws each lane from the
// task's spans.
//
//   Given a status whose tasks carry spans
//   When the Gantt renders
//   Then each cell shows the span that holds its middle time, and the cells before the first span are blank
//   And an open span runs to now while live and to the heartbeat while still
//   And a final state with no length takes one cell, and a blocked task shows one warning cell
//
// The status is decoded by the task-ui's own `parse`; each task's tags are the tags the harness's class table gives
// its state. The Gantt is the real `GanttView` over a real taskView actor (the tui test helper `viewFor`: the real
// machine, whose feed read gives the status and the clock), rendered by the opentui test renderer; each lane is read
// from the captured frame, and its colours from the captured spans. The Gantt row is an 11-cell label, the lane, then
// a 30-cell right column, so a Gantt `11 + n + 30` cells wide has an `n`-cell lane. The spans are laid out so that one
// cell is one second.

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }
const LABEL = 11
const RIGHT = 30
const S = 1_000

type TaskState = keyof typeof CLASS.task
type Span = { state: string; from: number; to?: number }

/** A task in `state` with its class tags and `spans`. */
const task = (state: TaskState, spans: ReadonlyArray<Span>, extra: Record<string, unknown> = {}) => ({
  state: CLASS.task[state].shows,
  tags: [...CLASS.task[state].tags],
  attempts: 1,
  waitingOn: [],
  waitingOnOutside: [],
  spans,
  ...extra,
})

const statusOf = (run: Record<string, unknown>, tasks: Record<string, object>): Status =>
  Option.getOrThrow(
    parse(
      JSON.stringify({
        run: {
          spec: "task-formats/blend/release-notes.spec",
          path: "task-formats/blend/release-notes.spec",
          ...run,
        },
        tasks,
        obligations: {},
        scenarios: {},
        history: [],
      }),
    ),
  )

// A run from 0 to 100 s that ended; with the Gantt's 3% tail its range is 0 to 103 s: a 103-cell lane has 1 s cells.
const ENDED_RUN = {
  state: "budget_exhausted",
  tags: [...CLASS.run.budget_exhausted.tags],
  startedAt: 0,
  endedAt: 100 * S,
  aliveAt: 100 * S,
}

const ENDED = statusOf(ENDED_RUN, {
  // Built twice: building ends at 30.4 s, inside cell 30, whose middle (30.5 s) is proving's.
  "T1.1": task("trusted", [
    { state: "waiting", from: 0, to: 10 * S },
    { state: "building", from: 10 * S, to: 30_400 },
    { state: "proving", from: 30_400, to: 40 * S },
    { state: "building", from: 40 * S, to: 60 * S },
    { state: "proving", from: 60 * S, to: 70 * S },
    { state: "verifying", from: 70 * S, to: 80 * S },
    { state: "trusted", from: 80 * S, to: 80 * S },
  ]),
  // Building ends at 30.6 s: cell 30's middle (30.5 s) is still building's.
  "T1.2": task("trusted", [
    { state: "waiting", from: 0, to: 5 * S },
    { state: "building", from: 5 * S, to: 30_600 },
    { state: "proving", from: 30_600, to: 40 * S },
    { state: "trusted", from: 40 * S, to: 40 * S },
  ]),
  // Started at 50 s: nothing before its first span.
  "T1.3": task("cancelled", [
    { state: "building", from: 50 * S, to: 60 * S },
    { state: "cancelled", from: 60 * S, to: 60 * S },
  ]),
  "T1.4": task(
    "budget_exhausted",
    [
      { state: "waiting", from: 0, to: 20 * S },
      { state: "building", from: 20 * S, to: 90 * S },
      { state: "budget_exhausted", from: 90 * S, to: 90 * S },
    ],
    { attempts: 3, startedAt: 20 * S, endedAt: 90 * S },
  ),
  "T1.5": task(
    "blocked",
    [
      { state: "waiting", from: 0, to: 50 * S },
      { state: "blocked", from: 50 * S, to: 50 * S },
    ],
    { attempts: 0, reason: "blocked by T1.4: budget exhausted", blockedBy: { id: "T1.4", state: "budget_exhausted" } },
  ),
  // Building holds only cell 20's middle; verifying (25.6 s to 25.9 s) holds no cell's middle, so no cell shows it.
  "T1.6": task("cancelled", [
    { state: "waiting", from: 0, to: 20_300 },
    { state: "building", from: 20_300, to: 20_600 },
    { state: "proving", from: 20_600, to: 25_600 },
    { state: "verifying", from: 25_600, to: 25_900 },
    { state: "proving", from: 25_900, to: 30 * S },
  ]),
  // No span at all: a blank lane, whatever its state says.
  "T1.7": task("cancelled", [], { attempts: 0 }),
})

/** `count` cells of `block`, for each run. */
const cells = (...runs: ReadonlyArray<[string, number]>) => runs.map(([block, count]) => block.repeat(count)).join("")

async function gantt(status: Status, lane: number, now?: number) {
  const width = LABEL + lane + RIGHT
  const made = await viewFor(status, { design: 5, ...(now === undefined ? {} : { now }) })
  const app = await testRender(
    () => createComponent(GanttView, { theme: () => theme, view: made.view, sessions: none, leader: "ctrl+x", width }),
    { width, height: Object.keys(status.tasks).length + 6 },
  )
  try {
    await app.renderOnce()
    const text = app.captureCharFrame()
    const lines = text.split("\n")
    const at = (id: string) => lines.findIndex((line) => line.slice(0, LABEL).trimEnd().endsWith(` ${id}`))
    return {
      liveness: made.view.liveness(),
      axis: lines[0] ?? "",
      text,
      spans: app.captureSpans(),
      /** The lane of `id`: the `lane` cells after its label. */
      lane: (id: string) => (lines[at(id)] ?? "").slice(LABEL, LABEL + lane),
      row: at,
    }
  } finally {
    app.renderer.destroy()
    made.dispose()
  }
}

const rgb = (value: RGBA | undefined) => (value ? [value.r, value.g, value.b] : [])

/** The colour of each run of `block` on row `row`, in order. */
const colours = (captured: CapturedFrame, row: number, block: string) =>
  (captured.lines[row]?.spans ?? []).filter((span) => span.text.includes(block)).map((span) => rgb(span.fg))

test("[UI4] each lane cell shows the span that holds its middle time; cells before the first span, after the last, and with no span are blank", async () => {
  expect(ganttRange(ENDED, "ended", 0)).toEqual({ start: 0, end: 103 * S })
  const shown = await gantt(ENDED, 103)
  expect(shown.liveness).toBe("ended")
  expect(shown.lane("T1.1")).toBe(
    cells(["░", 10], ["▓", 20], ["▒", 10], ["▓", 20], ["▒", 10], ["▞", 10], ["█", 1], [" ", 22]),
  )
  expect(shown.lane("T1.2")).toBe(cells(["░", 5], ["▓", 26], ["▒", 9], ["█", 1], [" ", 62]))
  // T1.3 started at 50 s: its first 50 cells are blank, not waiting.
  expect(shown.lane("T1.3")).toBe(cells([" ", 50], ["▓", 10], ["█", 1], [" ", 42]))
  expect(shown.lane("T1.6")).toBe(cells(["░", 20], ["▓", 1], ["▒", 9], [" ", 73]))
  expect(shown.lane("T1.6")).not.toContain("▞")
  expect(shown.lane("T1.7")).toBe(" ".repeat(103))
  // The rows are the tasks in tree order, under the time axis.
  expect(["T1.1", "T1.2", "T1.3", "T1.4", "T1.5", "T1.6", "T1.7"].map(shown.row)).toEqual([1, 2, 3, 4, 5, 6, 7])
})

test("[UI4] an open span runs to now while the view is live and to the heartbeat while it is still", async () => {
  // A running run with its heartbeat at 100 s; T1.2 has been building since 90 s, its span still open.
  const open = statusOf(
    { state: "running", tags: [...CLASS.run.running.tags], startedAt: 0, aliveAt: 100 * S },
    {
      "T1.1": task("trusted", [{ state: "trusted", from: 10 * S, to: 10 * S }]),
      "T1.2": task(
        "building",
        [
          { state: "waiting", from: 0, to: 90 * S },
          { state: "building", from: 90 * S },
        ],
        { startedAt: 90 * S },
      ),
    },
  )
  // Live, 10 s after the heartbeat: the range and the open span run to now, 110 s (110 one-second cells).
  const live = await gantt(open, 110, 110 * S)
  expect(live.liveness).toBe("live")
  expect(live.lane("T1.2")).toBe(cells(["░", 90], ["▓", 20]))
  expect(live.axis.trimEnd().endsWith("1m 50s")).toBe(true)
  // Still, 100 s after the heartbeat: both stop at the heartbeat, 100 s (100 one-second cells), not at now.
  const still = await gantt(open, 100, 200 * S)
  expect(still.liveness).toBe("still")
  expect(still.lane("T1.2")).toBe(cells(["░", 90], ["▓", 10]))
  expect(still.axis.trimEnd().endsWith("1m 40s")).toBe(true)
  // The same still run at the live width: the open span still ends at the heartbeat, the last cell of the lane.
  const wide = await gantt(open, 110, 200 * S)
  expect(wide.lane("T1.2").trimEnd().length).toBe(110)
  expect(wide.lane("T1.2").indexOf("▓")).toBeGreaterThan(90)
  // An ended run with the span left open: it fills to run.endedAt, and the 3 s tail stays blank.
  const ended = await gantt(
    statusOf(ENDED_RUN, {
      "T1.2": task("cancelled", [
        { state: "waiting", from: 0, to: 90 * S },
        { state: "building", from: 90 * S },
      ]),
    }),
    103,
  )
  expect(ended.lane("T1.2")).toBe(cells(["░", 90], ["▓", 10], [" ", 3]))
})

test("[UI4] a final state with no length takes one cell, and a blocked task shows one warning cell", async () => {
  const shown = await gantt(ENDED, 103)
  // T1.5 waited from the start to 50 s, then was blocked: 50 waiting cells, then one █, in the warning tone.
  expect(shown.lane("T1.5")).toBe(cells(["░", 50], ["█", 1], [" ", 52]))
  expect(shown.lane("T1.5").split("█").length - 1).toBe(1)
  expect(colours(shown.spans, shown.row("T1.5"), "█")).toEqual([rgb(theme.warning)])
  expect(colours(shown.spans, shown.row("T1.5"), "░")).toEqual([rgb(theme.textMuted)])
  // Each zero-length final span takes the one cell that holds its time, in its state's tone.
  expect(shown.lane("T1.4")).toBe(cells(["░", 20], ["▓", 70], ["█", 1], [" ", 12]))
  expect(colours(shown.spans, shown.row("T1.4"), "█")).toEqual([rgb(theme.error)])
  expect(shown.lane("T1.1").indexOf("█")).toBe(80)
  expect(shown.lane("T1.1").split("█").length - 1).toBe(1)
  expect(colours(shown.spans, shown.row("T1.1"), "█")).toEqual([rgb(theme.success)])
  expect(shown.lane("T1.2").indexOf("█")).toBe(40)
  expect(shown.lane("T1.3").indexOf("█")).toBe(60)
  // The building runs are in the active tone; the legend names the blocks.
  expect(colours(shown.spans, shown.row("T1.4"), "▓")).toEqual([rgb(theme.primary)])
  expect(shown.text).toContain("░ waiting ▓ building ▒ proving ▞ verifying █ ended, in its state's colour")
})
