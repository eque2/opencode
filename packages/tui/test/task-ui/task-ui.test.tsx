/** @jsxImportSource @opentui/solid */
// The task-ui designs, store and watch view against the shared projected status of the observed release-notes run
// (T1.4 budget exhausted, T1.5 and T1 blocked by it). plugin.test.tsx loads the plugin entry itself.
//
// T4.2 moved these tests from fixture-status.json (a file from before the AD-13 tags) to fixture-projected.json (SD-10):
// - ported (the same assertion on the projected status): the tree rows and T1.4's obligations, the selection and the
//   design cycle, the peek lines of tool calls, the proof-log path, every watch-view choice (`live` now restates the
//   projected status with tags), the stopper, the plugin's ctrl+x w, esc twice and Tab tests.
// - re-baselined: "parses…" (the run is running), the counts {6,3,0,1} → {6,3,0,3} (T1 and T1.5 are blocked, so
//   stopped), "reports the run and task changes…" (from the projected status to its ended copy), "every design shows
//   the stopped run" (the ended copy: ⊖ T1.5, STOPPED 3, c7 failed), RM26 (blocked is ⊖ from the display table, not
//   the fallback •), the peek (c7 is the failed proof), the shortcut bar, "a run is active…" and "after the run
//   ends…" (an ended copy, where the old fixture had ended).
// - kept on the older file: SV17's decode of a pre-contract file, UI25, and the Gantt lane from the history (T4.7
//   moves it to the spans).
// - retired: none.
import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { Option, Result } from "effect"
import { createRoot, createSignal, type JSX } from "solid-js"
import { createOpencodeClient, type Part } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { TuiKeybind } from "../../src/config/keybind"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { json } from "../fixture/tui-sdk"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import fixture from "./fixture-status.json"
import projected from "./fixture-projected.json"
import { Peek, builderHeading, harnessOf, liveSessions, lines, type Sessions } from "../../src/task-ui/peek"
import { waitSentences, wrap } from "../../src/task-ui/shared"
import type { CapturedFrame, RGBA } from "@opentui/core"
import {
  DISPLAY,
  ENDED,
  OLDER_LINE,
  bySeverity,
  columnOf,
  counts,
  durationOf,
  elapsed,
  focus,
  glyph,
  label,
  obligationsOf,
  older,
  parse,
  rows,
  stoppedGroup,
  tone,
  type Status,
} from "../../src/task-ui/store"
import { TaskView } from "../../src/task-ui/machine"
import { LedgerView } from "../../src/task-ui/designs/1-ledger"
import { DockView } from "../../src/task-ui/designs/2-dock"
import { BoardView } from "../../src/task-ui/designs/3-board"
import { MatrixView } from "../../src/task-ui/designs/4-matrix"
import { GanttView, lane, span } from "../../src/task-ui/designs/5-gantt"
import { HudView } from "../../src/task-ui/designs/6-hud"
import { TickerDialog, changes } from "../../src/task-ui/designs/7-ticker"
import { ShortcutBar, registerTab, type Ctx } from "../../src/task-ui/ui"
import { nextRunning, proofLogFile, runActive, waitsOn } from "../../src/task-ui/store"
import {
  ProofPanel,
  RECENT_PROOF,
  WatchBand,
  bandText,
  chooseWatch,
  liveTail,
  proofTail,
  recentProof,
  registerWatch,
} from "../../src/task-ui/watch"
import * as Store from "../../src/task-ui/store"
import { settle, viewFor } from "./view"
import type { Child, Harness } from "../../src/task-ui/peek"

// The base status is the shared projected fixture (T1.1–T1.3 trusted, T1.4 budget exhausted, T1.5 and T1 blocked by
// it, the run still running), which carries the AD-13 tags; fixture-status.json stays only as a status file written
// before the contract (SV17, UI25).
const status = Option.getOrThrow(parse(JSON.stringify(projected)))

// The tags the harness gives each task state (the AD-13 class table).
const TAGS: Record<string, ReadonlyArray<string>> = {
  waiting: ["waiting"],
  building: ["active"],
  proving: ["active"],
  verifying: ["active"],
  trusted: ["ended"],
  budget_exhausted: ["ended", "stopped", "dead"],
  blocked: ["ended", "stopped", "blocked"],
}

// The projected status with the run and the given tasks restated, each task with its state's tags.
const restate = (
  run: { state: string; tags: ReadonlyArray<string> },
  states: Record<string, string>,
  waits: Record<string, ReadonlyArray<string>> = {},
) => {
  const copy = structuredClone(projected)
  copy.run.state = run.state
  copy.run.tags = [...run.tags]
  const tasks: Record<string, { state: string; tags: string[]; waitingOn: string[] }> = copy.tasks
  for (const [id, state] of Object.entries(states)) Object.assign(tasks[id], { state, tags: [...(TAGS[state] ?? [])] })
  for (const [id, ids] of Object.entries(waits)) tasks[id].waitingOn = [...ids]
  return Option.getOrThrow(parse(JSON.stringify(copy)))
}

// The run ended as the observed run did, budget exhausted.
const ended = restate({ state: "budget_exhausted", tags: ["ended", "stopped"] }, {})
const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }

// The design props over a real view actor that holds `input` (see ./view.ts).
const view = async (sessions: Sessions = none, input: Status = status, design = 1) => ({
  theme: () => theme,
  sessions,
  leader: "ctrl+x",
  view: (await viewFor(input, { design })).view,
})

// The first line of a captured frame that holds `text`, without the frame's padding.
const lineWith = (captured: string, text: string) =>
  captured
    .split("\n")
    .find((line) => line.includes(text))
    ?.trim()

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
  expect(status.run.state).toBe("running")
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
  // The tags class the tasks: T1.4 dead, T1 and T1.5 blocked, all three stopped; the most severe is focused.
  expect(counts(status)).toEqual({ total: 6, trusted: 3, active: 0, stopped: 3 })
  expect(focus(rows(status))).toBe("T1.4")
})

test("moves the selection round the tree and cycles the designs", async () => {
  const { view: state, dispose } = await viewFor(status, { design: 7 })
  expect(state.selected()).toBe("T1.4")
  state.next()
  await settle()
  state.next()
  await settle()
  expect(state.selected()).toBe("T1")
  state.previous()
  await settle()
  expect(state.selected()).toBe("T1.5")
  state.cycleDesign()
  await settle()
  expect(state.design()).toBe(1)
  dispose()
})

// The Gantt draws its lane from the history until T4.7 moves it to the spans: the older file has that history.
test("draws a lane from the history and ends it in the final state", () => {
  const older = Option.getOrThrow(parse(JSON.stringify(fixture)))
  const range = span(older, Date.now())
  const runs = lane(older, "T1.4", 100, range)
  expect(runs[0].state).toBe("waiting")
  expect(runs.some((run) => run.state === "building")).toBe(true)
  expect(runs.at(-1)?.state).toBe("budget_exhausted")
})

test("reports the run and task changes between two snapshots", () => {
  const before = structuredClone(projected)
  before.tasks["T1.4"].state = "proving"
  expect(changes(Option.getOrThrow(parse(JSON.stringify(before))), ended)).toEqual([
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
  const props = await view(none, ended)
  const ledger = await frame(() => <LedgerView {...props} width={38} />)
  expect(ledger).toContain("◆ In the Flow run: budget exhausted")
  expect(ledger).toContain("├ ⊘ T1.4")
  expect(ledger).toContain("└ ⊖ T1.5")
  expect(await frame(() => <DockView {...props} width={160} />, 160)).toContain("▰▰▰▱▱▱ 3/6 trusted")
  const board = await frame(() => <BoardView {...props} width={110} />)
  expect(board).toContain("STOPPED 3")
  expect(board).toContain("TRUSTED 3")
  const matrix = await frame(() => <MatrixView {...props} width={110} />)
  expect(matrix).toContain("SCENARIOS")
  expect(matrix).toContain("✗ T1.4.c7 failed")
  expect(await frame(() => <GanttView {...props} width={110} />)).toContain("budget exhausted · attempt 3")
  expect(await frame(() => <HudView {...props} />)).toContain("▸ ⊘ T1.4 budget exhausted · attempt 3")
  expect(await frame(() => <TickerDialog {...props} />)).toContain("◆ In the Flow · T1.4 details · read-only")
})

// SV17: the harness projection writes the shared fixture (packages/opencode test/task/status-fixture.test.ts), and the
// TUI schema decodes it, as it still decodes a status file written before the AD-13 contract.
test("SV17 decodes the shared projected status and a status file from before the contract", () => {
  const decoded = Option.getOrThrow(parse(JSON.stringify(projected)))
  expect(decoded.run.state).toBe("running")
  expect(decoded.tasks["T1.5"]).toMatchObject({ state: "blocked", reason: "blocked by T1.4: budget exhausted" })
  expect(Object.keys(decoded.scenarios)).toContain("S13")
  expect(Option.isSome(parse(JSON.stringify(fixture)))).toBe(true)
})

// RM26: the harness writes the status of the observed run (T1.4 budget exhausted, T1.5 and T1 blocked by it); the
// task-ui decodes the new state as an open string and draws it in the fallback column.
test("RM26 the Board shows the blocked tasks of the projected status in STOPPED with their cause", async () => {
  const input = Option.getOrThrow(parse(JSON.stringify(projected)))
  const props = await view(none, input)
  const board = await frame(() => <BoardView {...props} width={110} />, 110, 40)
  expect(board).toContain("WAITING 0")
  expect(board).toContain("STOPPED 3")
  // Both blocked cards: the display table's ⊖ (no longer the fallback •), the label, and the reason across the lines.
  expect(board).toContain("⊖ T1.5")
  expect(board).toMatch(/⊖ T1 /)
  expect(board.match(/│ blocked {2,}│/g)).toHaveLength(2)
  expect(board.match(/│ blocked by {2,}│/g)).toHaveLength(2)
  expect(board.match(/│ T1\.4: budget {2,}│/g)).toHaveLength(2)
  expect(board.match(/│ exhausted {2,}│/g)).toHaveLength(2)
})

// --- the store on the AD-13 status (T4.2) ---------------------------------------------------------------------------

test("decodes the AD-13 fields as optional and keeps an unknown tag that nothing reads", () => {
  expect(status.run).toMatchObject({
    tags: ["active"],
    title: "Release notes from conventional commits",
    specId: "release-notes.spec",
    startedAt: 1,
    aliveAt: 1791000000000,
  })
  expect(status.tasks["T1.4"]).toMatchObject({ tags: ["ended", "stopped", "dead"], startedAt: 14, endedAt: 20 })
  expect(status.tasks["T1.4"].spans?.length).toBeGreaterThan(0)
  expect(status.scenarios["S2"].title).toBe("A conventional message is read into its parts")
  expect(status.outside?.["T9"]).toEqual({ state: "untrusted", tags: ["waiting"] })
  expect(status.external).toEqual({})
  // A tag the task-ui does not know changes no classification, on the run or on a task.
  const copy = structuredClone(projected)
  copy.run.tags = ["active", "comet"]
  Object.assign(copy.tasks["T1.2"], { state: "building", tags: ["active", "comet"] })
  const strange = Option.getOrThrow(parse(JSON.stringify(copy)))
  expect(strange.tasks["T1.2"].tags).toEqual(["active", "comet"])
  expect(columnOf(strange.tasks["T1.2"])).toEqual(Option.some("BUILDING"))
  expect(counts(strange)).toEqual({ total: 6, trusted: 2, active: 1, stopped: 3 })
  expect(runActive(strange)).toBe(true)
  expect(older(status)).toBe(false)
  // The run fields the fixture leaves out decode when present: a subtree's task, the warning, the end time.
  const full = structuredClone(projected)
  Object.assign(full.run, {
    task: { id: "T1.2", title: "Compute the next version" },
    warning: "R3 T1-release-notes.task/T1.1-commit-parser.task/VERIFY.md: obligation T1.1.c9 is not in the loaded plan",
    endedAt: 99,
  })
  expect(Option.getOrThrow(parse(JSON.stringify(full))).run).toMatchObject({
    task: { id: "T1.2", title: "Compute the next version" },
    warning: "R3 T1-release-notes.task/T1.1-commit-parser.task/VERIFY.md: obligation T1.1.c9 is not in the loaded plan",
    endedAt: 99,
  })
})

test("classifies from the tags, not the state names: column, counts, focus, next running and severity", () => {
  // T1.1's state says building, its tags say ended: the tags win everywhere.
  const copy = structuredClone(projected)
  Object.assign(copy.tasks["T1.1"], { state: "building", tags: ["ended"] })
  Object.assign(copy.tasks["T1.2"], { state: "proving", tags: ["active"] })
  const mixed = Option.getOrThrow(parse(JSON.stringify(copy)))
  expect(columnOf(mixed.tasks["T1.1"])).toEqual(Option.some("TRUSTED"))
  expect(columnOf(mixed.tasks["T1.2"])).toEqual(Option.some("PROVING"))
  expect(columnOf(live({ "T1.3": "building" }).tasks["T1.3"])).toEqual(Option.some("BUILDING"))
  expect(columnOf(live({}).tasks["T1.5"])).toEqual(Option.some("WAITING"))
  expect(columnOf(mixed.tasks["T1.4"])).toEqual(Option.some("STOPPED"))
  expect(counts(mixed)).toEqual({ total: 6, trusted: 2, active: 1, stopped: 3 })
  expect(focus(rows(mixed))).toBe("T1.2")
  expect(nextRunning(rows(mixed), "T1.1", 1)).toEqual(Option.some("T1.2"))
  // T1.2 is the only task the tags put in work (T1.1's state still says building): there is no other to step to.
  expect(nextRunning(rows(mixed), "T1.2", 1)).toEqual(Option.none())
  // STOPPED groups: dead, then blocked, then the rest; the severity order of AD-16.
  expect(
    [status.tasks["T1.4"], status.tasks["T1.5"], { state: "cancelled", tags: ["ended", "stopped"] }].map((task) =>
      stoppedGroup({ attempts: 0, waitingOn: [], ...task }),
    ),
  ).toEqual([0, 1, 2])
  const units = ["ended", "waiting", "active", "stopped", "blocked", "dead"].map((tag) => ({ tag, tags: [tag] }))
  expect(units.toSorted(bySeverity).map((unit) => unit.tag)).toEqual([
    "dead",
    "blocked",
    "stopped",
    "active",
    "waiting",
    "ended",
  ])
})

test("the display table gives each state its glyph, tone and Gantt block", () => {
  expect(DISPLAY["blocked"]).toEqual({ glyph: "⊖", tone: "warn", block: "█" })
  expect([glyph("blocked"), tone("blocked")]).toEqual(["⊖", "warn"])
  // `stalled` names no state now, and stays for an older file.
  expect(DISPLAY["stalled"]).toEqual({ glyph: "‼", tone: "warn", block: "█" })
  expect(DISPLAY["building"]).toEqual({ glyph: "◐", tone: "active", block: "▓", column: "BUILDING" })
  expect(glyph("a-state-from-later")).toBe("•")
})

test("durations: 45s, 3m 12s, 1h 4m; live to now, still to the heartbeat, fixed from endedAt, blank unstarted", () => {
  expect([elapsed(45_000), elapsed(192_000), elapsed(3_840_000)]).toEqual(["45s", "3m 12s", "1h 4m"])
  const run = { aliveAt: 100_000 }
  expect(durationOf({ startedAt: 10_000 }, run, "live", 55_000)).toBe("45s")
  expect(durationOf({ startedAt: 10_000 }, run, "still", 55_000)).toBe("1m 30s")
  expect(durationOf({ startedAt: 10_000, endedAt: 202_000 }, run, "live", 999_000)).toBe("3m 12s")
  expect(durationOf({}, run, "live", 55_000)).toBe("")
  // Still with no heartbeat (a file from before it): nothing to stop at.
  expect(durationOf({ startedAt: 10_000 }, {}, "still", 55_000)).toBe("")
})

test("poll, LIVE_WINDOW, ACTIVE and the view signals have left the store; ENDED waits for the Gantt and the Ticker", () => {
  for (const gone of ["poll", "LIVE_WINDOW", "ACTIVE", "createView"]) expect(Store).not.toHaveProperty(gone)
  expect(ENDED).toContain("done")
})

test("UI25 a status with no tags: still, the older-harness line, display glyphs and labels, and no classes", () => {
  const legacy = Option.getOrThrow(parse(JSON.stringify(fixture)))
  expect(older(legacy)).toBe(true)
  expect(OLDER_LINE).toBe("status from an older harness — type /task to refresh")
  expect(TaskView.livenessOf({ status: Option.some(legacy), now: Date.now() })).toBe("still")
  expect([glyph(legacy.tasks["T1.4"].state), label(legacy.tasks["T1.4"].state)]).toEqual(["⊘", "budget exhausted"])
  expect(Object.values(legacy.tasks).map(columnOf)).toEqual(Object.values(legacy.tasks).map(() => Option.none()))
  expect(counts(legacy)).toEqual({ total: 6, trusted: 0, active: 0, stopped: 0 })
  expect(focus(rows(legacy))).toBe("T1")
})

test("the peek shows the builder, the failed proof first, and the verifier", async () => {
  const sessions: Sessions = {
    children: () => () => [
      { id: "b", role: "builder", again: false, created: 1, updated: 1 },
      { id: "v", role: "verifier", again: true, created: 2, updated: 2 },
    ],
    activity: (id) => () =>
      id === "b"
        ? [{ glyph: "◆", tone: "pass", text: "task_ready: shebang test added" }]
        : [{ glyph: "✓", tone: "good", text: "T1.4.c1 trusted" }],
    all: () => () => [],
  }
  const props = await view(sessions)
  const peek = await frame(() => <Peek {...props} unit="T1.4" width={70} lines={3} />)
  expect(peek).toContain("◆ In the Flow · T1.4 details · read-only")
  // T4.5 re-baselined the heading from "attempt 3 · budget exhausted": the state, the attempt, then the duration.
  expect(peek).toContain("BUILDER  budget exhausted · attempt 3 · 0s")
  expect(peek).toContain("✗ c7 failed")
  expect(peek).toContain("VERIFIER second try")
  expect(peek).toContain("✓ T1.4.c1 trusted")
  // At sidebar width the short title must still fit, and still say read-only.
  expect(await frame(() => <Peek {...props} unit="T1.4" width={38} lines={3} />)).toContain(
    "◆ T1.4 details · read-only",
  )
})

// --- the Peek BUILDER heading (T4.5: EXPERIENCE "Peek BUILDER heading", D19, D21) -----------------------------------

type RawTasks = Record<string, Record<string, unknown>>

// The projected status with `change` applied to a copy of its raw form.
const changed = (change: (raw: typeof projected & { external?: unknown }) => void) => {
  const raw = structuredClone(projected)
  change(raw)
  return Option.getOrThrow(parse(JSON.stringify(raw)))
}
const tasksIn = (raw: typeof projected): RawTasks => raw.tasks

// T1.4 started at 0 and ended 6m 40s later.
const exhausted = changed((raw) => Object.assign(tasksIn(raw)["T1.4"], { startedAt: 0, endedAt: 400_000 }))

// T1.5 waits on two plan tasks, the untrusted outside T9 and T2.1, a task of the spec outside this run.
const waitingT15 = changed((raw) => {
  Object.assign(tasksIn(raw)["T1.5"], {
    state: "waiting",
    tags: ["waiting"],
    waitingOn: ["T1.3", "T1.4", "T9", "T2.1"],
    waitingOnOutside: ["T9"],
    reason: null,
  })
  Object.assign(raw, { external: { "T2.1": { state: "waiting", tags: ["waiting"] } } })
})

async function spansOf(node: () => JSX.Element, width = 120, height = 40) {
  const app = await testRender(node, { width, height })
  try {
    await app.renderOnce()
    return { text: app.captureCharFrame(), spans: app.captureSpans() }
  } finally {
    app.renderer.destroy()
  }
}

// The colour of the first span that holds `text`.
const fgOf = (captured: CapturedFrame, text: string) =>
  captured.lines.flatMap((line) => line.spans).find((span) => span.text.includes(text))?.fg
const rgb = (value: RGBA | undefined) => (value ? [value.r, value.g, value.b] : [])

// The frame's lines, without the Peek's border and padding.
const inside = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/^\s*║ ?/, "").replace(/ *║\s*$/, ""))

test("T4.5 a task with a reason and without blocked: line 1 is state · attempt · duration, the reason under it", async () => {
  expect(builderHeading(exhausted, "T1.4", "ended", 0)).toEqual([
    { text: "budget exhausted · attempt 3 · 6m 40s", tone: "text" },
    { text: "T1.4.c7: the test asserts only that 'topic change' appears", tone: "bad" },
  ])
  const props = await view(none, exhausted)
  const shown = await spansOf(() => <Peek {...props} unit="T1.4" width={60} lines={3} />)
  const lines = inside(shown.text)
  const at = lines.findIndex((line) => line.startsWith("BUILDER  budget exhausted · attempt 3 · 6m 40s"))
  expect(at).toBeGreaterThan(0)
  // The reason continues under the heading text, 9 cells in, in the error tone with the dead tag.
  expect(lines[at + 1]).toBe("         T1.4.c7: the test asserts only that 'topic")
  expect(lines[at + 2]).toBe("         change' appears")
  expect(rgb(fgOf(shown.spans, "T1.4.c7:"))).toEqual(rgb(theme.error))
  expect(rgb(fgOf(shown.spans, "budget exhausted · attempt 3"))).toEqual(rgb(theme.text))
  // Without the dead tag the reason is muted; with no attempt the line is the state and the duration.
  const human = changed((raw) =>
    Object.assign(tasksIn(raw)["T1.4"], { state: "needs_human", tags: ["ended", "stopped"], attempts: 0, startedAt: 0, endedAt: 45_000 }),
  )
  expect(builderHeading(human, "T1.4", "ended", 0)).toEqual([
    { text: "needs human · 45s", tone: "text" },
    { text: "T1.4.c7: the test asserts only that 'topic change' appears", tone: "muted" },
  ])
  const humanProps = await view(none, human)
  const muted = await spansOf(() => <Peek {...humanProps} unit="T1.4" width={60} lines={3} />)
  expect(muted.text).toContain("BUILDER  needs human · 45s")
})

test("T4.5 any other task: line 1 only; a running task's duration counts to now while the view is live", async () => {
  const building = changed((raw) =>
    Object.assign(tasksIn(raw)["T1.4"], {
      state: "building",
      tags: ["active"],
      reason: null,
      startedAt: raw.run.aliveAt - 192_000,
      endedAt: undefined,
    }),
  )
  expect(builderHeading(building, "T1.4", "live", (building.run.aliveAt ?? 0))).toEqual([
    { text: "building · attempt 3 · 3m 12s", tone: "text" },
  ])
  // The view is live (its now is the heartbeat): the Peek shows the same count.
  const props = await view(none, building)
  const lines = inside(await frame(() => <Peek {...props} unit="T1.4" width={60} lines={3} />))
  const at = lines.findIndex((line) => line.startsWith("BUILDER  building · attempt 3 · 3m 12s"))
  expect(at).toBeGreaterThan(0)
  expect(lines[at + 1]).toBe("  no builder session yet")
  // Ten seconds after the heartbeat the view is still live and counts to its now; a minute after, the view is still
  // and the count stops at the heartbeat.
  for (const [after, shown] of [
    [10_000, "BUILDER  building · attempt 3 · 3m 22s"],
    [60_000, "BUILDER  building · attempt 3 · 3m 12s"],
  ] as const) {
    const { view: clocked } = await viewFor(building, { now: (building.run.aliveAt ?? 0) + after })
    const clockedLines = inside(await frame(() => <Peek theme={() => theme} view={clocked} sessions={none} unit="T1.4" width={60} lines={3} />))
    expect(clockedLines).toContain(shown)
  }
  // A task with no start and no attempt: the state alone.
  expect(builderHeading(status, "T1.1", "ended", 0)[0]?.text).toBe("trusted · attempt 1 · 0s")
  expect(builderHeading(changed((raw) => Object.assign(tasksIn(raw)["T1.1"], { attempts: 0, startedAt: undefined })), "T1.1", "ended", 0)).toEqual([
    { text: "trusted", tone: "text" },
  ])
})

test("T4.5 a blocked task: line 1 starts its reason in the warning tone", async () => {
  expect(builderHeading(status, "T1.5", "live", 0)).toEqual([{ text: "blocked by T1.4: budget exhausted", tone: "warning" }])
  const props = await view(none, status)
  const shown = await spansOf(() => <Peek {...props} unit="T1.5" width={60} lines={3} />)
  expect(inside(shown.text)).toContain("BUILDER  blocked by T1.4: budget exhausted")
  expect(rgb(fgOf(shown.spans, "blocked by T1.4"))).toEqual(rgb(theme.warning))
  // A blocked task that ran before: its attempt and duration follow the reason, in the text tone.
  const ran = changed((raw) => Object.assign(tasksIn(raw)["T1.5"], { attempts: 2, startedAt: 0, endedAt: 45_000 }))
  expect(builderHeading(ran, "T1.5", "ended", 0)).toEqual([
    { text: "blocked by T1.4: budget exhausted", tone: "warning" },
    { text: "attempt 2 · 45s", tone: "text" },
  ])
  const ranProps = await view(none, ran)
  const ranLines = inside(await frame(() => <Peek {...ranProps} unit="T1.5" width={60} lines={3} />))
  const at = ranLines.indexOf("BUILDER  blocked by T1.4: budget exhausted")
  expect(ranLines[at + 1]).toBe("         attempt 2 · 45s")
})

test("T4.5 a waiting task: the wait sentences, plan ids first, in their tones; the trust command is never cut", async () => {
  expect(waitSentences(waitingT15, waitingT15.tasks["T1.5"])).toEqual([
    { text: "waiting on T1.3, T1.4", tone: "muted" },
    { text: "waiting on T9 (outside) — run /task trust T9", tone: "warning" },
    { text: "waiting on T2.1 (not in this run)", tone: "muted" },
  ])
  expect(builderHeading(waitingT15, "T1.5", "live", 0)).toEqual(waitSentences(waitingT15, waitingT15.tasks["T1.5"]))
  // T9 trusted: no trust sentence for it.
  const trusted = changed((raw) => {
    Object.assign(tasksIn(raw)["T1.5"], { state: "waiting", tags: ["waiting"], waitingOn: ["T9"], waitingOnOutside: ["T9"] })
    Object.assign(raw, { outside: { ...raw.outside, T9: { state: "trusted", tags: ["ended"] } } })
  })
  expect(waitSentences(trusted, trusted.tasks["T1.5"])).toEqual([])
  const props = await view(none, waitingT15)
  const shown = await spansOf(() => <Peek {...props} unit="T1.5" width={44} lines={3} />)
  const lines = inside(shown.text)
  const at = lines.findIndex((line) => line.startsWith("BUILDER  waiting on T1.3, T1.4"))
  expect(at).toBeGreaterThan(0)
  // The outside sentence wraps at a word boundary, 9 cells in; "/task trust T9" stays whole on one line.
  expect(lines[at + 1]).toBe("         waiting on T9 (outside) — run")
  expect(lines[at + 2]).toBe("         /task trust T9")
  // The external sentence (33 cells) wraps in the 31 cells the heading text has.
  expect(lines[at + 3]).toBe("         waiting on T2.1 (not in this")
  expect(lines[at + 4]).toBe("         run)")
  expect(rgb(fgOf(shown.spans, "waiting on T1.3"))).toEqual(rgb(theme.textMuted))
  expect(rgb(fgOf(shown.spans, "waiting on T9"))).toEqual(rgb(theme.warning))
  expect(rgb(fgOf(shown.spans, "/task trust T9"))).toEqual(rgb(theme.warning))
  expect(rgb(fgOf(shown.spans, "waiting on T2.1"))).toEqual(rgb(theme.textMuted))
})

test("T4.5 a long reason wraps at word boundaries with a 9-cell hanging indent and no line limit; activity lines shrink first", async () => {
  const words = Array.from({ length: 40 }, (_, i) => `word${i + 1}`)
  const long = changed((raw) => Object.assign(tasksIn(raw)["T1.4"], { reason: words.join(" ") }))
  const activity = Array.from({ length: 5 }, (_, i) => ({ glyph: "›", tone: "idle" as const, text: `step ${i + 1}` }))
  const sessions: Sessions = {
    children: () => () => [{ id: "b", role: "builder", again: false, created: 1, updated: 1 }],
    activity: () => () => activity,
    all: () => () => [],
  }
  const longProps = await view(sessions, long)
  const lines = inside(await frame(() => <Peek {...longProps} unit="T1.4" width={50} lines={5} />, 120, 60))
  const at = lines.findIndex((line) => line.startsWith("BUILDER  budget exhausted"))
  const under = lines.slice(at + 1).filter((line) => /^ {9}\S/.test(line))
  // Every word is there, in order, and no line is cut.
  expect(under.join(" ").trim().split(/\s+/)).toEqual(words)
  expect(under.length).toBeGreaterThan(5)
  expect(under.every((line) => line.length <= 46 && !line.includes("…"))).toBe(true)
  // The builder's five activity lines shrink to one before the heading is cut.
  expect(lines.filter((line) => line.includes("› step")).map((line) => line.trim())).toEqual(["› step 5"])
  // A reason of 1 line takes 1 activity line: 4 of 5 show.
  const short = changed((raw) => Object.assign(tasksIn(raw)["T1.4"], { reason: "exit 1" }))
  const shortProps = await view(sessions, short)
  const shortLines = inside(await frame(() => <Peek {...shortProps} unit="T1.4" width={50} lines={5} />, 120, 60))
  expect(shortLines.filter((line) => line.includes("› step")).map((line) => line.trim())).toEqual(["› step 2", "› step 3", "› step 4", "› step 5"])
  // wrap splits a word longer than the line.
  expect(wrap("a abcdefghij b", 4)).toEqual(["a", "abcd", "efgh", "ij b"])
})

test("T4.5 a task with endedAt and no startedAt did not start: both fallbacks say so", async () => {
  const blockedProps = await view(none, status)
  const lines = inside(await frame(() => <Peek {...blockedProps} unit="T1.5" width={60} lines={3} />))
  expect(lines).toContain("  no builder session: the task did not start")
  expect(lines).toContain("  no verifier session: the task did not start")
  // A task still to start keeps "yet".
  const pending = changed((raw) =>
    Object.assign(tasksIn(raw)["T1.5"], { state: "waiting", tags: ["waiting"], waitingOn: ["T1.4"], endedAt: undefined, reason: null }),
  )
  const pendingProps = await view(none, pending)
  const later = inside(await frame(() => <Peek {...pendingProps} unit="T1.5" width={60} lines={3} />))
  expect(later).toContain("  no builder session yet")
  expect(later).toContain("  no verifier session yet")
})

test("T4.5 a harness session carries its tokens (input, output and reasoning, no cache) and its cost, for T4.12", () => {
  const time = { created: 1, updated: 2 }
  const tokens = { input: 1000, output: 200, reasoning: 50, cache: { read: 9999, write: 7777 } }
  expect(harnessOf({ id: "b", title: "T1.4 builder", time, tokens, cost: 0.12 })).toEqual([
    { id: "b", unit: "T1.4", role: "builder", again: false, created: 1, updated: 2, tokens: 1250, cost: 0.12 },
  ])
  // A session that has not reported yet counts nothing; a session that is not the harness's is none.
  expect(harnessOf({ id: "v", title: "S3 verifier (again)", time })).toEqual([
    { id: "v", unit: "S3", role: "verifier", again: true, created: 1, updated: 2, tokens: 0, cost: 0 },
  ])
  expect(harnessOf({ id: "x", title: "Fix the parser", time, tokens, cost: 1 })).toEqual([])
})

test("the shortcut bar names the design, its keys, and drops keys before it overflows", async () => {
  const ledger = await view(none, ended)
  const wide = await frame(() => <ShortcutBar {...ledger} width={200} />, 200, 3)
  // The run has ended, so Tab switches agents again and the bar offers `ctrl+x j/k` to select a task.
  expect(wide).toContain(
    "◆ In the Flow Ledger  ctrl+x o expand  /task-design switch  ctrl+x j/k select task  ctrl+x w watch",
  )
  expect(wide).not.toContain("trusted")
  const narrow = await frame(() => <ShortcutBar {...ledger} width={100} />, 100, 3)
  expect(narrow).toContain("◆ In the Flow Ledger  ctrl+x o expand  /task-design switch")
  expect(narrow).not.toContain("select task")
  const ticker = await view(none, ended, 7)
  const line = await frame(() => <ShortcutBar {...ticker} width={200} />, 200, 3)
  expect(line).toContain("◆ In the Flow Ticker  3/6 trusted  ⊘ T1.4 budget exhausted  ctrl+x o expand")
  ticker.view.toggleExpanded()
  await settle()
  expect(await frame(() => <ShortcutBar {...ticker} width={200} />, 200, 3)).toContain("ctrl+x o collapse")
})

// --- the watch view -------------------------------------------------------------------------------------------------

// The run live again, before T1.4's death reached its dependants: T1 and T1.5 waiting (T1.5 on T1.4), and the given
// tasks in the given states.
const live = (states: Record<string, string>) =>
  restate({ state: "running", tags: ["active"] }, { T1: "waiting", "T1.5": "waiting", ...states }, { "T1.5": ["T1.4"] })

const child = (id: string, role: string, created: number, again = false): Child => ({
  id,
  role,
  again,
  created,
  updated: created,
})
const builders = [child("b1", "builder", 1), child("b2", "builder", 3), child("v1", "verifier", 2)]
const everyLoaded = () => true

test("Tab in the watch view moves to the next task in work, and does nothing with one or none", async () => {
  const two = rows(live({ "T1.2": "proving", "T1.4": "building" }))
  expect(nextRunning(two, "T1.4", 1)).toEqual(Option.some("T1.2"))
  expect(nextRunning(two, "T1.2", 1)).toEqual(Option.some("T1.4"))
  expect(nextRunning(two, "T1.2", -1)).toEqual(Option.some("T1.4"))
  // From a task out of work, the next one in work after it.
  expect(nextRunning(two, "T1.3", 1)).toEqual(Option.some("T1.4"))
  const one = rows(live({ "T1.4": "building" }))
  expect(Option.isNone(nextRunning(one, "T1.4", 1))).toBe(true)
  expect(Option.isNone(nextRunning(rows(ended), "T1.4", 1))).toBe(true)
  const { view: state, dispose } = await viewFor(live({ "T1.2": "verifying", "T1.4": "building" }))
  expect(state.selected()).toBe("T1.2")
  state.nextRunning()
  await settle()
  expect(state.selected()).toBe("T1.4")
  state.nextRunning()
  await settle()
  expect(state.selected()).toBe("T1.2")
  dispose()
})

test("a run is active until it ends, and waits on its waiting tasks' dependencies", async () => {
  expect(runActive(ended)).toBe(false)
  expect(runActive(live({ "T1.4": "building" }))).toBe(true)
  expect(waitsOn(live({}))).toEqual(["T1.4"])
  // The view is live while the run has not ended and its heartbeat is fresh (UI3).
  const liveness = async (input: Status, now?: number) => {
    const made = await viewFor(input, { now })
    const result = [made.view.liveness(), made.view.live()]
    made.dispose()
    return result
  }
  expect(await liveness(ended)).toEqual(["ended", false])
  expect(await liveness(live({}))).toEqual(["live", true])
  expect(await liveness(live({}), 1791000000000 + 15_001)).toEqual(["still", false])
})

test("the TUI reads the proof log where the harness writes it", () => {
  expect(proofLogFile("/repo", "T1.4")).toBe("/repo/.opencode/task/proofs/T1.4.log")
  expect(proofLogFile("/repo", "scenarios")).toBe("/repo/.opencode/task/proofs/scenarios.log")
})

test("the watch view shows a building task's latest builder, framed by the band", () => {
  const watch = chooseWatch({ status: live({ "T1.4": "building" }), task: "T1.4", children: builders, loaded: everyLoaded })
  expect(watch.session).toBe("b2")
  expect(watch.proofs).toBe("")
  expect(bandText(watch)).toBe("◆ In the Flow watching T1.4 builder · attempt 3 · watch only")
})

test("the watch view waits for a builder session the host cannot show yet", () => {
  const building = live({ "T1.4": "building" })
  const none = chooseWatch({ status: building, task: "T1.4", children: [], loaded: everyLoaded })
  expect(bandText(none)).toBe("◆ In the Flow waiting for T1.4 builder… · watch only")
  // No session to show yet: the root's own transcript, not the previous task's.
  expect(none.session).toBe("")
  expect(none.keep).toBe(false)
  const unloaded = chooseWatch({ status: building, task: "T1.4", children: builders, loaded: () => false })
  expect(bandText(unloaded)).toBe("◆ In the Flow waiting for T1.4 builder… · watch only")
  // The host is asked for the session, and tries again until it loads.
  expect(unloaded.session).toBe("b2")
})

test("a selection that is not in the run watches the first task in work", () => {
  const watch = chooseWatch({ status: live({ "T1.4": "building" }), task: "T9", children: builders, loaded: everyLoaded })
  expect(bandText(watch)).toBe("◆ In the Flow watching T1.4 builder · attempt 3 · watch only")
})

test("the watch view shows a proving task's proofs over its last builder", () => {
  const watch = chooseWatch({ status: live({ "T1.4": "proving" }), task: "T1.4", children: builders, loaded: everyLoaded })
  expect(watch.proofs).toBe("T1.4")
  expect(watch.session).toBe("b2")
  expect(bandText(watch)).toBe("◆ In the Flow watching T1.4 proofs · attempt 3 · watch only")
})

test("the watch view shows a verifying task's latest verifier, a parent's reviewer as its verifier", () => {
  const reviewers = [child("r1", "reviewer", 1), child("r2", "reviewer", 2, true)]
  const watch = chooseWatch({ status: live({ T1: "verifying" }), task: "T1", children: reviewers, loaded: everyLoaded })
  expect(watch.session).toBe("r2")
  expect(bandText(watch)).toBe("◆ In the Flow watching T1 verifier · parent review · second try · watch only")
})

test("with nothing in work the band names what the run waits on and the transcript stays", () => {
  const watch = chooseWatch({ status: live({}), task: "T1.4", children: builders, loaded: everyLoaded })
  expect(bandText(watch)).toBe("◆ In the Flow Nothing is running. The run waits on T1.4. · watch only")
  expect(watch.keep).toBe(true)
  expect(watch.proofs).toBe("")
  // After the run has ended, nothing waits: the band says how the run ended.
  const after = chooseWatch({ status: ended, task: "T1.4", children: builders, loaded: everyLoaded })
  expect(bandText(after)).toBe("◆ In the Flow Nothing is running · run: budget exhausted · watch only")
})

test("with no task in work, proofs written in the last seconds show: a parent's, or the scenarios'", () => {
  const logs = [
    { name: "T1", mtime: 1_000 },
    { name: "scenarios", mtime: 5_000 },
  ]
  expect(recentProof(logs, 8_000)).toBe("scenarios")
  expect(recentProof(logs, 5_000 + RECENT_PROOF + 1)).toBe("")
  const watch = chooseWatch({ status: live({}), task: "T1", children: [], loaded: everyLoaded, recent: "scenarios" })
  expect(bandText(watch)).toBe("◆ In the Flow watching scenarios proofs · watch only")
  expect(watch.proofs).toBe("scenarios")
  expect(watch.session).toBe("")
  expect(watch.keep).toBe(false)
})

test("a watched task out of work keeps its last session on screen until Tab moves on", () => {
  const watch = chooseWatch({
    status: live({ "T1.4": "trusted", "T1.5": "building" }),
    task: "T1.4",
    children: builders,
    loaded: everyLoaded,
  })
  expect(watch.session).toBe("b2")
  expect(bandText(watch)).toBe("◆ In the Flow watching T1.4 builder · attempt 3 · trusted · watch only")
})

test("the band and the note say what is watched, that it is watch only, and how to stop the run", async () => {
  const theme = (await view()).theme
  const watch = chooseWatch({ status: live({ "T1.4": "building" }), task: "T1.4", children: builders, loaded: everyLoaded })
  const band = await frame(() => <WatchBand theme={theme} watch={watch} width={120} live={true} />, 120, 3)
  expect(band).toContain("◆ In the Flow watching T1.4 builder · attempt 3 · watch only")
  expect(band).toContain("watch only: you type to the main session · esc twice stops the run · the same /task starts it")
  // Once the run is not live, `esc` no longer stops anything, so the note does not offer it.
  const ended = await frame(() => <WatchBand theme={theme} watch={watch} width={120} live={false} />, 120, 3)
  expect(lineWith(ended, "watch only:")).toBe("watch only: you type to the main session")
})

test("the proof panel shows the log's last lines as a shell call, or says there is no output yet", async () => {
  const theme = (await view()).theme
  const log = "$ bun test --reporter=junit\nbun test v1.3.14\n\n 3 pass\n$ exit 0\n"
  expect(proofTail(log, 3, 80)).toEqual(["", " 3 pass", "$ exit 0"])
  expect(proofTail("", 3, 80)).toEqual([])
  // Colour codes go; a line a progress display rewrote keeps what it shows last; a tail cut mid-line drops that line.
  const esc = String.fromCharCode(27)
  expect(proofTail(`${esc}[32m 3 pass${esc}[0m\n`, 3, 80)).toEqual([" 3 pass"])
  expect(proofTail("1/3\r2/3\r3/3 done\r\nexit 0\n", 3, 80)).toEqual(["3/3 done", "exit 0"])
  expect(proofTail("ll of a line\n$ exit 0\n", 3, 80, true)).toEqual(["$ exit 0"])
  const panel = await frame(() => <ProofPanel theme={theme} task="T1.4" text={log} width={100} height={8} />, 100, 12)
  expect(panel).toContain("PROOF  T1.4 tests and gates · run by the harness, not an agent")
  expect(panel).toContain("$ bun test --reporter=junit")
  expect(panel).toContain("$ exit 0")
  const empty = await frame(() => <ProofPanel theme={theme} task="T1.4" text="" width={100} height={8} />, 100, 6)
  expect(empty).toContain("no proof output yet")
})

test("while a run is active the bar offers Tab; in the watch view it shows only the watch keys", async () => {
  const running = await view(none, live({ "T1.4": "building" }))
  const bar = await frame(() => <ShortcutBar {...running} width={200} />, 200, 3)
  expect(bar).toContain("tab select task")
  expect(bar).toContain("ctrl+x w watch")
  running.view.setWatching(true)
  await settle()
  const watching = await frame(() => <ShortcutBar {...running} width={200} />, 200, 3)
  expect(lineWith(watching, "◆")).toBe("◆ In the Flow Ledger  tab next running  ctrl+x w stop watching  esc stop run")
  // After the run ends, Tab and esc no longer act on the run: `ctrl+x j/k` selects, and the toggle stays.
  const stopped = await view(none, ended)
  stopped.view.setWatching(true)
  await settle()
  const after = await frame(() => <ShortcutBar {...stopped} width={200} />, 200, 3)
  expect(lineWith(after, "◆")).toBe("◆ In the Flow Ledger  ctrl+x j/k select task  ctrl+x w stop watching")
})

// --- the plugin's keys and route, with the plugin API fixture and a real keymap --------------------------------------

const ROOT = "ses_root"

// The watch view and the Tab layer over a fixed status, on the root session's route. Tab that the plugin does not
// take reaches a stand-in for opencode's agent key. A real SDK client over a fetch records each abort.
async function wired(input: {
  status: Status
  design?: number
  harness?: ReadonlyArray<Harness>
  /** The statuses of the next reads of the feed, one for each second `advance` moves. */
  later?: ReadonlyArray<Status>
  /** Whether the root owns the run's harness sessions; true by default. */
  owns?: () => boolean
}) {
  const made = await viewFor(input.status, { design: input.design ?? 1, later: input.later })
  const navigations: Array<Record<string, unknown> | undefined> = []
  const aborted: string[] = []
  const toasts: string[] = []
  const agent = { moves: 0 }
  const answer = async (request: RequestInfo | URL) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    const abort = /^\/session\/([^/]+)\/abort$/.exec(url.pathname)
    if (!abort) return new Response(null, { status: 404 })
    aborted.push(decodeURIComponent(abort[1]))
    return json(true)
  }
  const client = createOpencodeClient({
    baseUrl: "http://localhost:4096",
    fetch: Object.assign(answer, { preconnect: fetch.preconnect }),
  })
  const handles: { ctx?: Ctx; toggle?: () => void } = {}
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const keybinds = createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse({})), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    })
    registerOpencodeKeymap(keymap, renderer, { keybinds, leader_timeout: 2000 })
    keymap.registerLayer({
      commands: [{ name: "agent.cycle", run: () => void agent.moves++ }],
      bindings: [{ key: "tab", cmd: "agent.cycle" }],
    })
    const [current, setCurrent] = createSignal<TuiRouteCurrent>({ name: "session", params: { sessionID: ROOT } })
    const base = createTuiPluginApi({ renderer, keymap, client })
    const api: TuiPluginApi = {
      ...base,
      route: {
        register: () => () => {},
        navigate(name, params) {
          navigations.push(params)
          setCurrent(params ? { name, params } : { name })
        },
        get current() {
          return current()
        },
      },
      ui: { ...base.ui, toast: (toast) => void toasts.push(toast.message) },
    }
    const ctx: Ctx = {
      api,
      view: made.view,
      sessions: none,
      theme: () => theme,
      active: () => true,
      leader: "ctrl+x",
      root: () => ROOT,
      owns: input.owns ?? (() => true),
      harness: () => input.harness ?? [],
      logs: () => [],
    }
    handles.ctx = ctx
    handles.toggle = registerWatch(ctx, made.listen)
    registerTab(ctx)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <box />
      </OpencodeKeymapProvider>
    )
  }
  const app = await testRender(() => <Harness />, { width: 80, height: 10 })
  const { ctx, toggle } = handles
  if (!ctx || !toggle) throw new Error("the plugin did not register")
  return { app, view: ctx.view, toggle, navigations, aborted, toasts, agent, advance: made.advance }
}

// Waits until `done` holds: keys and the SDK answer on later ticks.
async function until(done: () => boolean) {
  for (let tries = 0; tries < 100 && !done(); tries++) await Bun.sleep(10)
  return done()
}

const harnessOfT14 = [{ ...child("b2", "builder", 3), unit: "T1.4", tokens: 0, cost: 0 }]

test("ctrl+x w from an expanded Board collapses it and puts the builder in the session route's watch", async () => {
  const plugin = await wired({ status: live({ "T1.4": "building" }), design: 3, harness: harnessOfT14 })
  try {
    plugin.view.setExpanded(true)
    await settle()
    plugin.toggle()
    await settle()
    expect(plugin.view.expanded()).toBe(false)
    expect(plugin.view.watching()).toBe(true)
    expect(await until(() => plugin.navigations.at(-1)?.watch === "b2")).toBe(true)
    expect(plugin.navigations.at(-1)).toEqual({ sessionID: ROOT, watch: "b2" })
    // The toggle again returns the root's own transcript.
    plugin.toggle()
    expect(await until(() => plugin.navigations.at(-1)?.watch === undefined)).toBe(true)
    expect(plugin.navigations.at(-1)).toEqual({ sessionID: ROOT })
  } finally {
    plugin.app.renderer.destroy()
  }
})

test("esc twice in the watch view aborts the root session and says how to start the run again", async () => {
  const plugin = await wired({ status: live({ "T1.4": "building" }), harness: harnessOfT14 })
  try {
    plugin.toggle()
    await plugin.app.renderOnce()
    plugin.app.mockInput.pressEscape()
    expect(await until(() => plugin.toasts.length === 1)).toBe(true)
    expect(plugin.toasts).toEqual(["Press esc again to stop the run"])
    plugin.app.mockInput.pressEscape()
    expect(await until(() => plugin.toasts.length === 2)).toBe(true)
    expect(plugin.aborted).toEqual([ROOT])
    expect(plugin.toasts[1]).toBe("Run stopped. Type /task task-formats/blend/release-notes.spec to start it again.")
  } finally {
    plugin.app.renderer.destroy()
  }
})

test("Tab selects the next task while the run is live, the next one in work in the watch view", async () => {
  const plugin = await wired({ status: live({ "T1.2": "verifying", "T1.4": "building" }) })
  try {
    expect(plugin.view.selected()).toBe("T1.2")
    plugin.app.mockInput.pressTab()
    expect(await until(() => plugin.view.selected() === "T1.3")).toBe(true)
    // Watching from a task out of work starts on the next task in work; Tab then skips T1.3 and T1.5.
    plugin.toggle()
    await settle()
    expect(plugin.view.selected()).toBe("T1.4")
    plugin.app.mockInput.pressTab()
    expect(await until(() => plugin.view.selected() === "T1.2")).toBe(true)
    plugin.app.mockInput.pressTab()
    expect(await until(() => plugin.view.selected() === "T1.4")).toBe(true)
    expect(plugin.agent.moves).toBe(0)
  } finally {
    plugin.app.renderer.destroy()
  }
})

test("after the run ends, Tab is not taken: it reaches the agent key", async () => {
  const plugin = await wired({ status: ended })
  try {
    plugin.app.mockInput.pressTab()
    expect(await until(() => plugin.agent.moves === 1)).toBe(true)
    expect(plugin.view.selected()).toBe("T1.4")
  } finally {
    plugin.app.renderer.destroy()
  }
})

// --- the view actor's reads and keys (T4.3) ---------------------------------------------------------------------------

test("UI21 with nothing running and the run waiting only on T9, the band gives its trust command; an external id gets none", () => {
  const onT9 = restate(
    { state: "running", tags: ["active"] },
    { T1: "waiting", "T1.4": "trusted", "T1.5": "waiting" },
    { "T1.5": ["T9"], T1: ["T1.5"] },
  )
  expect(bandText(chooseWatch({ status: onT9, task: "T1.5", children: [], loaded: everyLoaded }))).toBe(
    "◆ In the Flow Nothing is running. The run is waiting on T9 (outside) — run /task trust T9. · watch only",
  )
  // A subtree run that waits on the folder task T1.1, an external region: no trust command for it.
  const copy = structuredClone(projected)
  Object.assign(copy, { external: { "T1.1": { state: "untrusted", tags: ["waiting"] } } })
  copy.run.tags = ["active"]
  const tasks: Record<string, { state: string; tags: string[]; waitingOn: string[] }> = copy.tasks
  for (const id of ["T1", "T1.2", "T1.3", "T1.4"]) Object.assign(tasks[id], { state: "trusted", tags: ["ended"] })
  Object.assign(tasks["T1.5"], { state: "waiting", tags: ["waiting"], waitingOn: ["T1.1"] })
  const external = Option.getOrThrow(parse(JSON.stringify(copy)))
  const band = bandText(chooseWatch({ status: external, task: "T1.5", children: [], loaded: everyLoaded }))
  expect(band).toBe("◆ In the Flow Nothing is running. The run waits on T1.1. · watch only")
  expect(band).not.toContain("/task trust")
})

test("the watch view reads the tags: a task whose state says building but whose tags say ended is not in work", () => {
  const copy = structuredClone(projected)
  Object.assign(copy.tasks["T1.4"], { state: "building", tags: ["ended"] })
  const odd = Option.getOrThrow(parse(JSON.stringify(copy)))
  expect(bandText(chooseWatch({ status: odd, task: "T1.4", children: builders, loaded: everyLoaded }))).toStartWith(
    "◆ In the Flow Nothing is running",
  )
  // And a task the tags put in work is watched whatever its state's name.
  const tagged = restate({ state: "running", tags: ["active"] }, { "T1.4": "building" })
  expect(chooseWatch({ status: tagged, task: "T1.4", children: builders, loaded: everyLoaded }).session).toBe("b2")
})

test("the Peek reads the session list on each 2 s tick and a session's activity on each 1.5 s tick of the view", async () => {
  const made = await viewFor(live({}))
  made.view.send({ type: "route.changed", session: ROOT })
  await settle()
  const calls = { children: 0, messages: 0 }
  const client = {
    session: {
      children: async () => {
        calls.children++
        return { data: [] }
      },
      messages: async () => {
        calls.messages++
        return { data: [] }
      },
    },
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (b) liveSessions reads only `client.session.children` and `.messages`
  const api = { client } as unknown as TuiPluginApi
  const read = createRoot((dispose) => {
    const sessions = liveSessions(api, made.view)
    return { all: sessions.all(), activity: sessions.activity("ses_b"), dispose }
  })
  await settle()
  expect(calls).toEqual({ children: 1, messages: 1 })
  await made.advance(1_500)
  expect(calls).toEqual({ children: 1, messages: 2 })
  await made.advance(500)
  expect(calls).toEqual({ children: 2, messages: 2 })
  read.dispose()
  made.dispose()
})

test("the proof tail is read again on each 500 ms tick of the view", async () => {
  const folder = await Bun.$`mktemp -d`.text()
  const file = `${folder.trim()}/T1.4.log`
  await Bun.write(file, "$ bun test\n")
  const made = await viewFor(live({ "T1.4": "proving" }))
  const read = createRoot((dispose) => ({ tail: liveTail(file, made.view), dispose }))
  for (let tries = 0; tries < 100 && read.tail().text === ""; tries++) await settle()
  expect(read.tail().text).toBe("$ bun test\n")
  await Bun.write(file, "$ bun test\n 3 pass\n")
  await settle()
  expect(read.tail().text).toBe("$ bun test\n")
  await made.advance(500)
  for (let tries = 0; tries < 100 && !read.tail().text.includes("3 pass"); tries++) await settle()
  expect(read.tail().text).toBe("$ bun test\n 3 pass\n")
  read.dispose()
  made.dispose()
})

test("an esc armed while the run is live stops nothing once the run has ended", async () => {
  const over = restate({ state: "budget_exhausted", tags: ["ended", "stopped"] }, { "T1.4": "budget_exhausted" })
  const plugin = await wired({ status: live({ "T1.4": "building" }), harness: harnessOfT14, later: [over] })
  try {
    plugin.toggle()
    await plugin.app.renderOnce()
    plugin.app.mockInput.pressEscape()
    expect(await until(() => plugin.toasts.length === 1)).toBe(true)
    await plugin.advance(1_000)
    expect(plugin.view.liveness()).toBe("ended")
    plugin.app.mockInput.pressEscape()
    await Bun.sleep(100)
    expect(plugin.aborted).toEqual([])
    expect(plugin.toasts).toEqual(["Press esc again to stop the run"])
  } finally {
    plugin.app.renderer.destroy()
  }
})

test("with the watch on and the run live, esc stops nothing from a root that no longer owns the run's sessions", async () => {
  const [owns, setOwns] = createSignal(true)
  const plugin = await wired({ status: live({ "T1.4": "building" }), harness: harnessOfT14, owns })
  try {
    plugin.toggle()
    await plugin.app.renderOnce()
    // The developer moved to a session that owns no harness session: the esc keys leave the run alone.
    setOwns(false)
    await settle()
    plugin.app.mockInput.pressEscape()
    await Bun.sleep(150)
    expect(plugin.toasts).toEqual([])
    plugin.app.mockInput.pressEscape()
    await Bun.sleep(150)
    expect(plugin.toasts).toEqual([])
    expect(plugin.aborted).toEqual([])
    // Owned again, the first esc warns.
    setOwns(true)
    await settle()
    plugin.app.mockInput.pressEscape()
    expect(await until(() => plugin.toasts.length === 1)).toBe(true)
  } finally {
    plugin.app.renderer.destroy()
  }
})

test("ctrl+x w does not turn the watch view on for a root that owns no harness session of the run", async () => {
  const plugin = await wired({ status: live({ "T1.4": "building" }), harness: harnessOfT14, owns: () => false })
  try {
    plugin.toggle()
    await settle()
    expect(plugin.view.watching()).toBe(false)
    expect(plugin.navigations).toEqual([])
  } finally {
    plugin.app.renderer.destroy()
  }
})
