import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Option, Result } from "effect"
import path from "path"
import { createComponent, type JSX } from "solid-js"
import { testRender } from "@opentui/solid"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import type { Sessions } from "../../../tui/src/task-ui/peek"
import { parse, type Status } from "../../../tui/src/task-ui/store"
import { HudView } from "../../../tui/src/task-ui/designs/6-hud"
import { Screen } from "../../../tui/src/task-ui/designs/screen"
import { settle, viewFor } from "../../../tui/test/task-ui/view"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, obligationsOf, pass } from "./lib/machine"

// Scenario UI11 (spec task-harness-feedback, D21, EXPERIENCE "Durations"; tasks T4.2, T4.5, T4.6, T4.7): each task
// shows its duration where the UX document places it.
//
//   Given a status with a running task, an ended task and a task that never started
//   When the designs render while the run is live
//   Then the running task's duration counts from its start, the ended task's is fixed, and the unstarted task's is
//     blank
//   And durations appear in the Gantt right column, the Matrix time column, the Board card, the HUD selected-task line
//     and the Peek heading
//   And a duration reads "45s", "3m 12s" or "1h 4m"
//
// The status is the harness's own: facts of a release-notes run with explicit times (T1.1 started, then trusted
// 3m 12s later; T1.2 started and still building; T1.3 never started), folded by the engine (`TaskEngineXState`),
// projected by `TaskStatus.project` and written by `TaskStatus.write` with a fresh heartbeat at the moment the view
// reads it (the job's heartbeat), so the view is live. It is read twice: 45 s and 1 h 4 m after T1.2 started. The
// task-ui side is the real code, imported by relative path: the store's `parse` on the written file, the real
// `taskView` actor (the tui test helper `viewFor`, whose read gives the clock at the heartbeat), the full-screen route
// (`Screen`) of the Board, the Matrix and the Gantt, and the HUD, rendered with the opentui test renderer at 200 x 50
// (the demo's tmux window), with the task under test selected and the view expanded so the Peek shows.

const it = testEffect(NodeServices.layer)
const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }

const T0 = 1_790_000_000_000
const T11_START = T0 + 2_000
const T11_END = T11_START + 192_000
const T12_START = T11_END + 5_000

// A fact at an explicit time.
const at = (fact: Fact, time: number): Fact => ({ ...fact, at: time })

// The status the harness writes when its heartbeat is `now`: T1.1 trusted after 3m 12s, T1.2 building since
// T12_START, T1.3 never started.
const statusAt = (plan: Plan, now: number) =>
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
    const snapshot = list.reduce((s, fact) => TaskEngineXState.apply(plan, s, fact), TaskEngineXState.initial(plan))
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    yield* TaskStatus.write(directory, TaskStatus.project(plan, snapshot), now)
    return Option.getOrThrow(parse(yield* fs.readFileString(path.join(directory, ".opencode", "task", "status.json"))))
  })

// The two clock times the view reads at: T1.2 45 s and 1 h 4 m after its start.
const NOWS = [
  { now: T12_START + 45_000, running: "45s" },
  { now: T12_START + 3_840_000, running: "1h 4m" },
] as const
const ENDED = "3m 12s"
const FORMAT = /^(\d+s|\d+m \d+s|\d+h \d+m)$/
const ANY = /\b(\d+h \d+m|\d+m \d+s|\d+s)\b/

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

// Renders `design` over `current` with `unit` selected and the view expanded: the frame's lines and the view's liveness.
const shown = (current: Status, design: number, unit: string) =>
  Effect.promise(async () => {
    const { view, dispose } = await viewFor(current, { design })
    view.select(unit)
    view.setExpanded(true)
    // The actor takes each event on its own fiber: wait until the view follows.
    for (let tries = 0; tries < 200 && !(view.selected() === unit && view.expanded()); tries++) await settle()
    const node: () => JSX.Element =
      design === 6
        ? () => createComponent(HudView, { theme: () => theme, view, sessions: none, leader: "ctrl+x" })
        : () =>
            createComponent(Screen, {
              theme: () => theme,
              view,
              sessions: none,
              leader: "ctrl+x",
              width: 200,
              height: 50,
            })
    const app = await testRender(node, { width: 200, height: 50 })
    await app.renderOnce()
    const result = {
      lines: linesOf(app.captureCharFrame()),
      liveness: view.liveness(),
      selected: view.selected(),
      expanded: view.expanded(),
    }
    app.renderer.destroy()
    dispose()
    return result
  })

// Every duration placement of the task `unit` (glyph `glyph`), with `unit` selected.
const placements = (current: Status, unit: string, glyph: string) =>
  Effect.gen(function* () {
    const board = yield* shown(current, 3, unit)
    const matrix = yield* shown(current, 4, unit)
    const gantt = yield* shown(current, 5, unit)
    const hud = yield* shown(current, 6, unit)
    for (const view of [board, matrix, gantt, hud])
      expect({ unit, liveness: view.liveness, selected: view.selected, expanded: view.expanded }).toEqual({
        unit,
        liveness: "live",
        selected: unit,
        expanded: true,
      })
    const header = rowOf(matrix.lines, "time")
    return {
      gantt: rowOf(gantt.lines, `${glyph} ${unit} `),
      matrix: rowOf(matrix.lines, `${glyph} ${unit} `),
      matrixHeader: header,
      card: cardOf(board.lines, `${glyph} ${unit}`),
      hud: rowOf(hud.lines, `▾ ${glyph} ${unit} `)
        .slice(rowOf(hud.lines, `▾ ${glyph} ${unit} `).indexOf("▾"))
        .replace(/\s*║$/, "")
        .trimEnd(),
      peek: [
        builderOf(board.lines, unit),
        builderOf(matrix.lines, unit),
        builderOf(gantt.lines, unit),
        builderOf(hud.lines, unit),
      ],
    }
  })

it.live(
  "[UI11] the given status: T1.2 running since its start, T1.1 ended 3m 12s after its start, T1.3 never started; the run is live",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const current = yield* statusAt(plan, NOWS[0].now)
      expect(current.run.tags).toEqual(["active"])
      expect(current.run.aliveAt).toBe(NOWS[0].now)
      expect(current.tasks["T1.2"]).toMatchObject({ state: "building", tags: ["active"], startedAt: T12_START })
      expect(current.tasks["T1.2"]?.endedAt).toBeUndefined()
      expect(current.tasks["T1.1"]).toMatchObject({
        state: "trusted",
        tags: ["ended"],
        startedAt: T11_START,
        endedAt: T11_START + 192_000,
      })
      expect(current.tasks["T1.3"]).toMatchObject({ state: "waiting", tags: ["waiting"] })
      expect(current.tasks["T1.3"]?.startedAt).toBeUndefined()
    }),
  60_000,
)

it.live(
  "[UI11] while live: the running task counts from its start, the ended task is fixed, the unstarted task is blank, in the Gantt, the Matrix, the Board card, the HUD line and the Peek heading",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const seen = new Set<string>()
      for (const item of NOWS) {
        const current = yield* statusAt(plan, item.now)
        for (const [unit, glyph, label, duration] of [
          ["T1.2", "◐", "building · attempt 1", item.running],
          ["T1.1", "✓", "trusted · attempt 1", ENDED],
          ["T1.3", "○", "waiting", ""],
        ] as const) {
          const place = yield* placements(current, unit, glyph)
          const where = { now: item.running, unit }
          // Each placement shows the task.
          expect({
            ...where,
            rows: [place.gantt, place.matrix, place.card[0]].map((row) => row?.includes(unit)),
          }).toEqual({
            ...where,
            rows: [true, true, true],
          })
          if (duration === "") {
            // Blank: no duration anywhere; the Gantt and Matrix columns keep their space.
            expect({ ...where, gantt: place.gantt }).toEqual({ ...where, gantt: place.gantt.replace(ANY, "") })
            expect({ ...where, gantt: place.gantt.endsWith(` ${"".padStart(7)} ${label}`) }).toEqual({
              ...where,
              gantt: true,
            })
            expect({ ...where, matrix: ANY.test(place.matrix) }).toEqual({ ...where, matrix: false })
            expect({ ...where, card: place.card.filter((line) => ANY.test(line)) }).toEqual({ ...where, card: [] })
            expect({ ...where, hud: place.hud }).toEqual({ ...where, hud: `▾ ${glyph} ${unit} ${label}` })
            expect({ ...where, peek: place.peek }).toEqual({ ...where, peek: [label, label, label, label] })
            continue
          }
          seen.add(duration)
          expect({ ...where, format: FORMAT.test(duration) }).toEqual({ ...where, format: true })
          // The Gantt right column: the duration right-aligned in 7 cells, a space, the state text.
          expect({ ...where, gantt: place.gantt.endsWith(` ${duration.padStart(7)} ${label}`) }).toEqual({
            ...where,
            gantt: true,
          })
          // The Matrix time column: the duration, right-aligned under "time".
          expect({ ...where, matrix: place.matrix.endsWith(` ${duration}`) }).toEqual({ ...where, matrix: true })
          expect({ ...where, aligned: place.matrix.length }).toEqual({ ...where, aligned: place.matrixHeader.length })
          // The Board card: line 3 is "attempt 1 · <duration>".
          expect({ ...where, line1: place.card[0] }).toEqual({ ...where, line1: `${glyph} ${unit}` })
          expect({ ...where, line3: place.card[2] }).toEqual({ ...where, line3: `attempt 1 · ${duration}` })
          // The HUD's selected-task line ends with the duration.
          expect({ ...where, hud: place.hud }).toEqual({ ...where, hud: `▾ ${glyph} ${unit} ${label} · ${duration}` })
          // The Peek's BUILDER heading, in every design that shows it: state, attempt and duration.
          expect({ ...where, peek: place.peek }).toEqual({
            ...where,
            peek: [0, 1, 2, 3].map(() => `${label} · ${duration}`),
          })
        }
      }
      // The three forms: under a minute, under an hour, and from an hour.
      expect([...seen].toSorted()).toEqual(["1h 4m", "3m 12s", "45s"])
    }),
  120_000,
)
