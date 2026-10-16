import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Option, Result } from "effect"
import path from "path"
import { createComponent, type JSX } from "solid-js"
import ts from "typescript"
import { CLASS, TAGS } from "@/task/engine-xstate/machine"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import type { Sessions } from "../../../tui/src/task-ui/peek"
import { stoppedLines } from "../../../tui/src/task-ui/shared"
import { counts, focus, nextRunning, parse, rows, type Column, type Status } from "../../../tui/src/task-ui/store"
import { ShortcutBar, stoppedText, trustedText } from "../../../tui/src/task-ui/ui"
import { BoardView, boardRows, cardsIn } from "../../../tui/src/task-ui/designs/3-board"
import { settle, viewFor } from "../../../tui/test/task-ui/view"

// Scenario UI1 (spec task-harness-feedback, D16, AD-16; tasks T4.2, T4.6): the task-ui classifies every unit only
// from the status tags.
//
//   Given a status with waiting, active, trusted, dead, blocked and cancelled tasks
//   When the Board and the counts read it
//   Then waiting tasks are in WAITING, active tasks in the column of their phase, stopped tasks in STOPPED and the
//     other ended tasks in TRUSTED
//   And STOPPED groups dead tasks, then blocked tasks, then the rest
//   And the counts, the focus and the next running task come from the tags
//   And the task-ui keeps no list of active or ended state names
//
// The status gives each task the tags that the harness's own class table (`CLASS` of the engine machine) gives its
// state, and is decoded by the task-ui's own `parse`. The Board is the real `BoardView` over a real taskView actor (the
// tui test helper `viewFor`: the real machine on a SimulatedClock, its feed returning the status), rendered by the
// opentui test renderer; the columns are read from the captured frame. The counts are the store's `counts`, the
// texts the designs show, and the shortcut bar; the focus and the next running task are the store's selectors and the
// view machine's selection. Two more statuses prove the tags alone decide: one renames every state that is not an
// active phase to a name the task-ui does not know, one gives states that contradict their tags. The last test reads
// every task-ui source with the TypeScript parser.

const TASK_UI = path.resolve(import.meta.dir, "../../../tui/src/task-ui")
const NOW = 1_791_000_000_000
const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }

type TaskState = keyof typeof CLASS.task

/** A task in `state`, with the name the status shows and the class tags the harness gives that state. */
const task = (state: TaskState, extra: Record<string, unknown> = {}) => ({
  state: CLASS.task[state].shows,
  tags: [...CLASS.task[state].tags],
  attempts: 1,
  waitingOn: [],
  waitingOnOutside: [],
  ...extra,
})

/** A status file of a live run with `tasks`, decoded by the task-ui's own `parse`. */
const statusOf = (tasks: Record<string, object>): Status =>
  Option.getOrThrow(
    parse(
      JSON.stringify({
        run: {
          state: "running",
          tags: [...CLASS.run.running.tags],
          spec: "task-formats/blend/release-notes.spec",
          path: "task-formats/blend/release-notes.spec",
          startedAt: NOW - 600_000,
          aliveAt: NOW,
        },
        tasks,
        obligations: {},
        scenarios: {},
        history: [],
      }),
    ),
  )

const BLOCKED = "blocked by T1.4: budget exhausted"

// One task of each class: T1.7 waiting and T1.8 ready (both waiting); T1.2 building, T1.3 proving and T1.6 judging
// (active, in the column of their phase); T1.1 trusted; T1.4 budget exhausted and T2 failed (dead); T1 and T1.5
// blocked; T3 cancelled.
const CLASSES: Record<string, object> = {
  T1: task("blocked", { attempts: 0, reason: BLOCKED, blockedBy: { id: "T1.4", state: "budget_exhausted" } }),
  "T1.1": task("trusted"),
  "T1.2": task("building"),
  "T1.3": task("proving"),
  "T1.4": task("budget_exhausted", {
    attempts: 3,
    reason: "T1.4.c7: the test asserts only that 'topic change' appears",
  }),
  "T1.5": task("blocked", { attempts: 0, reason: BLOCKED, blockedBy: { id: "T1.4", state: "budget_exhausted" } }),
  "T1.6": task("judging", { attempts: 2 }),
  "T1.7": task("waiting", { attempts: 0, waitingOn: ["T1.2"] }),
  "T1.8": task("ready", { attempts: 0 }),
  T2: task("failed", { reason: "T2.c1: the gate exited 1" }),
  T3: task("cancelled", { attempts: 0, reason: "cancelled: the run was stopped" }),
}

const COLUMNS: ReadonlyArray<Column> = ["WAITING", "BUILDING", "PROVING", "VERIFYING", "TRUSTED", "STOPPED"]

/** The expected Board of CLASSES: dead (T1.4, T2), then blocked (T1, T1.5), then the rest (T3) in STOPPED. */
const EXPECTED: Readonly<Record<Column, Array<string>>> = {
  WAITING: ["T1.7", "T1.8"],
  BUILDING: ["T1.2"],
  PROVING: ["T1.3"],
  VERIFYING: ["T1.6"],
  TRUSTED: ["T1.1"],
  STOPPED: ["T1.4", "T2", "T1", "T1.5", "T3"],
}

const columnsOf = (status: Status) =>
  Object.fromEntries(COLUMNS.map((column) => [column, cardsIn(rows(status), column).map((row) => row.id)]))

async function frameOf(node: () => JSX.Element, width: number, height: number) {
  const app = await testRender(node, { width, height })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

// Each Board column of a frame: its heading, and the id on the first line of each of its cards, top to bottom.
const boardOf = (frame: string) => {
  const lines = frame.split("\n")
  return [...(lines[0] ?? "").matchAll(/([A-Z]+) (\d+)/g)].map((match) => {
    const at = match.index ?? 0
    const ids = lines.slice(1).flatMap((line, index, all) => {
      if (line[at] !== "╭") return []
      const first = all[index + 1] ?? ""
      return [
        first
          .slice(at + 1, first.indexOf("│", at + 1))
          .trim()
          .split(" ")
          .at(-1) ?? "",
      ]
    })
    return { column: match[1], count: Number(match[2]), ids }
  })
}

async function renderBoard(status: Status, width = 140) {
  const made = await viewFor(status, { design: 3 })
  try {
    const height = boardRows(made.view, width) + 2
    return boardOf(
      await frameOf(
        () =>
          createComponent(BoardView, { theme: () => theme, view: made.view, sessions: none, leader: "ctrl+x", width }),
        width,
        height,
      ),
    )
  } finally {
    made.dispose()
  }
}

test("[UI1] the Board puts waiting tasks in WAITING, active tasks in their phase's column, stopped tasks in STOPPED and other ended tasks in TRUSTED", async () => {
  const status = statusOf(CLASSES)
  // The tags each class carries, from the harness's class table.
  expect(status.tasks["T1.8"].tags).toEqual(["waiting"])
  expect(status.tasks["T1.6"]).toMatchObject({ state: "verifying", tags: ["active"] })
  expect(status.tasks["T1.4"].tags).toEqual(["ended", "stopped", "dead"])
  expect(status.tasks["T1.5"].tags).toEqual(["ended", "stopped", "blocked"])
  expect(status.tasks.T3.tags).toEqual(["ended", "stopped"])
  expect(status.tasks["T1.1"].tags).toEqual(["ended"])
  expect(columnsOf(status)).toEqual(EXPECTED)

  // The Board on screen, read column by column from the frame.
  const board = await renderBoard(status)
  expect(board.map((column) => column.column)).toEqual([...COLUMNS])
  // Each column's heading count and its cards, top to bottom.
  expect(board.map((column) => ({ column: column.column, count: column.count, ids: column.ids }))).toEqual(
    COLUMNS.map((column) => ({ column, count: EXPECTED[column].length, ids: [...EXPECTED[column]] })),
  )
})

test("[UI1] STOPPED groups the dead tasks, then the blocked tasks, then the rest, on the Board and in the STOPPED list", async () => {
  const status = statusOf(CLASSES)
  const stopped = (await renderBoard(status)).find((column) => column.column === "STOPPED")
  // In tree order T1 comes first; in STOPPED the dead T1.4 and T2 come first, the blocked T1 and T1.5 next, T3 last.
  expect(rows(status).map((row) => row.id)).toEqual([
    "T1",
    ...Array.from({ length: 8 }, (_, i) => `T1.${i + 1}`),
    "T2",
    "T3",
  ])
  expect(stopped?.ids).toEqual(["T1.4", "T2", "T1", "T1.5", "T3"])
  // The shared region's STOPPED list keeps the same groups, one line for each state and reason.
  expect(stoppedLines(status).map((line) => ({ state: line.state, ids: line.ids }))).toEqual([
    { state: "budget_exhausted", ids: ["T1.4"] },
    { state: "failed", ids: ["T2"] },
    { state: "blocked", ids: ["T1", "T1.5"] },
    { state: "cancelled", ids: ["T3"] },
  ])
})

test("[UI1] the counts, the focus and the next running task come from the tags", async () => {
  const status = statusOf(CLASSES)
  // One trusted (ended without stopped), three active, five stopped, of eleven.
  expect(counts(status)).toEqual({ total: 11, trusted: 1, active: 3, stopped: 5 })
  expect(trustedText(status)).toBe("1/11 trusted")
  expect(stoppedText(status)).toBe(" · 5 stopped")
  const made = await viewFor(status, { design: 3 })
  try {
    const bar = await frameOf(
      () =>
        createComponent(ShortcutBar, {
          theme: () => theme,
          view: made.view,
          sessions: none,
          leader: "ctrl+x",
          width: 250,
        }),
      250,
      3,
    )
    expect(bar).toContain("1/11 trusted")
    expect(bar).toContain("· 5 stopped")

    // The focus is the first task in work in tree order; with nothing chosen the view selects it.
    const list = rows(status)
    expect(focus(list)).toBe("T1.2")
    expect(made.view.selected()).toBe("T1.2")
    // The next running task steps through the active tasks only, wrapping round; from a waiting task it finds the
    // next active one.
    expect(Option.getOrUndefined(nextRunning(list, "T1.2", 1))).toBe("T1.3")
    expect(Option.getOrUndefined(nextRunning(list, "T1.3", 1))).toBe("T1.6")
    expect(Option.getOrUndefined(nextRunning(list, "T1.6", 1))).toBe("T1.2")
    expect(Option.getOrUndefined(nextRunning(list, "T1.2", -1))).toBe("T1.6")
    expect(Option.getOrUndefined(nextRunning(list, "T1.7", 1))).toBe("T1.2")
    for (const id of ["T1.3", "T1.6", "T1.2"]) {
      made.view.nextRunning()
      await settle()
      expect({ id, selected: made.view.selected() }).toEqual({ id, selected: id })
    }
  } finally {
    made.dispose()
  }
  // With no task in work, the focus is the most severe stopped task: the first dead one in tree order.
  const idle = statusOf(
    Object.fromEntries(
      Object.entries(CLASSES).map(([id, item]) => [id, ["T1.2", "T1.3", "T1.6"].includes(id) ? task("trusted") : item]),
    ),
  )
  expect(focus(rows(idle))).toBe("T1.4")
  expect(nextRunning(rows(idle), "T1.4", 1)).toEqual(Option.none())
})

test("[UI1] the tags alone decide: unknown state names classify the same, and a state that contradicts its tags follows the tags", async () => {
  // Every state that is not an active phase renamed to a name the task-ui has never seen: the same Board and counts.
  const renamed = statusOf(
    Object.fromEntries(
      Object.entries(CLASSES).map(([id, item]) => {
        const tags: ReadonlyArray<string> = Reflect.get(item, "tags")
        return [id, tags.includes("active") ? item : { ...item, state: `state_${id.replaceAll(".", "_")}` }]
      }),
    ),
  )
  expect(renamed.tasks.T3.state).toBe("state_T3")
  expect(columnsOf(renamed)).toEqual(EXPECTED)
  expect(counts(renamed)).toEqual({ total: 11, trusted: 1, active: 3, stopped: 5 })
  expect(focus(rows(renamed))).toBe("T1.2")
  expect((await renderBoard(renamed)).find((column) => column.column === "STOPPED")?.ids).toEqual(EXPECTED.STOPPED)

  // State names that say the opposite of the tags.
  const contrary = statusOf({
    "T1.1": { ...task("trusted"), state: "building" },
    "T1.2": { ...task("waiting"), state: "trusted" },
    "T1.3": { ...task("budget_exhausted"), state: "proving" },
    "T1.4": task("verifying"),
    "T1.5": { ...task("blocked"), state: "cancelled" },
    "T1.6": { ...task("cancelled"), state: "blocked" },
    "T1.7": { ...task("cancelled"), state: "failed" },
  })
  expect(columnsOf(contrary)).toEqual({
    WAITING: ["T1.2"],
    BUILDING: [],
    PROVING: [],
    VERIFYING: ["T1.4"],
    TRUSTED: ["T1.1"],
    // Dead by its tags (T1.3), blocked by its tags (T1.5), then the rest (T1.6, T1.7), whatever their state names.
    STOPPED: ["T1.3", "T1.5", "T1.6", "T1.7"],
  })
  expect(counts(contrary)).toEqual({ total: 7, trusted: 1, active: 1, stopped: 4 })
  expect(focus(rows(contrary))).toBe("T1.4")
  expect(nextRunning(rows(contrary), "T1.4", 1)).toEqual(Option.none())
  const board = await renderBoard(contrary)
  expect(board.map((column) => [column.column, column.ids])).toEqual(
    Object.entries({
      WAITING: ["T1.2"],
      BUILDING: [],
      PROVING: [],
      VERIFYING: ["T1.4"],
      TRUSTED: ["T1.1"],
      STOPPED: ["T1.3", "T1.5", "T1.6", "T1.7"],
    }),
  )
})

// --- the sources --------------------------------------------------------------------------------------------------

// Every state name the harness writes (each kind's state keys and the names they show), with the older `stalled` and
// the refused run's `refused`, less the names that are also class tags (`waiting`, `blocked`): a list of tag names is
// how the task-ui is meant to classify.
const STATE_NAMES = [
  ...new Set(
    [
      ...Object.values(CLASS).flatMap((kind) =>
        Object.entries(kind).flatMap(([name, item]): ReadonlyArray<string> => [name, item.shows]),
      ),
      "stalled",
      "refused",
    ].filter((name) => !TAGS.some((tag) => tag === name)),
  ),
]

/** Each `ACTIVE` or `ENDED` name, and each list literal that names a state, in one source text. */
const stateLists = (file: string, text: string) => {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const found: Array<string> = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && (node.text === "ACTIVE" || node.text === "ENDED"))
      found.push(`${file}: the name ${node.text}`)
    if (ts.isArrayLiteralExpression(node)) {
      const names = node.elements.flatMap((element) =>
        ts.isStringLiteralLike(element) && STATE_NAMES.includes(element.text) ? [element.text] : [],
      )
      if (names.length > 0) found.push(`${file}: a list of state names [${names.join(", ")}]`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

test("[UI1] the task-ui keeps no list of active or ended state names", async () => {
  const files = (await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: TASK_UI }))).sort()
  // Every source of the task-ui is read, the store, the designs and the view machine among them.
  expect(files).toEqual(
    expect.arrayContaining(["store.ts", "machine.ts", "view.ts", "shared.tsx", "ui.tsx", "designs/3-board.tsx"]),
  )
  expect(STATE_NAMES).toEqual(
    expect.arrayContaining(["building", "proving", "verifying", "trusted", "budget_exhausted", "cancelled", "done"]),
  )
  const found = (
    await Promise.all(files.map(async (file) => stateLists(file, await Bun.file(path.join(TASK_UI, file)).text())))
  ).flat()
  expect(found).toEqual([])
  // The check finds such a list where one is: the lists the task-ui had before the tags.
  expect(
    stateLists(
      "old.ts",
      'export const ACTIVE = ["building", "proving", "verifying"]\nconst ended = ["trusted", "cancelled"]',
    ),
  ).toEqual([
    "old.ts: the name ACTIVE",
    "old.ts: a list of state names [building, proving, verifying]",
    "old.ts: a list of state names [trusted, cancelled]",
  ])
  // The class order the task-ui uses is a list of tags, not of states.
  const store = await Bun.file(path.join(TASK_UI, "store.ts")).text()
  expect(store).toContain('const SEVERITY = ["dead", "blocked", "stopped", "active", "waiting", "ended"]')
})
