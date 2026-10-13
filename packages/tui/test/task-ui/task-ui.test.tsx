/** @jsxImportSource @opentui/solid */
// The task-ui candidates against a real status file: the release-notes run that stopped at T1.4.c8 (paths replaced).
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Option, Result } from "effect"
import { createRoot, type JSX } from "solid-js"
import type { Part } from "@opencode-ai/sdk/v2"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import fixture from "./fixture-status.json"
import { Peek, lines, type Sessions } from "../../src/task-ui/peek"
import { counts, createView, focus, obligationsOf, parse, rows, type Status } from "../../src/task-ui/store"
import { LedgerView } from "../../src/task-ui/designs/1-ledger"
import { DockView } from "../../src/task-ui/designs/2-dock"
import { BoardView } from "../../src/task-ui/designs/3-board"
import { MatrixView } from "../../src/task-ui/designs/4-matrix"
import { GanttView, lane, span } from "../../src/task-ui/designs/5-gantt"
import { HudView } from "../../src/task-ui/designs/6-hud"
import { TickerDialog, changes } from "../../src/task-ui/designs/7-ticker"
import { ShortcutBar } from "../../src/task-ui/ui"

const status = Option.getOrThrow(parse(JSON.stringify(fixture)))
const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [] }

const view = (sessions: Sessions = none, input: Status = status, design = 1) =>
  createRoot(() => ({ theme: () => theme, sessions, leader: "ctrl+x", view: createView({ status: () => input, now: () => 0, design }) }))

async function frame(node: () => JSX.Element, width = 120, height = 40) {
  const app = await testRender(node, { width, height })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

test("parses the harness status file and refuses anything else", () => {
  expect(status.run.state).toBe("budget_exhausted")
  expect(Option.isNone(parse("{"))).toBe(true)
  expect(Option.isNone(parse(JSON.stringify({ run: {} })))).toBe(true)
  expect(Option.isNone(parse(""))).toBe(true)
})

test("orders the tasks as a tree and finds each task's own obligations", () => {
  expect(rows(status).map((row) => `${row.id}:${row.depth}:${row.last}`)).toEqual([
    "T1:0:true",
    "T1.1:1:false",
    "T1.2:1:false",
    "T1.3:1:false",
    "T1.4:1:false",
    "T1.5:1:true",
  ])
  expect(obligationsOf(status, "T1").map((item) => item.id)).toEqual(["T1.e1"])
  expect(obligationsOf(status, "T1.4").map((item) => item.local)).toEqual(
    ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "f1", "f2", "p1"],
  )
  expect(counts(status)).toEqual({ total: 6, trusted: 3, active: 0, stopped: 1 })
  expect(focus(rows(status))).toBe("T1.4")
})

test("moves the selection round the tree and cycles the designs", () => {
  createRoot((dispose) => {
    const state = createView({ status: () => status, now: () => 0, design: 7 })
    expect(state.selected()).toBe("T1.4")
    state.next()
    state.next()
    expect(state.selected()).toBe("T1")
    state.previous()
    expect(state.selected()).toBe("T1.5")
    state.cycleDesign()
    expect(state.design()).toBe(1)
    dispose()
  })
})

test("draws a lane from the history and ends it in the final state", () => {
  const range = span(status, Date.now())
  const runs = lane(status, "T1.4", 100, range)
  expect(runs[0].state).toBe("waiting")
  expect(runs.some((run) => run.state === "building")).toBe(true)
  expect(runs.at(-1)?.state).toBe("budget_exhausted")
})

test("reports the run and task changes between two snapshots", () => {
  const before = structuredClone(fixture)
  before.run.state = "running"
  before.tasks["T1.4"].state = "proving"
  expect(changes(Option.getOrThrow(parse(JSON.stringify(before))), status)).toEqual([
    { unit: "run", from: "running", to: "budget_exhausted" },
    { unit: "T1.4", from: "proving", to: "budget_exhausted" },
  ])
})

test("turns harness tool calls into peek lines", () => {
  const tool = (name: string, input: Record<string, unknown>, title = ""): Part => ({
    id: "part",
    sessionID: "session",
    messageID: "message",
    callID: "call",
    type: "tool",
    tool: name,
    state: { status: "completed", input, title, output: "", metadata: {}, time: { start: 0, end: 0 } },
  })
  expect(
    lines(tool("verdict", { verdicts: [{ id: "T1.1.c1", verdict: "trusted" }, { id: "T1.1.c2", verdict: "rejected", reason: "weak" }] })),
  ).toEqual([
    { glyph: "✓", tone: "good", text: "T1.1.c1 trusted" },
    { glyph: "✗", tone: "bad", text: "T1.1.c2 rejected — weak" },
  ])
  expect(lines(tool("task_ready", { summary: "done" }))[0].text).toBe("task_ready: done")
  expect(lines(tool("bash", { command: "bun test" }, "bun test"))[0].text).toBe("bash bun test")
})

test("every design shows the stopped run", async () => {
  const props = view()
  const ledger = await frame(() => <LedgerView {...props} width={38} />)
  expect(ledger).toContain("◆ HARNESS run: budget exhausted")
  expect(ledger).toContain("├ ⊘ T1.4")
  expect(ledger).toContain("└ ○ T1.5")
  expect(await frame(() => <DockView {...props} width={160} />, 160)).toContain("▰▰▰▱▱▱ 3/6 trusted")
  const board = await frame(() => <BoardView {...props} width={110} />)
  expect(board).toContain("STOPPED 1")
  expect(board).toContain("TRUSTED 3")
  const matrix = await frame(() => <MatrixView {...props} width={110} />)
  expect(matrix).toContain("SCENARIOS")
  expect(matrix).toContain("✗ T1.4.c8 failed")
  expect(await frame(() => <GanttView {...props} width={110} />)).toContain("budget exhausted · attempt 3")
  expect(await frame(() => <HudView {...props} />)).toContain("▸ ⊘ T1.4 budget exhausted · attempt 3")
  expect(await frame(() => <TickerDialog {...props} />)).toContain("◆ HARNESS · T1.4 details · read-only")
})

test("the peek shows the builder, the failed proof first, and the verifier", async () => {
  const sessions: Sessions = {
    children: () => () => [
      { id: "b", role: "builder", again: false, created: 1 },
      { id: "v", role: "verifier", again: true, created: 2 },
    ],
    activity: (id) => () =>
      id === "b"
        ? [{ glyph: "◆", tone: "pass", text: "task_ready: shebang test added" }]
        : [{ glyph: "✓", tone: "good", text: "T1.4.c1 trusted" }],
  }
  const props = view(sessions)
  const peek = await frame(() => <Peek {...props} unit="T1.4" width={70} lines={3} />)
  expect(peek).toContain("◆ HARNESS · T1.4 details · read-only")
  expect(peek).toContain("BUILDER  attempt 3 · budget exhausted")
  expect(peek).toContain("✗ c8 failed")
  expect(peek).toContain("VERIFIER second try")
  expect(peek).toContain("✓ T1.4.c1 trusted")
  // At sidebar width the short title must still fit, and still say read-only.
  expect(await frame(() => <Peek {...props} unit="T1.4" width={38} lines={3} />)).toContain(
    "◆ T1.4 details · read-only",
  )
})

test("the shortcut bar names the design, its keys, and drops keys before it overflows", async () => {
  const ledger = view()
  const wide = await frame(() => <ShortcutBar {...ledger} width={200} />, 200, 3)
  expect(wide).toContain("◆ HARNESS Ledger")
  expect(wide).toContain("ctrl+x o expand")
  expect(wide).toContain("/task-design switch")
  expect(wide).toContain("ctrl+x j/k select task")
  expect(wide).not.toContain("trusted")
  const narrow = await frame(() => <ShortcutBar {...ledger} width={100} />, 100, 3)
  expect(narrow).toContain("ctrl+x o expand")
  expect(narrow).not.toContain("select task")
  const ticker = view(none, status, 7)
  const line = await frame(() => <ShortcutBar {...ticker} width={200} />, 200, 3)
  expect(line).toContain("◆ HARNESS Ticker  3/6 trusted  ⊘ T1.4 budget exhausted  ctrl+x o expand")
  ticker.view.toggleExpanded()
  expect(await frame(() => <ShortcutBar {...ticker} width={200} />, 200, 3)).toContain("ctrl+x o collapse")
})
