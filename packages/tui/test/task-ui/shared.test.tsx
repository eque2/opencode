/** @jsxImportSource @opentui/solid */
// The shared region (EXPERIENCE "Shared region", "STOPPED list", "SCENARIOS list", "Run warning", "Outside wait
// line"): its pure line builders, its render over a real view actor, its place in the expanded view of all seven
// designs, its scroll keys and its clicks.
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { Option, Result } from "effect"
import type { JSX } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import type { Sessions } from "../../src/task-ui/peek"
import {
  SharedRegion,
  TITLE_MIN,
  columnsOf,
  entryPieces,
  fit,
  outsideWaits,
  pageBy,
  reasonLines,
  scenarioEntries,
  scenariosHeading,
  stoppedLines,
  stoppedPieces,
  textOf,
  warningOf,
} from "../../src/task-ui/shared"
import { parse, tone, type Status } from "../../src/task-ui/store"
import type { Ctx } from "../../src/task-ui/ui"
import { LedgerView } from "../../src/task-ui/designs/1-ledger"
import { DockView } from "../../src/task-ui/designs/2-dock"
import { HudView } from "../../src/task-ui/designs/6-hud"
import { TickerDialog, registerTicker } from "../../src/task-ui/designs/7-ticker"
import { Screen, registerScreen } from "../../src/task-ui/designs/screen"
import { BoardView, boardRows } from "../../src/task-ui/designs/3-board"
import { MatrixView, matrixRows } from "../../src/task-ui/designs/4-matrix"
import { GanttView, ganttRows } from "../../src/task-ui/designs/5-gantt"
import projected from "./fixture-projected.json"
import { settle, viewFor } from "./view"

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }

type Raw = typeof projected
type Units = Record<string, { state: string; tags: string[]; waitingOn: string[]; reason?: string }>

// The projected status (T1.4 budget exhausted; T1, T1.5 blocked by it; the run running), changed by `change`.
const statusOf = (change: (raw: Raw) => void = () => {}): Status => {
  const raw = structuredClone(projected)
  change(raw)
  return Option.getOrThrow(parse(JSON.stringify(raw)))
}
const base = statusOf()
const tasksOf = (raw: Raw): Units => raw.tasks
const scenariosOf = (raw: Raw): Units => raw.scenarios
const WARNING =
  "R3 T1-release-notes.task/T1.1-commit-parser.task/VERIFY.md: obligation T1.1.c9 is not in the loaded plan\nR4 T1-release-notes.task/T1.2-version-bump.task/TASK.md: body does not start with `# <title>`"
const REJECTED =
  "the test asserts only that the heading exists and never checks that the groups under it come in the fixed order the format sets"

// T1.5 waits on the outside precondition T9, still untrusted.
const waitsOnT9 = (raw: Raw) => {
  Object.assign(tasksOf(raw)["T1.5"], {
    state: "waiting",
    tags: ["waiting"],
    waitingOn: ["T9"],
    waitingOnOutside: ["T9"],
  })
}
const ended = (raw: Raw) => {
  raw.run.state = "budget_exhausted"
  raw.run.tags = ["ended", "stopped"]
}

async function render(node: () => JSX.Element, width = 120, height = 40) {
  const app = await testRender(node, { width, height })
  await app.renderOnce()
  return app
}

const linesOf = (frame: string) => frame.split("\n").map((line) => line.trimEnd())
const rowOf = (frame: string, text: string) => linesOf(frame).findIndex((line) => line.includes(text))

async function regionFrame(status: Status, width = 120, height = 60) {
  const { view } = await viewFor(status)
  const app = await render(
    () => <SharedRegion theme={() => theme} view={view} width={width} height={height} />,
    width,
    height,
  )
  const frame = app.captureCharFrame()
  app.renderer.destroy()
  return frame
}

// --- the order and the empty sections --------------------------------------------------------------------------------

test("the region runs the warning list, the outside wait lines, STOPPED, then SCENARIOS", async () => {
  const status = statusOf((raw) => {
    Object.assign(raw.run, { warning: WARNING })
    waitsOnT9(raw)
  })
  const frame = await regionFrame(status)
  const order = [
    "! spec no longer validates · 2 failures",
    "waiting on T9 (outside) — run /task trust T9",
    "STOPPED ",
    "SCENARIOS 13",
  ].map((text) => rowOf(frame, text))
  expect(order.every((row) => row >= 0)).toBe(true)
  expect(order).toEqual(order.toSorted((a, b) => a - b))
})

test("a section with nothing to show is hidden, except the SCENARIOS heading (UI21)", async () => {
  const status = statusOf((raw) => {
    for (const task of Object.values(tasksOf(raw)))
      Object.assign(task, { state: "trusted", tags: ["ended"], reason: undefined })
    Object.assign(raw, { scenarios: {} })
  })
  expect(warningOf(status)).toBeUndefined()
  expect(outsideWaits(status)).toEqual([])
  expect(stoppedLines(status)).toEqual([])
  expect(scenariosHeading(status)).toBe("SCENARIOS none in this run")
  expect(linesOf(await regionFrame(status)).filter(Boolean)).toEqual(["SCENARIOS none in this run"])
})

// --- the run warning and the outside waits ---------------------------------------------------------------------------

test("UI16 the run warning: its one line, each failure line, then the note", async () => {
  const status = statusOf((raw) => Object.assign(raw.run, { warning: WARNING }))
  const warning = warningOf(status)
  expect(warning).toEqual({
    head: "! spec no longer validates · 2 failures",
    lines: WARNING.split("\n"),
    note: "The run keeps the plan it loaded.",
  })
  const frame = linesOf(await regionFrame(status))
  const at = frame.indexOf("! spec no longer validates · 2 failures")
  expect(frame.slice(at, at + 4)).toEqual([
    "! spec no longer validates · 2 failures",
    ...WARNING.split("\n"),
    "The run keeps the plan it loaded.",
  ])
  // One failure reads "1 failure".
  expect(warningOf(statusOf((raw) => Object.assign(raw.run, { warning: "R3 a: b" })))?.head).toBe(
    "! spec no longer validates · 1 failure",
  )
})

test("UI5 an outside wait line for each untrusted outside id while the run lacks ended; none once it ends or trusts", async () => {
  const waiting = statusOf(waitsOnT9)
  expect(outsideWaits(waiting)).toEqual(["T9"])
  expect(await regionFrame(waiting)).toContain("waiting on T9 (outside) — run /task trust T9")
  // The run ended: no wait line.
  const over = statusOf((raw) => {
    waitsOnT9(raw)
    ended(raw)
  })
  expect(outsideWaits(over)).toEqual([])
  expect(await regionFrame(over)).not.toContain("run /task trust")
  // T9 trusted: no wait line either.
  const trusted = statusOf((raw) => {
    waitsOnT9(raw)
    Object.assign(raw, { outside: { ...raw.outside, T9: { state: "trusted", tags: ["ended"] } } })
  })
  expect(outsideWaits(trusted)).toEqual([])
  // Two waits, met in the order T9 (a task) then T8 (a scenario): the lines run in natural order.
  const two = statusOf((raw) => {
    waitsOnT9(raw)
    Object.assign(scenariosOf(raw)["S12"], {
      state: "waiting",
      tags: ["waiting"],
      waitingOn: ["T8"],
      waitingOnOutside: ["T8"],
    })
  })
  expect(outsideWaits(two)).toEqual(["T8", "T9"])
})

// --- STOPPED (UI9) ---------------------------------------------------------------------------------------------------

test("UI9 STOPPED: one line per state and reason, ids in natural order, dead then blocked then the rest", async () => {
  expect(stoppedLines(base)).toEqual([
    {
      state: "budget_exhausted",
      ids: ["T1.4"],
      reason: "T1.4.c7: the test asserts only that 'topic change' appears",
      blocked: false,
    },
    { state: "blocked", ids: ["T1", "T1.5"], reason: "blocked by T1.4: budget exhausted", blocked: true },
  ])
  // A cancelled task (the rest) comes after the blocked line, though it is earlier in the tree.
  const cancelled = statusOf((raw) =>
    Object.assign(tasksOf(raw)["T1.2"], { state: "cancelled", tags: ["ended", "stopped"], reason: "user stop" }),
  )
  expect(stoppedLines(cancelled).map((line) => line.state)).toEqual(["budget_exhausted", "blocked", "cancelled"])
  const frame = await regionFrame(cancelled)
  expect(frame).toContain("STOPPED 4")
  expect(frame).toContain("⊘ T1.4 budget exhausted — T1.4.c7: the test asserts only that 'topic change' appears")
  expect(frame).toContain("⊖ T1, T1.5 blocked by T1.4: budget exhausted")
  expect(frame).toContain("– T1.2 cancelled — user stop")
  // Two blocked tasks with different causes get a line each; one reason in two states gets a line for each state.
  const causes = statusOf((raw) => {
    Object.assign(tasksOf(raw)["T1.5"], {
      reason: "blocked by T1.2: failed",
      blockedBy: { id: "T1.2", state: "failed" },
    })
    Object.assign(tasksOf(raw)["T1.3"], {
      state: "cancelled",
      tags: ["ended", "stopped"],
      reason: "blocked by T1.4: budget exhausted",
    })
  })
  expect(stoppedLines(causes).map((line) => [line.state, line.ids, line.reason])).toEqual([
    ["budget_exhausted", ["T1.4"], "T1.4.c7: the test asserts only that 'topic change' appears"],
    ["blocked", ["T1"], "blocked by T1.4: budget exhausted"],
    ["blocked", ["T1.5"], "blocked by T1.2: failed"],
    ["cancelled", ["T1.3"], "blocked by T1.4: budget exhausted"],
  ])
  const shown = await regionFrame(causes)
  expect(shown).toContain("⊖ T1 blocked by T1.4: budget exhausted")
  expect(shown).toContain("⊖ T1.5 blocked by T1.2: failed")
  expect(shown).toContain("– T1.3 cancelled — blocked by T1.4: budget exhausted")
})

test("UI9 a STOPPED line: the ids in the state's tone, the reason muted, a blocked reason in the warning tone", () => {
  const [dead, blocked] = stoppedLines(base)
  const pieces = stoppedPieces(dead, 100)
  expect(pieces[0]).toEqual({ text: "⊘ T1.4", tone: tone("budget_exhausted") })
  expect(pieces.at(-1)?.tone).toBe("muted")
  expect(stoppedPieces(blocked, 100)).toEqual([
    { text: "⊖ T1, T1.5", tone: tone("blocked") },
    { text: " blocked by T1.4: budget exhausted", tone: "warning" },
  ])
})

test("UI9 ids that do not fit end with +N; under 30 cells the reason goes and the state stays", () => {
  const many = {
    state: "blocked",
    ids: ["T1.1", "T1.2", "T1.3", "T1.4", "T1.5", "T1.6"],
    reason: "blocked by T9: x",
    blocked: true,
  }
  const text = textOf(stoppedPieces(many, 45))
  expect(text).toStartWith("⊖ T1.1, T1.2")
  expect(text).toMatch(/, \+\d+ blocked by T9/)
  expect(stoppedPieces(many, 45).some((piece) => piece.text.includes("+") && piece.tone === "muted")).toBe(true)
  const [dead, blocked] = stoppedLines(base)
  expect(textOf(stoppedPieces(dead, 29))).toBe("⊘ T1.4 budget exhausted")
  expect(textOf(stoppedPieces(blocked, 29))).toBe("⊖ T1, T1.5 blocked")
  // At 30 cells the reason stays, cut with ….
  expect(textOf(stoppedPieces(dead, 30))).toBe("⊘ T1.4 budget exhausted — T1.…")
  expect(textOf(stoppedPieces(blocked, 30))).toBe("⊖ T1, T1.5 blocked by T1.4: b…")
  // A long line is cut with … to its width.
  expect(textOf(stoppedPieces(dead, 40))).toHaveLength(40)
  expect(textOf(stoppedPieces(dead, 40))).toEndWith("…")
})

test("a click on a STOPPED line selects its first task", async () => {
  const { view } = await viewFor(base)
  const app = await render(() => <SharedRegion theme={() => theme} view={view} width={100} height={40} />, 100, 40)
  const frame = app.captureCharFrame()
  await app.mockMouse.pressDown(2, rowOf(frame, "⊖ T1, T1.5"))
  await settle()
  expect(view.selected()).toBe("T1")
  await app.mockMouse.pressDown(2, rowOf(frame, "⊘ T1.4"))
  await settle()
  expect(view.selected()).toBe("T1.4")
  app.renderer.destroy()
})

test("fit cuts the piece that does not fit with …, and keeps the line to its width", () => {
  const pieces = [
    { text: "abc", tone: "text" as const },
    { text: "defg", tone: "muted" as const },
  ]
  expect(fit(pieces, 7)).toEqual(pieces)
  expect(fit(pieces, 6)).toEqual([pieces[0], { text: "de…", tone: "muted" }])
  expect(textOf(fit(pieces, 3))).toBe("abc")
})

// --- SCENARIOS (UI10) ------------------------------------------------------------------------------------------------

test("UI10 SCENARIOS: the heading with the trusted count, one entry per scenario in natural order", () => {
  expect(scenariosHeading(base)).toBe("SCENARIOS 13 · 0/13 trusted")
  const two = statusOf((raw) => {
    for (const id of ["S2", "S3"]) Object.assign(scenariosOf(raw)[id], { state: "trusted", tags: ["ended"] })
  })
  expect(scenariosHeading(two)).toBe("SCENARIOS 13 · 2/13 trusted")
  // The count reads the tags: a passed scenario (active) is not trusted yet.
  const passed = statusOf((raw) => Object.assign(scenariosOf(raw)["S2"], { state: "passed", tags: ["active"] }))
  expect(scenariosHeading(passed)).toBe("SCENARIOS 13 · 0/13 trusted")
  expect(scenarioEntries(base).map((entry) => entry.id)).toEqual(Array.from({ length: 13 }, (_, i) => `S${i + 1}`))
  // The status lists the scenarios backwards: the entries still run S1, S2, …, S10, …, S13.
  const backwards = statusOf((raw) =>
    Object.assign(raw, { scenarios: Object.fromEntries(Object.entries(raw.scenarios).toReversed()) }),
  )
  expect(scenarioEntries(backwards).map((entry) => entry.id)).toEqual(Array.from({ length: 13 }, (_, i) => `S${i + 1}`))
  expect(textOf(entryPieces(scenarioEntries(base)[1], 120))).toBe(
    "· S2 pending · A conventional message is read into its parts",
  )
  const pieces = entryPieces(scenarioEntries(base)[1], 120)
  expect(pieces.map((piece) => piece.tone)).toEqual([tone("pending"), "muted", "muted", "text"])
})

test("UI10 a waiting entry names its waits with (outside); after the run ends it reads not run", () => {
  const waiting = (raw: Raw) =>
    Object.assign(scenariosOf(raw)["S12"], {
      state: "waiting",
      tags: ["waiting"],
      waitingOn: ["T1.4", "T8"],
      waitingOnOutside: ["T8"],
    })
  const live = scenarioEntries(statusOf(waiting))[11]
  expect(textOf(entryPieces(live, 120))).toBe(
    "○ S12 waiting on T1.4, T8 (outside) · Every commit in the range appears exactly once",
  )
  expect(live.label.find((piece) => piece.text === " (outside)")?.tone).toBe("warning")
  const over = scenarioEntries(
    statusOf((raw) => {
      waiting(raw)
      ended(raw)
    }),
  )[11]
  expect(textOf(entryPieces(over, 120))).toStartWith("○ S12 not run: waiting on T1.4, T8 (outside) · ")
  // A parked scenario with nothing left to wait on reads "not run" too.
  const parked = scenarioEntries(
    statusOf((raw) => {
      Object.assign(scenariosOf(raw)["S12"], { state: "waiting", tags: ["waiting"], waitingOn: [] })
      ended(raw)
    }),
  )[11]
  expect(textOf(parked.label)).toBe("not run")
})

test("UI10 a blocked entry shows its reason; a rejected or failed reason goes under its entry, 4 cells in, at most 2 lines", async () => {
  expect(textOf(entryPieces(scenarioEntries(base)[4], 120))).toStartWith(
    "⊖ S5 blocked by T1.5: blocked · Issue references",
  )
  expect(scenarioEntries(base)[4].label[0].tone).toBe("warning")
  const status = statusOf((raw) => {
    Object.assign(scenariosOf(raw)["S4"], { state: "rejected", tags: ["ended", "stopped"], reason: REJECTED })
    Object.assign(scenariosOf(raw)["S7"], { state: "failed", tags: ["ended", "stopped"], reason: "exit 1" })
  })
  const s4 = scenarioEntries(status)[3]
  expect(s4.reason).toBe(REJECTED)
  const under = reasonLines(REJECTED, 60)
  expect(under).toHaveLength(2)
  expect(under.every((line) => line.startsWith("    ") && line.length <= 60)).toBe(true)
  expect(under[1]).toEndWith("…")
  expect(reasonLines("exit 1", 60)).toEqual(["    exit 1"])
  const frame = linesOf(await regionFrame(status, 60))
  const at = frame.findIndex((line) => line.startsWith("✗ S4 rejected"))
  expect(frame.slice(at + 1, at + 3)).toEqual([...under])
  expect(frame[at + 3]).toStartWith("⊖ S5")
  const s7 = frame.findIndex((line) => line.startsWith("✗ S7 failed"))
  expect(frame[s7 + 1]).toBe("    exit 1")
  expect(frame[s7 + 2]).toStartWith("⊖ S8")
  // A blocked scenario's reason is its label, never a line under it.
  expect(scenarioEntries(base)[4].reason).toBe("")
})

// --- columns and cutting ---------------------------------------------------------------------------------------------

test("two columns from 80 cells, filled column first; one column below 80", async () => {
  const entries = scenarioEntries(base)
  expect(columnsOf(entries, 80).map((column) => column.map((entry) => entry.id))).toEqual([
    ["S1", "S2", "S3", "S4", "S5", "S6", "S7"],
    ["S8", "S9", "S10", "S11", "S12", "S13"],
  ])
  expect(columnsOf(entries, 79)).toHaveLength(1)
  const wide = linesOf(await regionFrame(base, 80))
  expect(wide.find((line) => line.startsWith("⊖ S1 "))).toContain("S8 ")
  const narrow = linesOf(await regionFrame(base, 79))
  expect(narrow.find((line) => line.startsWith("⊖ S1 "))).not.toContain("S8 ")
})

test("the glyph, id and state label are never cut; a wait list is cut before the title goes below 12 cells", () => {
  const status = statusOf((raw) =>
    Object.assign(scenariosOf(raw)["S12"], {
      state: "waiting",
      tags: ["waiting"],
      waitingOn: ["T1.1", "T1.2", "T1.3", "T1.4", "T1.5", "T8"],
      waitingOnOutside: ["T8"],
    }),
  )
  const pieces = entryPieces(scenarioEntries(status)[11], 50)
  const text = textOf(pieces)
  expect(text).toStartWith("○ S12 waiting on T1.1")
  expect(text.length).toBeLessThanOrEqual(50)
  expect(TITLE_MIN).toBe(12)
  expect(pieces.at(-1)?.text.length).toBeGreaterThanOrEqual(12)
  // A blocked reason longer than a 38-cell column: the entry is cut to the column with ….
  const narrow = textOf(entryPieces(scenarioEntries(base)[9], 38))
  expect(narrow).toHaveLength(38)
  expect(narrow).toStartWith("⊖ S10 blocked by T1.4: budget")
  expect(narrow).toEndWith("…")
  // A state label is kept whole even when the title gets less than 12 cells.
  const rejected = entryPieces(
    scenarioEntries(
      statusOf((raw) => Object.assign(scenariosOf(raw)["S4"], { state: "rejected", tags: ["ended", "stopped"] })),
    )[3],
    20,
  )
  expect(textOf(rejected)).toStartWith("✗ S4 rejected · ")
})

// --- the seven designs -----------------------------------------------------------------------------------------------

// The scroll boxes under a renderable.
const scrollBoxes = (node: Renderable): ReadonlyArray<ScrollBoxRenderable> => [
  ...(node instanceof ScrollBoxRenderable ? [node] : []),
  ...node.getChildren().flatMap(scrollBoxes),
]

// The cells of the frame inside `box`: the region's own rows, never a design's rows around it.
const inBox = (frame: string, box: ScrollBoxRenderable) =>
  linesOf(frame)
    .slice(box.y, box.y + box.height)
    .map((line) => line.slice(box.x, box.x + box.width))
    .join("\n")

// The region's scroll box: the one whose cells hold the SCENARIOS heading of the shared region.
const regionBox = (app: Awaited<ReturnType<typeof render>>) => {
  const frame = app.captureCharFrame()
  const box = scrollBoxes(app.renderer.root).find((item) => inBox(frame, item).includes("SCENARIOS 13 ·"))
  if (!box) throw new Error("no shared region")
  return box
}

// Every entry the region shows, inside its own box, scrolling it with the mouse wheel until it stops moving.
async function regionContent(app: Awaited<ReturnType<typeof render>>) {
  const box = regionBox(app)
  const seen = [inBox(app.captureCharFrame(), box)]
  for (let tries = 0; tries < 20; tries++) {
    const top = box.scrollTop
    await app.mockMouse.scroll(box.x + 1, box.y + 1, "down")
    await app.renderOnce()
    if (box.scrollTop === top) break
    seen.push(inBox(app.captureCharFrame(), box))
  }
  return seen.join("\n")
}

test("the release-notes status at 120 × 40 holds S1–S13 in the region of each of the seven designs", async () => {
  const ids = Array.from({ length: 13 }, (_, i) => `S${i + 1} `)
  const designs: ReadonlyArray<[string, number, (view: Awaited<ReturnType<typeof viewFor>>["view"]) => JSX.Element]> = [
    ["Ledger", 1, (view) => <LedgerView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={38} />],
    ["Dock", 2, (view) => <DockView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={120} />],
    [
      "Board",
      3,
      (view) => <Screen theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={120} height={40} />,
    ],
    [
      "Matrix",
      4,
      (view) => <Screen theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={120} height={40} />,
    ],
    [
      "Gantt",
      5,
      (view) => <Screen theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={120} height={40} />,
    ],
    ["HUD", 6, (view) => <HudView theme={() => theme} view={view} sessions={none} leader="ctrl+x" />],
    ["Ticker", 7, (view) => <TickerDialog theme={() => theme} view={view} sessions={none} leader="ctrl+x" />],
  ]
  for (const [name, design, node] of designs) {
    const { view, dispose } = await viewFor(base, { design })
    view.setExpanded(true)
    await settle()
    const app = await render(() => node(view), 120, 40)
    const content = await regionContent(app)
    expect({ name, missing: ids.filter((id) => !content.includes(id)) }).toEqual({ name, missing: [] })
    expect({ name, heading: content.includes("SCENARIOS 13 · 0/13 trusted") }).toEqual({ name, heading: true })
    app.renderer.destroy()
    dispose()
  }
})

test("the full-screen designs at 120 × 40 never draw over the Peek; its activity lines shrink when the view is too tall", async () => {
  const activity = Array.from({ length: 8 }, (_, i) => ({
    glyph: "›",
    tone: "idle" as const,
    text: `activity line ${i + 1}`,
  }))
  const sessions: Sessions = {
    children: () => () => [{ id: "b", role: "builder", again: false, created: 1, updated: 1 }],
    activity: () => () => activity,
    all: () => () => [],
  }
  for (const design of [3, 4, 5]) {
    for (const height of [40, 80]) {
      const { view, dispose } = await viewFor(base, { design })
      view.select("T1.4")
      await settle()
      const app = await render(
        () => (
          <Screen theme={() => theme} view={view} sessions={sessions} leader="ctrl+x" width={120} height={height} />
        ),
        120,
        height,
      )
      const lines = linesOf(app.captureCharFrame())
      const top = lines.findIndex((line) => line.includes("╔═ ◆ In the Flow · T1.4 details · read-only ═"))
      // The Peek's title border is whole.
      expect({ design, height, titled: top >= 0 }).toEqual({ design, height, titled: true })
      if (top < 0) continue
      const left = lines[top].indexOf("╔")
      const right = lines[top].indexOf("╗")
      const bottom = lines.findIndex((line, row) => row > top && line[left] === "╚")
      // Every row of the Peek has both its borders, and the BUILDER line is whole: nothing is drawn over it.
      const rows = lines.slice(top + 1, bottom)
      expect({ design, height, framed: rows.every((line) => line[left] === "║" && line[right] === "║") }).toEqual({
        design,
        height,
        framed: true,
      })
      expect(rows.map((line) => line.slice(left, right + 1))).toContainEqual(
        `║ BUILDER  budget exhausted · attempt 3 · 0s`.padEnd(right - left, " ") + "║",
      )
      // Too tall for 40 rows: one activity line; at 80 rows the view fits and the Peek keeps more.
      const shown = rows.filter((line) => line.includes("activity line")).length
      expect({ design, height, shrunk: shown === 1 }).toEqual({ design, height, shrunk: height === 40 })
      app.renderer.destroy()
      dispose()
    }
  }
})

test("each full-screen design's row count is the rows it renders", async () => {
  const cases: ReadonlyArray<
    [
      number,
      number,
      (view: Awaited<ReturnType<typeof viewFor>>["view"]) => JSX.Element,
      (view: Awaited<ReturnType<typeof viewFor>>["view"]) => number,
    ]
  > = [
    [
      3,
      61,
      (view) => <BoardView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={61} />,
      (view) => boardRows(view, 61),
    ],
    [
      3,
      118,
      (view) => <BoardView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={118} />,
      (view) => boardRows(view, 118),
    ],
    [
      4,
      118,
      (view) => <MatrixView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={118} />,
      (view) => matrixRows(view, 118),
    ],
    [
      4,
      30,
      (view) => <MatrixView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={30} />,
      (view) => matrixRows(view, 30),
    ],
    [
      5,
      118,
      (view) => <GanttView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={118} />,
      (view) => ganttRows(view),
    ],
  ]
  for (const [design, width, node, count] of cases) {
    const { view, dispose } = await viewFor(base, { design })
    view.select("T1.4")
    await settle()
    const app = await render(() => node(view), 120, 100)
    const lines = linesOf(app.captureCharFrame())
    const used = lines.findLastIndex((line) => line.trim() !== "") + 1
    expect({ design, width, rows: count(view) }).toEqual({ design, width, rows: used })
    app.renderer.destroy()
    dispose()
  }
})

test("in the Ledger an outside wait line that wraps gets its rows, so the region shows S13 without a scroll", async () => {
  const { view, dispose } = await viewFor(statusOf(waitsOnT9), { design: 1 })
  view.setExpanded(true)
  await settle()
  const app = await render(
    () => <LedgerView theme={() => theme} view={view} sessions={none} leader="ctrl+x" width={38} />,
    120,
    80,
  )
  const box = regionBox(app)
  const text = inBox(app.captureCharFrame(), box)
  expect(text).toContain("S13 ")
  expect(text.replace(/\s+/g, " ")).toContain("waiting on T9 (outside) — run /task trust T9")
  app.renderer.destroy()
  dispose()
})

// --- scrolling ---------------------------------------------------------------------------------------------------------

test("the region is a scroll box: the mouse wheel scrolls it, and pageBy pages it", async () => {
  const { view } = await viewFor(base)
  let box: ScrollBoxRenderable | undefined
  const app = await render(
    () => <SharedRegion theme={() => theme} view={view} width={60} height={8} onScroll={(b) => (box = b)} />,
    60,
    20,
  )
  expect(box?.constructor.name).toBe("ScrollBoxRenderable")
  expect(box?.scrollTop).toBe(0)
  await app.mockMouse.scroll(4, 2, "down")
  await app.renderOnce()
  expect(box?.scrollTop ?? 0).toBeGreaterThan(0)
  const top = box?.scrollTop ?? 0
  pageBy(box, 1)
  expect(box?.scrollTop).toBe(top + 7)
  pageBy(box, -1)
  expect(box?.scrollTop).toBe(top)
  app.renderer.destroy()
})

// A context for registerScreen and registerTicker: the keymap layers they register, and the route or dialog they open.
function stubbed(view: Awaited<ReturnType<typeof viewFor>>["view"]) {
  const layers: Array<{
    commands: Array<{ name: string; run: () => unknown }>
    bindings: Array<{ key: string; cmd: string }>
  }> = []
  const routes: Array<{ render: () => JSX.Element }> = []
  const dialogs: Array<() => JSX.Element> = []
  const api = {
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
    ui: {
      toast: () => {},
      dialog: { replace: (render: () => JSX.Element) => void dialogs.push(render), setSize: () => {}, clear: () => {} },
    },
    attention: { notify: async () => {} },
  }
  const ctx: Ctx = {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (b) registerScreen and registerTicker read only the route, keymap, ui and attention members above
    api: api as unknown as TuiPluginApi,
    view,
    sessions: none,
    theme: () => theme,
    active: () => true,
    leader: "ctrl+x",
    root: () => "",
    owns: () => true,
    harness: () => [],
    logs: () => [],
  }
  // Runs the command a key is bound to in the newest layer that binds it.
  const press = (key: string) => {
    const layer = layers.findLast((item) => item.bindings.some((binding) => binding.key === key))
    const name = layer?.bindings.find((binding) => binding.key === key)?.cmd
    layer?.commands.find((command) => command.name === name)?.run()
  }
  return { ctx, routes, dialogs, press }
}

// Five stopped tasks (T1.4 dead, T1.2 failed, T1.3 cancelled, T1 and T1.5 blocked) and a run warning.
const tall = statusOf((raw) => {
  Object.assign(tasksOf(raw)["T1.2"], { state: "failed", tags: ["ended", "stopped", "dead"], reason: "merge conflict" })
  Object.assign(tasksOf(raw)["T1.3"], { state: "cancelled", tags: ["ended", "stopped"], reason: "user stop" })
  Object.assign(raw.run, { warning: WARNING })
})

test("pagedown and pageup scroll the region in the full-screen views and in the Ticker dialog", async () => {
  for (const [name, design] of [
    ["full screen", 3],
    ["Ticker dialog", 7],
  ] as const) {
    const { view, dispose } = await viewFor(tall, { design })
    view.setExpanded(true)
    await settle()
    const stub = stubbed(view)
    if (design === 3) registerScreen(stub.ctx)
    else registerTicker(stub.ctx)
    await settle()
    const page = design === 3 ? stub.routes[0]?.render : stub.dialogs[0]
    if (!page) throw new Error(`${name}: nothing opened`)
    // Content taller than the region: a warning and five stopped tasks.
    const app = await render(page, 120, 24)
    const before = app.captureCharFrame()
    stub.press("pagedown")
    await app.renderOnce()
    const after = app.captureCharFrame()
    expect({ name, moved: after !== before }).toEqual({ name, moved: true })
    stub.press("pageup")
    await app.renderOnce()
    expect({ name, back: app.captureCharFrame() === before }).toEqual({ name, back: true })
    app.renderer.destroy()
    dispose()
  }
})

// --- UI22: a short terminal --------------------------------------------------------------------------------------------

test("UI22 at 120 × 24, 13 scenarios and 5 stopped tasks: the region keeps 8 rows, the Peek shrinks first, pagedown reaches all", async () => {
  const status = statusOf((raw) => {
    Object.assign(tasksOf(raw)["T1.2"], {
      state: "failed",
      tags: ["ended", "stopped", "dead"],
      reason: "merge conflict",
    })
    Object.assign(tasksOf(raw)["T1.3"], { state: "cancelled", tags: ["ended", "stopped"], reason: "user stop" })
  })
  expect(stoppedLines(status).reduce((sum, line) => sum + line.ids.length, 0)).toBe(5)
  const activity = Array.from({ length: 8 }, (_, i) => ({
    glyph: "›",
    tone: "idle" as const,
    text: `activity line ${i + 1}`,
  }))
  const sessions: Sessions = {
    children: () => () => [{ id: "b", role: "builder", again: false, created: 1, updated: 1 }],
    activity: () => () => activity,
    all: () => () => [],
  }
  const shown = async (height: number) => {
    const { view, dispose } = await viewFor(status, { design: 3 })
    view.select("T1.4")
    await settle()
    let box: ScrollBoxRenderable | undefined
    const app = await render(
      () => (
        <Screen
          theme={() => theme}
          view={view}
          sessions={sessions}
          leader="ctrl+x"
          width={120}
          height={height}
          onScroll={(b) => (box = b)}
        />
      ),
      120,
      height,
    )
    return { app, view, dispose, box: () => box }
  }
  // At 80 rows everything fits: the Peek keeps its activity lines.
  const tall = await shown(80)
  const tallLines = linesOf(tall.app.captureCharFrame()).filter((line) => line.includes("activity line")).length
  tall.app.renderer.destroy()
  tall.dispose()
  const short = await shown(24)
  const frame = short.app.captureCharFrame()
  // The Peek's activity lines shrink to one; the region keeps at least 8 rows.
  expect(linesOf(frame).filter((line) => line.includes("activity line")).length).toBeLessThan(tallLines)
  expect(linesOf(frame).filter((line) => line.includes("activity line")).length).toBe(1)
  expect(short.box()?.height ?? 0).toBeGreaterThanOrEqual(8)
  // pagedown, page by page, reaches every STOPPED line and every scenario.
  // Only the region's own rows count: the Board's cards show the same ids.
  const region = short.box()
  if (!region) throw new Error("no shared region")
  const seen = [inBox(frame, region)]
  for (let page = 0; page < 10; page++) {
    pageBy(region, 1)
    await short.app.renderOnce()
    seen.push(inBox(short.app.captureCharFrame(), region))
  }
  const all = seen.join("\n")
  for (const text of [
    "⊘ T1.4",
    "✗ T1.2",
    "⊖ T1, T1.5",
    "– T1.3",
    ...Array.from({ length: 13 }, (_, i) => `S${i + 1} `),
  ])
    expect({ text, found: all.includes(text) }).toEqual({ text, found: true })
  // A click on a STOPPED line selects its first task.
  pageBy(short.box(), -1)
  for (let page = 0; page < 10; page++) pageBy(short.box(), -1)
  await short.app.renderOnce()
  const back = short.app.captureCharFrame()
  await short.app.mockMouse.pressDown(3, rowOf(back, "⊖ T1, T1.5"))
  await settle()
  expect(short.view.selected()).toBe("T1")
  short.app.renderer.destroy()
  short.dispose()
})
