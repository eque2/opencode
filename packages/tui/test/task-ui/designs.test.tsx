/** @jsxImportSource @opentui/solid */
// The full-screen designs (T4.6 Board and Matrix): columns and cards from the tags, causes, waits and durations
// (EXPERIENCE "Board card", "Durations", "Matrix legend"), and where the Board puts its right pane on a narrow screen
// (UI22).
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { CapturedFrame, RGBA } from "@opentui/core"
import { Option, Result } from "effect"
import type { JSX } from "solid-js"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import type { Sessions } from "../../src/task-ui/peek"
import { stoppedLines } from "../../src/task-ui/shared"
import { parse, rows, type Status } from "../../src/task-ui/store"
import { BoardView, cardLines, cardsIn } from "../../src/task-ui/designs/3-board"
import { MatrixView } from "../../src/task-ui/designs/4-matrix"
import { Screen } from "../../src/task-ui/designs/screen"
import projected from "./fixture-projected.json"
import { settle, viewFor } from "./view"

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }

type Raw = typeof projected & { external?: unknown }
type RawTasks = Record<string, Record<string, unknown>>

const statusOf = (change: (raw: Raw) => void = () => {}): Status => {
  const raw: Raw = structuredClone(projected)
  change(raw)
  return Option.getOrThrow(parse(JSON.stringify(raw)))
}
const tasksOf = (raw: Raw): RawTasks => raw.tasks
const base = statusOf()

async function render(node: () => JSX.Element, width = 120, height = 40) {
  const app = await testRender(node, { width, height })
  try {
    await app.renderOnce()
    return { text: app.captureCharFrame(), spans: app.captureSpans() }
  } finally {
    app.renderer.destroy()
  }
}

const linesOf = (text: string) => text.split("\n").map((line) => line.trimEnd())
const fgOf = (captured: CapturedFrame, text: string) =>
  captured.lines.flatMap((line) => line.spans).find((span) => span.text.includes(text))?.fg
const rgb = (value: RGBA | undefined) => (value ? [value.r, value.g, value.b] : [])
const row = (status: Status, id: string) => {
  const found = rows(status).find((item) => item.id === id)
  if (!found) throw new Error(`no ${id}`)
  return found
}

// --- columns (UI1) ---------------------------------------------------------------------------------------------------

// One task in each class: T1.1 waiting, T1.2 building, T1.3 verifying, T1.4 dead, T1.5 blocked, T1 cancelled; the
// projection's T1.e1 makes T1 a parent.
const classes = statusOf((raw) => {
  Object.assign(tasksOf(raw)["T1.1"], { state: "waiting", tags: ["waiting"], waitingOn: ["T1.4"] })
  Object.assign(tasksOf(raw)["T1.2"], { state: "building", tags: ["active"] })
  Object.assign(tasksOf(raw)["T1.3"], { state: "verifying", tags: ["active"] })
  Object.assign(tasksOf(raw)["T1"], { state: "cancelled", tags: ["ended", "stopped"], reason: "user stop" })
})

test("UI1 the Board's columns come from the tags; STOPPED runs in the STOPPED list order", async () => {
  const list = rows(classes)
  expect(cardsIn(list, "WAITING").map((item) => item.id)).toEqual(["T1.1"])
  expect(cardsIn(list, "BUILDING").map((item) => item.id)).toEqual(["T1.2"])
  expect(cardsIn(list, "PROVING").map((item) => item.id)).toEqual([])
  expect(cardsIn(list, "VERIFYING").map((item) => item.id)).toEqual(["T1.3"])
  expect(cardsIn(list, "TRUSTED").map((item) => item.id)).toEqual([])
  // Dead, then blocked, then the rest: T1 (cancelled) is first in the tree and last in STOPPED.
  expect(cardsIn(list, "STOPPED").map((item) => item.id)).toEqual(["T1.4", "T1.5", "T1"])
  expect(cardsIn(list, "STOPPED").map((item) => item.id)).toEqual(stoppedLines(classes).flatMap((line) => line.ids))
  // A task whose state names a phase but whose tags say waiting is a WAITING card: the tags decide.
  const tagged = statusOf((raw) => Object.assign(tasksOf(raw)["T1.1"], { state: "building", tags: ["waiting"] }))
  expect(cardsIn(rows(tagged), "WAITING").map((item) => item.id)).toEqual(["T1.1"])
  expect(cardsIn(rows(tagged), "BUILDING")).toEqual([])
  // A task whose state is waiting but whose tags say ended is a TRUSTED card.
  const ended = statusOf((raw) => Object.assign(tasksOf(raw)["T1.1"], { state: "waiting", tags: ["ended"] }))
  expect(cardsIn(rows(ended), "TRUSTED").map((item) => item.id)).toEqual(["T1.1", "T1.2", "T1.3"])
  expect(cardsIn(rows(ended), "WAITING")).toEqual([])
  const { view } = await viewFor(classes, { design: 3 })
  const board = (
    await render(
      () => <BoardView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={110} />,
      110,
      60,
    )
  ).text
  for (const heading of ["WAITING 1", "BUILDING 1", "PROVING 0", "VERIFYING 1", "TRUSTED 0", "STOPPED 3"])
    expect(board).toContain(heading)
})

// --- cards (UI5, UI11, UI18) -----------------------------------------------------------------------------------------

test("UI18 a blocked card shows ⊖ and its cause in the warning tone, with no separate state label", async () => {
  expect(cardLines(base, row(base, "T1.5"), "live", 0, 30)).toEqual([
    { text: "blocked by T1.4: budget", tone: "warning" },
    { text: "exhausted", tone: "warning" },
    { text: "proofs 0/5", tone: "text" },
  ])
  const { view } = await viewFor(base, { design: 3 })
  const shown = await render(
    () => <BoardView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={110} />,
    110,
    60,
  )
  expect(shown.text).toContain("⊖ T1.5")
  expect(rgb(fgOf(shown.spans, "⊖ T1.5"))).toEqual(rgb(theme.warning))
  expect(rgb(fgOf(shown.spans, "blocked by"))).toEqual(rgb(theme.warning))
  expect(shown.text).not.toMatch(/│ blocked +│/)
})

test("UI11 card line 3: attempt and duration, the duration alone, or nothing; the duration moves down and is never cut", () => {
  const ran = statusOf((raw) => Object.assign(tasksOf(raw)["T1.4"], { startedAt: 0, endedAt: 400_000 }))
  const meta = (status: Status, id: string, inner: number) =>
    cardLines(status, row(status, id), "ended", 0, inner).filter((line) => /attempt|^\d+[smh]/.test(line.text))
  expect(meta(ran, "T1.4", 30)).toEqual([{ text: "attempt 3 · 6m 40s", tone: "muted" }])
  // In 14 cells "attempt 3 · 6m 40s" (18) does not fit: the duration takes its own line, whole.
  expect(meta(ran, "T1.4", 14)).toEqual([
    { text: "attempt 3", tone: "muted" },
    { text: "6m 40s", tone: "muted" },
  ])
  const started = statusOf((raw) => Object.assign(tasksOf(raw)["T1.4"], { attempts: 0, startedAt: 0, endedAt: 45_000 }))
  expect(meta(started, "T1.4", 30)).toEqual([{ text: "45s", tone: "muted" }])
  // A plain card's state line is its label, muted.
  expect(cardLines(base, row(base, "T1.1"), "ended", 0, 30)[0]).toEqual({ text: "trusted", tone: "muted" })
  // T1.5 has no attempt and no start: no line 3.
  expect(meta(base, "T1.5", 30)).toEqual([])
  // The lines in order: state, line 3, proofs, reason.
  expect(cardLines(ran, row(ran, "T1.4"), "ended", 0, 30).map((line) => line.text)).toEqual([
    "budget exhausted",
    "attempt 3 · 6m 40s",
    "proofs 0/11",
    "T1.4.c7: the test asserts only",
    "that 'topic change' appears",
  ])
})

// T1.2 building since 3m 12s before the heartbeat.
const building = statusOf((raw) =>
  Object.assign(tasksOf(raw)["T1.2"], {
    state: "building",
    tags: ["active"],
    startedAt: raw.run.aliveAt - 192_000,
    endedAt: undefined,
  }),
)

test("UI11 a running task's duration counts to now while the view is live, and stops at the heartbeat when still", async () => {
  const aliveAt = building.run.aliveAt ?? 0
  for (const [after, shown] of [
    [10_000, "3m 22s"],
    [60_000, "3m 12s"],
  ] as const) {
    const { view } = await viewFor(building, { design: 3, now: aliveAt + after })
    const board = (
      await render(
        () => <BoardView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={120} />,
        120,
        60,
      )
    ).text
    expect({ after, board: board.includes(shown) }).toEqual({ after, board: true })
    const matrix = linesOf(
      (
        await render(
          () => <MatrixView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={110} />,
          110,
          40,
        )
      ).text,
    )
    expect({ after, matrix: matrix.find((line) => line.includes("◐ T1.2"))?.slice(60, 69) }).toEqual({
      after,
      matrix: shown.padStart(9),
    })
  }
})

test("UI5 a waiting card shows each wait sentence, plan ids first, in their tones; the trust command is never cut", async () => {
  const waiting = statusOf((raw) => {
    Object.assign(tasksOf(raw)["T1.5"], {
      state: "waiting",
      tags: ["waiting"],
      waitingOn: ["T1.3", "T1.4", "T9", "T2.1"],
      waitingOnOutside: ["T9"],
      reason: null,
    })
    Object.assign(raw, { external: { "T2.1": { state: "waiting", tags: ["waiting"] } } })
  })
  const lines = cardLines(waiting, row(waiting, "T1.5"), "live", 0, 16)
  expect(lines).toEqual([
    { text: "waiting on T1.3,", tone: "muted" },
    { text: "T1.4", tone: "muted" },
    { text: "waiting on T9", tone: "warning" },
    { text: "(outside) — run", tone: "warning" },
    { text: "/task trust T9", tone: "warning" },
    { text: "waiting on T2.1", tone: "muted" },
    { text: "(not in this", tone: "muted" },
    { text: "run)", tone: "muted" },
    { text: "proofs 0/5", tone: "text" },
  ])
  const { view } = await viewFor(waiting, { design: 3 })
  const board = (
    await render(
      () => <BoardView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={120} />,
      120,
      60,
    )
  ).text
  expect(board).toContain("/task trust T9")
  expect(board).not.toContain("trust…")
})

test("a dead card's reason is in the error tone, at most 3 lines, cut with …; without dead it is muted", async () => {
  const long = statusOf((raw) =>
    Object.assign(tasksOf(raw)["T1.4"], {
      reason: "T1.4.c7 rejected: the multiline-message test asserts only that the words topic change appear somewhere",
    }),
  )
  const reason = cardLines(long, row(long, "T1.4"), "ended", 0, 16).slice(-3)
  expect(reason.map((line) => line.tone)).toEqual(["bad", "bad", "bad"])
  expect(reason.at(-1)?.text).toEndWith("…")
  expect(reason.every((line) => line.text.length <= 16)).toBe(true)
  expect(cardLines(long, row(long, "T1.4"), "ended", 0, 16).filter((line) => line.tone === "bad")).toHaveLength(3)
  const { view } = await viewFor(long, { design: 3 })
  const shown = await render(
    () => <BoardView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={120} />,
    120,
    60,
  )
  expect(rgb(fgOf(shown.spans, "T1.4.c7"))).toEqual(rgb(theme.error))
  const human = statusOf((raw) =>
    Object.assign(tasksOf(raw)["T1.4"], { state: "needs_human", tags: ["ended", "stopped"], reason: "pick a format" }),
  )
  expect(cardLines(human, row(human, "T1.4"), "ended", 0, 30).at(-1)).toEqual({ text: "pick a format", tone: "muted" })
})

// --- the Matrix (UI11, UI18) -----------------------------------------------------------------------------------------

test("the Matrix: a time column after the proof cells, a 2-cell gap, 7 cells right-aligned; the label column cuts first", async () => {
  const timed = statusOf((raw) => {
    Object.assign(tasksOf(raw)["T1.4"], { startedAt: 0, endedAt: 400_000 })
    Object.assign(tasksOf(raw)["T1.1"], { startedAt: 0, endedAt: 45_000 })
  })
  const { view } = await viewFor(timed, { design: 4 })
  const lines = linesOf(
    (
      await render(
        () => <MatrixView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={110} />,
        110,
        40,
      )
    ).text,
  )
  // 12 obligation columns of 4 cells after the 12-cell label: the last cell ends at 60, then 2 cells, then 7.
  const header = lines.find((line) => line.includes("c1  c2"))
  expect(header?.slice(60)).toBe("     time")
  const t14 = lines.find((line) => line.includes("⊘ T1.4"))
  expect(t14?.slice(60, 69)).toBe("   6m 40s")
  expect(lines.find((line) => line.includes("✓ T1.1"))?.slice(60, 69)).toBe("      45s")
  // T1.5 never started: its time cell is blank.
  expect(
    lines
      .find((line) => line.includes("⊖ T1.5"))
      ?.slice(60)
      .trim(),
  ).toBe("")
  // At 60 cells the label shrinks to 3 and the time column keeps its 7 cells.
  const narrow = linesOf(
    (
      await render(
        () => <MatrixView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={60} />,
        60,
        40,
      )
    ).text,
  )
  expect(narrow.find((line) => line.includes("c1  c2"))?.endsWith("time")).toBe(true)
  expect(narrow.some((line) => line.endsWith("6m 40s"))).toBe(true)
})

test("UI18 the Matrix legend adds ⊖ blocked; its old SCENARIOS block has moved to the shared region", async () => {
  const { view } = await viewFor(base, { design: 4 })
  const shown = (
    await render(
      () => <MatrixView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={120} />,
      120,
      40,
    )
  ).text
  expect(shown).toContain("· pending ◉ proof passed ✓ trusted ✗ failed or rejected ~ stale ○ waiting ⊖ blocked")
  expect(shown).not.toContain("SCENARIOS")
  expect(shown).not.toContain("⊖ S1")
})

// --- the right pane (UI22) -------------------------------------------------------------------------------------------

async function screen(design: number, width: number, height = 60) {
  const { view, dispose } = await viewFor(base, { design })
  view.select("T1.4")
  await settle()
  const shown = await render(
    () => <Screen theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={width} height={height} />,
    width,
    height,
  )
  dispose()
  const lines = linesOf(shown.text)
  // Where `text` first shows at or below row `from` (the Board's own "STOPPED 3" heading is in its top row).
  const at = (text: string, from = 0) => {
    const y = lines.findIndex((line, index) => index >= from && line.includes(text))
    return { x: y < 0 ? -1 : lines[y].indexOf(text), y }
  }
  return { lines, at }
}

test("UI22 the Board's right pane: beside the board from 149 cells, below it under 149, side by side from 110, else stacked", async () => {
  // 149: the Peek, then the region, in a 56-cell pane right of the board.
  const wide = await screen(3, 149)
  const peek = wide.at("╔═ ◆ In the Flow · T1.4 details")
  const region = wide.at("STOPPED 3", wide.at("WAITING 0").y + 1)
  expect(peek.x).toBe(149 - 1 - 56)
  expect(region.x).toBe(peek.x)
  expect(region.y).toBeGreaterThan(peek.y)
  expect(peek.y).toBe(wide.at("WAITING 0").y)
  // 148: below the board, the Peek on the left and the region beside it.
  const below = await screen(3, 148)
  const lowPeek = below.at("╔═ ◆ In the Flow · T1.4 details")
  expect(lowPeek.x).toBe(1)
  expect(lowPeek.y).toBeGreaterThan(below.at("WAITING 0").y)
  const lowRegion = below.at("STOPPED 3", below.at("WAITING 0").y + 1)
  // The Peek takes half the width, at most 72 cells; the region starts after a 1-cell gap.
  expect(lowRegion.x).toBe(1 + 72 + 1)
  expect(below.at("╗", lowPeek.y).x).toBe(72)
  expect(lowRegion.y).toBe(lowPeek.y)
  // 110: still side by side.
  const edge = await screen(3, 110)
  const edgePeek = edge.at("╔═ ◆ In the Flow · T1.4 details")
  expect(edge.at("STOPPED 3", edge.at("WAITING 0").y + 1).y).toBe(edgePeek.y)
  // 109: the board, the Peek, then the region, stacked.
  const narrow = await screen(3, 109)
  const narrowPeek = narrow.at("╔═ ◆ In the Flow · T1.4 details")
  expect(narrowPeek.x).toBe(1)
  const narrowRegion = narrow.at("STOPPED 3", narrow.at("WAITING 0").y + 1)
  expect(narrowRegion.x).toBe(1)
  expect(narrowRegion.y).toBeGreaterThan(narrowPeek.y)
  // The STOPPED list shows on the Board at every width.
  for (const shown of [wide, below, narrow])
    expect(shown.at("⊖ T1, T1.5 blocked by T1.4: budget exhausted").y).toBeGreaterThan(0)
})

test("the Matrix and the Gantt put the shared region above the Peek, at the bottom as today", async () => {
  for (const design of [4, 5]) {
    const shown = await screen(design, 120, 70)
    const peek = shown.at("╔═ ◆ In the Flow · T1.4 details")
    expect({ design, regionFirst: shown.at("STOPPED 3").y < peek.y }).toEqual({ design, regionFirst: true })
    expect({ design, peekAt: peek.x }).toEqual({ design, peekAt: 1 })
  }
})
