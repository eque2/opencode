import { NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import type { CapturedFrame, RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { Effect, Option, Result } from "effect"
import { createComponent, type JSX } from "solid-js"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { CLASS } from "@/task/engine-xstate/machine"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import { Peek, builderHeading, type Sessions } from "../../../tui/src/task-ui/peek"
import { outsideWaits } from "../../../tui/src/task-ui/shared"
import { parse, rows, type Status } from "../../../tui/src/task-ui/store"
import { ShortcutBar } from "../../../tui/src/task-ui/ui"
import type { View } from "../../../tui/src/task-ui/view"
import { LedgerView } from "../../../tui/src/task-ui/designs/1-ledger"
import { DockView } from "../../../tui/src/task-ui/designs/2-dock"
import { BoardView, cardLines } from "../../../tui/src/task-ui/designs/3-board"
import { HudView } from "../../../tui/src/task-ui/designs/6-hud"
import { TickerDialog } from "../../../tui/src/task-ui/designs/7-ticker"
import { Screen } from "../../../tui/src/task-ui/designs/screen"
import { settle, viewFor } from "../../../tui/test/task-ui/view"
import { loadPlan } from "./lib/machine"

// Scenario UI5 (spec task-harness-feedback, D4, AD-15, AD-16; tasks T4.4-T4.8): an outside wait and an external wait
// read differently.
//
//   Given a waiting task whose waitingOn holds the untrusted outside id T9 and the external id T1.1
//   When the Board card, the Peek and the collapsed views render
//   Then the outside wait reads "waiting on T9 (outside) — run /task trust T9" on every design, and the shortcut bar
//     has an outside-wait part
//   And the external wait reads "waiting on T1.1 (not in this run)" with no trust command
//
// The status is decoded by the task-ui's own `parse`; its tags and region states are the ones the harness's class
// table gives. Every view is the real task-ui component over a real taskView actor (the tui test helper `viewFor`: the
// real machine, whose feed read gives the status), rendered by the opentui test renderer: the Board card, the Peek, the
// collapsed and expanded views of all seven designs, and the shortcut bar of each. The last test feeds the task-ui the
// harness's own projection (`TaskStatus.project` over the engine's initial snapshot) of a subtree run of the
// release-notes spec, whose task T1.5 waits on the outside precondition T9 and on T1.3 and T1.4 outside the subtree.

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }
const NOW = 1_791_000_000_000
const OUTSIDE = "waiting on T9 (outside) — run /task trust T9"
const EXTERNAL = "waiting on T1.1 (not in this run)"

const waitingTask = (extra: Record<string, unknown>) => ({
  state: CLASS.task.waiting.shows,
  tags: [...CLASS.task.waiting.tags],
  attempts: 0,
  waitingOn: [],
  waitingOnOutside: [],
  ...extra,
})

/** A live subtree run: T1.2 waits on the outside id T9 and on T1.1, a task outside the run; T1.3 waits on T1.2. */
const statusOf = (change: { outside?: string; run?: Record<string, unknown>; waits?: ReadonlyArray<string> } = {}) =>
  Option.getOrThrow(
    parse(
      JSON.stringify({
        run: {
          state: "running",
          tags: [...CLASS.run.running.tags],
          spec: "task-formats/blend/release-notes.spec",
          path: "task-formats/blend/release-notes.spec/T1-release-notes.task/T1.2-version-bump.task",
          startedAt: NOW - 60_000,
          aliveAt: NOW,
          ...change.run,
        },
        tasks: {
          "T1.2": waitingTask({
            waitingOn: change.waits ?? ["T1.1", "T9"],
            waitingOnOutside: (change.waits ?? ["T1.1", "T9"]).filter((id) => id === "T9"),
          }),
          "T1.3": waitingTask({ waitingOn: ["T1.2"] }),
        },
        obligations: {},
        scenarios: {},
        outside: {
          T9: {
            state: change.outside ?? "untrusted",
            tags: [...CLASS.outside[change.outside === "trusted" ? "trusted" : "untrusted"].tags],
          },
        },
        external: { "T1.1": { state: "untrusted", tags: [...CLASS.external.untrusted.tags] } },
        history: [],
      }),
    ),
  )

async function render(node: () => JSX.Element, width: number, height: number) {
  const app = await testRender(node, { width, height })
  try {
    await app.renderOnce()
    return { text: app.captureCharFrame(), spans: app.captureSpans() }
  } finally {
    app.renderer.destroy()
  }
}

/** `node` over a real view of `status` on `design`, collapsed or expanded. */
async function shown(
  status: Status,
  design: number,
  expanded: boolean,
  node: (view: View) => JSX.Element,
  width: number,
  height: number,
) {
  const made = await viewFor(status, { design })
  try {
    if (expanded) made.view.setExpanded(true)
    await settle()
    return await render(() => node(made.view), width, height)
  } finally {
    made.dispose()
  }
}

const props = (view: View) => ({ theme: () => theme, view, sessions: none, leader: "ctrl+x" })
const rgb = (value: RGBA | undefined) => (value ? [value.r, value.g, value.b] : [])
const fgOf = (captured: CapturedFrame, text: string) =>
  rgb(captured.lines.flatMap((line) => line.spans).find((span) => span.text.includes(text))?.fg)
const lines = (text: string) => text.split("\n").map((line) => line.trimEnd())

// Every design's views: its collapsed view where it has one, its expanded view, and its shortcut bar.
const VIEWS: ReadonlyArray<{
  readonly name: string
  readonly design: number
  readonly expanded: boolean
  readonly node: (view: View) => JSX.Element
  readonly width: number
  readonly height: number
}> = [
  {
    name: "Ledger",
    design: 1,
    expanded: false,
    node: (view) => createComponent(LedgerView, { ...props(view), width: 60 }),
    width: 60,
    height: 30,
  },
  {
    name: "Ledger",
    design: 1,
    expanded: true,
    node: (view) => createComponent(LedgerView, { ...props(view), width: 60 }),
    width: 60,
    height: 60,
  },
  {
    name: "Dock",
    design: 2,
    expanded: false,
    node: (view) => createComponent(DockView, { ...props(view), width: 200 }),
    width: 200,
    height: 10,
  },
  {
    name: "Dock",
    design: 2,
    expanded: true,
    node: (view) => createComponent(DockView, { ...props(view), width: 200, height: 60 }),
    width: 200,
    height: 60,
  },
  ...[3, 4, 5].map((design) => ({
    name: ["Board", "Matrix", "Gantt"][design - 3],
    design,
    expanded: true,
    node: (view: View) => createComponent(Screen, { ...props(view), width: 120, height: 50 }),
    width: 120,
    height: 50,
  })),
  {
    name: "HUD",
    design: 6,
    expanded: false,
    node: (view) => createComponent(HudView, props(view)),
    width: 80,
    height: 30,
  },
  {
    name: "HUD",
    design: 6,
    expanded: true,
    node: (view) => createComponent(HudView, props(view)),
    width: 120,
    height: 60,
  },
  {
    name: "Ticker",
    design: 7,
    expanded: true,
    node: (view) => createComponent(TickerDialog, props(view)),
    width: 120,
    height: 50,
  },
]

test("[UI5] the Board card and the Peek read the outside wait with its trust command and the external wait without one", async () => {
  const status = statusOf()
  const row = rows(status).find((item) => item.id === "T1.2")
  if (!row) throw new Error("no T1.2")
  // The card's lines and the Peek's heading: the outside wait in the warning tone, the external wait muted.
  expect(cardLines(status, row, "live", NOW, 45)).toEqual([
    { text: OUTSIDE, tone: "warning" },
    { text: EXTERNAL, tone: "muted" },
  ])
  expect(builderHeading(status, "T1.2", "live", NOW)).toEqual([
    { text: OUTSIDE, tone: "warning" },
    { text: EXTERNAL, tone: "muted" },
  ])

  // The Board, wide enough for each sentence on one card line.
  const board = await shown(
    status,
    3,
    false,
    (view) => createComponent(BoardView, { ...props(view), width: 300 }),
    300,
    30,
  )
  const card = lines(board.text).filter((line) => line.includes(OUTSIDE) || line.includes(EXTERNAL))
  expect(card).toHaveLength(2)
  expect(card[0]).toContain(`│ ${OUTSIDE}`)
  expect(card[1]).toContain(`│ ${EXTERNAL}`)
  expect(fgOf(board.spans, OUTSIDE)).toEqual(rgb(theme.warning))
  expect(fgOf(board.spans, EXTERNAL)).toEqual(rgb(theme.textMuted))
  expect(board.text).not.toContain("trust T1.1")
  // A narrow Board wraps the sentences at word boundaries; the trust command stays whole.
  const narrow = await shown(
    status,
    3,
    false,
    (view) => createComponent(BoardView, { ...props(view), width: 120 }),
    120,
    30,
  )
  expect(narrow.text).toContain("/task trust T9")
  expect(narrow.text).not.toContain("trust…")
  expect(narrow.text).not.toContain("trust T1.1")

  // The Peek of T1.2: its BUILDER heading holds the two sentences, one under the other.
  const peek = await shown(
    status,
    1,
    false,
    (view) => createComponent(Peek, { theme: () => theme, view, sessions: none, unit: "T1.2", width: 80, lines: 3 }),
    80,
    20,
  )
  const heading = lines(peek.text)
  const at = heading.findIndex((line) => line.includes(`BUILDER  ${OUTSIDE}`))
  expect(at).toBeGreaterThan(0)
  expect(heading[at + 1]).toContain(`║ ${" ".repeat(9)}${EXTERNAL}`)
  expect(fgOf(peek.spans, OUTSIDE)).toEqual(rgb(theme.warning))
  expect(fgOf(peek.spans, EXTERNAL)).toEqual(rgb(theme.textMuted))
  expect(peek.text).not.toContain("trust T1.1")
})

test("[UI5] the outside wait reads the same line on every design, and each design's shortcut bar has an outside-wait part", async () => {
  const status = statusOf()
  expect(outsideWaits(status)).toEqual(["T9"])
  for (const view of VIEWS) {
    const frame = await shown(status, view.design, view.expanded, view.node, view.width, view.height)
    const where = { name: view.name, expanded: view.expanded }
    // The Dock's collapsed strip names the command as a segment; the HUD's 40-cell panel wraps the line before it.
    const found =
      view.name === "Dock" && !view.expanded
        ? frame.text.includes("│ /task trust T9 │")
        : view.name === "HUD" && !view.expanded
          ? lines(frame.text).some(
              (line, index, all) =>
                line.includes("waiting on T9 (outside) — run") && all[index + 1]?.includes("/task trust T9"),
            )
          : frame.text.includes(OUTSIDE)
    expect({ ...where, found }).toEqual({ ...where, found: true })
    expect({ ...where, colour: fgOf(frame.spans, "/task trust T9") }).toEqual({ ...where, colour: rgb(theme.warning) })
    expect({ ...where, external: frame.text.includes("trust T1.1") }).toEqual({ ...where, external: false })
  }
  // Every design's shortcut bar: a part with the key "/task trust T9" and the label "outside wait", in the warning tone.
  for (let design = 1; design <= 7; design++) {
    const bar = await shown(
      status,
      design,
      false,
      (view) => createComponent(ShortcutBar, { ...props(view), width: 250 }),
      250,
      3,
    )
    expect({ design, part: bar.text.includes("/task trust T9 outside wait") }).toEqual({ design, part: true })
    expect({ design, colour: fgOf(bar.spans, "/task trust T9") }).toEqual({ design, colour: rgb(theme.warning) })
    expect({ design, external: bar.text.includes("trust T1.1") }).toEqual({ design, external: false })
  }
})

test("[UI5] the external wait never gets a trust command, in any view of any design", async () => {
  // T1.2 waits only on T1.1, outside the run: the Board and the Peek name it; nothing offers a trust command.
  const external = statusOf({ waits: ["T1.1"] })
  expect(outsideWaits(external)).toEqual([])
  const row = rows(external).find((item) => item.id === "T1.2")
  if (!row) throw new Error("no T1.2")
  expect(cardLines(external, row, "live", NOW, 45)).toEqual([{ text: EXTERNAL, tone: "muted" }])
  expect(builderHeading(external, "T1.2", "live", NOW)).toEqual([{ text: EXTERNAL, tone: "muted" }])
  const board = await shown(
    external,
    3,
    false,
    (view) => createComponent(BoardView, { ...props(view), width: 300 }),
    300,
    30,
  )
  expect(board.text).toContain(EXTERNAL)
  for (const view of VIEWS) {
    const frame = await shown(external, view.design, view.expanded, view.node, view.width, view.height)
    expect({ name: view.name, expanded: view.expanded, trust: frame.text.includes("/task trust") }).toEqual({
      name: view.name,
      expanded: view.expanded,
      trust: false,
    })
  }
  for (let design = 1; design <= 7; design++) {
    const bar = await shown(
      external,
      design,
      false,
      (view) => createComponent(ShortcutBar, { ...props(view), width: 250 }),
      250,
      3,
    )
    expect({ design, trust: bar.text.includes("/task trust"), part: bar.text.includes("outside wait") }).toEqual({
      design,
      trust: false,
      part: false,
    })
  }
  // The outside wait goes once T9 is trusted, and once the run has ended.
  expect(outsideWaits(statusOf({ outside: "trusted" }))).toEqual([])
  expect(outsideWaits(statusOf({ run: { state: "cancelled", tags: [...CLASS.run.cancelled.tags] } }))).toEqual([])
})

test("[UI5] the harness's own projection of a subtree run reads the same way: the outside wait with its command, the external waits without", async () => {
  // `/task task-formats/blend/release-notes.spec/.../T1.5-issue-links.task`: T1.5 is after T1.3, T1.4 and T9.
  const plan = await Effect.runPromise(loadPlan("release-notes.spec", "T1.5").pipe(Effect.provide(NodeServices.layer)))
  expect(plan.tasks.map((item) => item.id)).toEqual(["T1.5"])
  expect(plan.external).toEqual(["T1.3", "T1.4"])
  const projected = TaskStatus.project(plan, TaskEngineXState.initial(plan))
  const status = Option.getOrThrow(parse(JSON.stringify({ ...projected, run: { ...projected.run, aliveAt: NOW } })))
  expect(status.tasks["T1.5"]).toMatchObject({ waitingOn: ["T1.3", "T1.4", "T9"], waitingOnOutside: ["T9"] })
  expect(status.outside?.T9?.state).toBe("untrusted")
  const row = rows(status).find((item) => item.id === "T1.5")
  if (!row) throw new Error("no T1.5")
  expect(cardLines(status, row, "live", NOW, 45)).toEqual([
    { text: OUTSIDE, tone: "warning" },
    { text: "waiting on T1.3 (not in this run)", tone: "muted" },
    { text: "waiting on T1.4 (not in this run)", tone: "muted" },
    // T1.5's five obligations, none proved yet.
    { text: "proofs 0/5", tone: "text" },
  ])
  const board = await shown(
    status,
    3,
    false,
    (view) => createComponent(BoardView, { ...props(view), width: 300 }),
    300,
    30,
  )
  for (const text of [OUTSIDE, "waiting on T1.3 (not in this run)", "waiting on T1.4 (not in this run)"])
    expect({ text, shown: board.text.includes(text) }).toEqual({ text, shown: true })
  expect(board.text).not.toMatch(/trust T1\.[34]/)
  const ledger = await shown(
    status,
    1,
    false,
    (view) => createComponent(LedgerView, { ...props(view), width: 60 }),
    60,
    30,
  )
  expect(ledger.text).toContain(OUTSIDE)
  const bar = await shown(
    status,
    1,
    false,
    (view) => createComponent(ShortcutBar, { ...props(view), width: 250 }),
    250,
    3,
  )
  expect(bar.text).toContain("/task trust T9 outside wait")
})
