import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Duration, Effect, FileSystem, Option, Result } from "effect"
import path from "path"
import type { CapturedFrame, RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createComponent, type JSX } from "solid-js"
import { ProofProcess } from "@/task/proof/process"
import { testEffect } from "../lib/effect"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import type { Sessions } from "../../../tui/src/task-ui/peek"
import { DISPLAY, parse, type Status } from "../../../tui/src/task-ui/store"
import { LedgerView } from "../../../tui/src/task-ui/designs/1-ledger"
import { DockView } from "../../../tui/src/task-ui/designs/2-dock"
import { HudView } from "../../../tui/src/task-ui/designs/6-hud"
import { TickerDialog } from "../../../tui/src/task-ui/designs/7-ticker"
import { Screen } from "../../../tui/src/task-ui/designs/screen"
import { settle, viewFor } from "../../../tui/test/task-ui/view"

// Scenario UI25 (spec task-harness-feedback, SD-17, AD-13, AD-16; tasks T4.2, T4.8): a status file from before the
// change is drawn with a defined fallback.
//
//   Given a status file with no tags, no title and no heartbeat, as the old harness or the phase-1 code wrote it
//   When each design renders it
//   Then the view is still, and every design shows the muted line "status from an older harness — type /task to refresh"
//   And the tasks show their glyph and state label from the display table, with no Board column, count or STOPPED
//     group derived from them
//
// The two files are the ones the harness wrote before the change: packages/tui/test/task-ui/fixture-status.json (the
// old harness, before the AD-13 contract; SV17 shows it has none of the AD-13 fields) and the phase-1 status of the
// AC 7 checkpoint c30fc83bb0 (packages/tui/test/task-ui/fixture-phase1.json there, which the checkpoint's core-status
// test required to equal the phase-1 projection of the observed facts; RM26), read with `git show`. Each is decoded by
// the task-ui's `parse` and drawn by the real task-ui code, imported by relative path from packages/tui, on a real
// taskView actor (the tui test helper `viewFor`) with the opentui test renderer, through `createComponent` (this file
// is .spec.ts, so it has no JSX).

const it = testEffect(NodeServices.layer)

const ROOT = path.resolve(import.meta.dir, "../../../..")
const UI_TESTS = path.join(ROOT, "packages", "tui", "test", "task-ui")
/** The AC 7 checkpoint: the merge of phase 1 of this goal into dev. */
const CHECKPOINT = "c30fc83bb07f2ca6586ce4c685fb0db42f4d1608"
const OLDER = "status from an older harness — type /task to refresh"

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }

/** The glyph and the tone colour each state of the two files has in the display table (EXPERIENCE "State vocabulary"). */
const SHOWN: Record<string, { readonly glyph: string; readonly color: RGBA }> = {
  waiting: { glyph: "○", color: theme.textMuted },
  trusted: { glyph: "✓", color: theme.success },
  budget_exhausted: { glyph: "⊘", color: theme.error },
  blocked: { glyph: "⊖", color: theme.warning },
}

/** The two old status files, as text: the old harness's and the phase-1 code's. */
const oldFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const harness = yield* fs.readFileString(path.join(UI_TESTS, "fixture-status.json"))
  const phase1 = yield* ProofProcess.run(
    "git",
    ["show", `${CHECKPOINT}:packages/tui/test/task-ui/fixture-phase1.json`],
    { cwd: ROOT, timeout: Duration.seconds(60), cancelDeadline: Duration.seconds(5) },
  )
  expect(phase1.exitCode).toBe(0)
  return [
    { name: "old harness", text: harness },
    { name: "phase-1 code", text: phase1.stdout },
  ] as const
})

type View = Awaited<ReturnType<typeof viewFor>>["view"]

/** A real taskView actor over `status` (its feed clocked at `now`), disposed with the test's scope. */
const viewOf = (status: Status, design: number, now?: number) =>
  Effect.acquireRelease(
    Effect.promise(() => viewFor(status, { design, now })),
    (made) => Effect.sync(made.dispose),
  )

const render = (node: () => JSX.Element, width: number, height: number) =>
  Effect.promise(async () => {
    const app = await testRender(node, { width, height })
    try {
      await app.renderOnce()
      return { text: app.captureCharFrame(), spans: app.captureSpans() }
    } finally {
      app.renderer.destroy()
    }
  })

const rgb = (value: RGBA | undefined) => (value ? [value.r, value.g, value.b] : [])
const linesOf = (text: string) => text.split("\n")
const fgOf = (captured: CapturedFrame, text: string) =>
  rgb(captured.lines.flatMap((line) => line.spans).find((span) => span.text.includes(text))?.fg)

/**
 * The text of the column `width` cells wide that starts where `text` first shows, read down `rows` rows: the older
 * line wraps inside its own column, and a Peek or a border beside the column stays out.
 */
const column = (frame: string, text: string, width: number, rows = 3) => {
  const lines = linesOf(frame)
  const y = lines.findIndex((line) => line.includes(text))
  if (y < 0) return ""
  const x = lines[y].indexOf(text)
  return lines
    .slice(y, y + rows)
    .map((line) => line.slice(x, x + width).trim())
    .join(" ")
}

/** The row where `lead` first shows, from `lead` to the row's end or to the border of a Peek beside it. */
const rowFrom = (frame: string, lead: string) => {
  const line = linesOf(frame).find((item) => item.includes(lead)) ?? ""
  return (line.slice(line.indexOf(lead)).split(/[║╔╚]/)[0] ?? "").trim()
}

/** Each design's own view, and the width its older line has. */
const DESIGNS: ReadonlyArray<{
  readonly name: string
  readonly design: number
  readonly width: number
  readonly height: number
  readonly line: number
  readonly node: (view: View) => JSX.Element
}> = [
  {
    name: "Ledger",
    design: 1,
    width: 120,
    height: 40,
    line: 38,
    node: (view) =>
      createComponent(LedgerView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 38 }),
  },
  {
    name: "Dock",
    design: 2,
    width: 200,
    height: 6,
    line: 200,
    node: (view) =>
      createComponent(DockView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 200, height: 6 }),
  },
  ...[3, 4, 5].map((design) => ({
    name: ["Board", "Matrix", "Gantt"][design - 3],
    design,
    width: 120,
    height: 50,
    line: 118,
    node: (view: View) =>
      createComponent(Screen, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 120, height: 50 }),
  })),
  {
    name: "HUD",
    design: 6,
    width: 80,
    height: 30,
    line: 40,
    node: (view) => createComponent(HudView, { theme: () => theme, view, sessions: none, leader: "ctrl+x" }),
  },
  {
    name: "Ticker",
    design: 7,
    width: 120,
    height: 40,
    line: 30,
    node: (view) => createComponent(TickerDialog, { theme: () => theme, view, sessions: none, leader: "ctrl+x" }),
  },
]

it.live("[UI25] the old harness's and the phase-1 code's status files have no tags, no title and no heartbeat", () =>
  Effect.gen(function* () {
    for (const file of yield* oldFiles) {
      const status = Option.getOrThrow(parse(file.text))
      expect({ file: file.name, tags: status.run.tags, title: status.run.title, aliveAt: status.run.aliveAt }).toEqual({
        file: file.name,
        tags: undefined,
        title: undefined,
        aliveAt: undefined,
      })
      const units = [...Object.values(status.tasks), ...Object.values(status.scenarios)]
      expect(units.filter((unit) => unit.tags !== undefined)).toEqual([])
      // Each task state of the two files has its row in the display table.
      for (const task of Object.values(status.tasks)) expect(DISPLAY[task.state]?.glyph).toBe(SHOWN[task.state]?.glyph)
    }
  }),
)

it.live(
  "[UI25] the view of an old status file is still at any clock; a fresh heartbeat with tags makes a view live",
  () =>
    Effect.gen(function* () {
      for (const file of yield* oldFiles) {
        const status = Option.getOrThrow(parse(file.text))
        for (const now of [0, 1_791_000_000_000]) {
          const { view } = yield* viewOf(status, 1, now)
          expect({ file: file.name, now, liveness: view.liveness(), live: view.live() }).toEqual({
            file: file.name,
            now,
            liveness: "still",
            live: false,
          })
        }
      }
      // Control: the harness's new status with a heartbeat at the view's clock is live.
      const fs = yield* FileSystem.FileSystem
      const fresh = Option.getOrThrow(parse(yield* fs.readFileString(path.join(UI_TESTS, "fixture-projected.json"))))
      const { view } = yield* viewOf(fresh, 1, fresh.run.aliveAt)
      expect(view.liveness()).toBe("live")
    }),
)

it.live(
  "[UI25] every design shows the muted older-status line",
  () =>
    Effect.gen(function* () {
      for (const file of yield* oldFiles) {
        const status = Option.getOrThrow(parse(file.text))
        for (const design of DESIGNS) {
          const { view } = yield* viewOf(status, design.design)
          yield* Effect.promise(settle)
          const shown = yield* render(() => design.node(view), design.width, design.height)
          const where = { file: file.name, design: design.name }
          expect({ ...where, line: column(shown.text, "status from an older", design.line).includes(OLDER) }).toEqual({
            ...where,
            line: true,
          })
          expect({
            ...where,
            start: fgOf(shown.spans, "status from an older"),
            end: fgOf(shown.spans, "to refresh"),
          }).toEqual({ ...where, start: rgb(theme.textMuted), end: rgb(theme.textMuted) })
        }
      }
    }),
  180_000,
)

it.live(
  "[UI25] the tasks show their display-table glyph and state label, with no Board column, count or STOPPED group derived from them",
  () =>
    Effect.gen(function* () {
      for (const file of yield* oldFiles) {
        const status = Option.getOrThrow(parse(file.text))
        const tasks = Object.entries(status.tasks)
        const trustedStates = tasks.filter(([, task]) => task.state === "trusted").length
        expect(trustedStates).toBeGreaterThan(0)

        // The Ledger and the Ticker's task list: each task's glyph and id in its tone, then its state label.
        for (const [name, design, node] of [
          [
            "Ledger",
            1,
            (view: View) =>
              createComponent(LedgerView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 38 }),
          ],
          [
            "Ticker",
            7,
            (view: View) =>
              createComponent(TickerDialog, { theme: () => theme, view, sessions: none, leader: "ctrl+x" }),
          ],
        ] as const) {
          const { view } = yield* viewOf(status, design)
          const shown = yield* render(() => node(view), 120, 40)
          for (const [id, task] of tasks) {
            const lead = `${SHOWN[task.state].glyph} ${id} `
            const row = rowFrom(shown.text, lead)
            const where = { file: file.name, design: name, id }
            expect({
              ...where,
              row: row.startsWith(lead),
              label: row.includes(task.state.replaceAll("_", " ")),
            }).toEqual({ ...where, row: true, label: true })
            expect({ ...where, fg: fgOf(shown.spans, lead.trimEnd()) }).toEqual({
              ...where,
              fg: rgb(SHOWN[task.state].color),
            })
          }
        }

        // The Dock's chips, the Matrix's rows and the Gantt's lanes: each task's glyph and id.
        for (const design of DESIGNS.filter((item) => ["Dock", "Matrix", "Gantt"].includes(item.name))) {
          const { view } = yield* viewOf(status, design.design)
          const shown = yield* render(() => design.node(view), design.width, design.height)
          for (const [id, task] of tasks)
            expect({
              file: file.name,
              design: design.name,
              id,
              shown: shown.text.includes(`${SHOWN[task.state].glyph} ${id}`),
            }).toEqual({ file: file.name, design: design.name, id, shown: true })
        }

        // The Board: every column empty, so no task sits in a column its state would name.
        const board = yield* viewOf(status, 3)
        board.view.setExpanded(true)
        yield* Effect.promise(settle)
        const boardShown = yield* render(
          () =>
            createComponent(Screen, {
              theme: () => theme,
              view: board.view,
              sessions: none,
              leader: "ctrl+x",
              width: 120,
              height: 50,
            }),
          120,
          50,
        )
        const heads = boardShown.text.match(/(WAITING|BUILDING|PROVING|VERIFYING|TRUSTED|STOPPED) \d+/g) ?? []
        expect({ file: file.name, heads }).toEqual({
          file: file.name,
          heads: ["WAITING 0", "BUILDING 0", "PROVING 0", "VERIFYING 0", "TRUSTED 0", "STOPPED 0"],
        })
        expect(boardShown.text).not.toContain("╭")

        // No count from the states: the trusted count credits no task by its state, and no stopped count shows.
        const total = tasks.length
        for (const design of DESIGNS) {
          const { view } = yield* viewOf(status, design.design)
          view.setExpanded(true)
          yield* Effect.promise(settle)
          const shown = yield* render(() => design.node(view), design.width, design.height)
          const where = { file: file.name, design: design.name }
          expect({ ...where, credited: shown.text.includes(`${trustedStates}/${total} trusted`) }).toEqual({
            ...where,
            credited: false,
          })
          expect({ ...where, stopped: /\d+ stopped/.test(shown.text) }).toEqual({ ...where, stopped: false })
          // No STOPPED group in the shared region: only the Board's own empty column heading names STOPPED.
          expect({ ...where, groups: shown.text.match(/STOPPED(?! 0\b)/g) ?? [] }).toEqual({ ...where, groups: [] })
        }
      }
    }),
  180_000,
)
