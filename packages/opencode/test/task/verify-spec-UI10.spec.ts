import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { Effect, FileSystem, Option, Result } from "effect"
import path from "path"
import { createComponent, type JSX } from "solid-js"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import type { Sessions } from "../../../tui/src/task-ui/peek"
import { parse, type Status } from "../../../tui/src/task-ui/store"
import { LedgerView } from "../../../tui/src/task-ui/designs/1-ledger"
import { DockView } from "../../../tui/src/task-ui/designs/2-dock"
import { HudView } from "../../../tui/src/task-ui/designs/6-hud"
import { TickerDialog } from "../../../tui/src/task-ui/designs/7-ticker"
import { Screen } from "../../../tui/src/task-ui/designs/screen"
import { settle, viewFor } from "../../../tui/test/task-ui/view"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, reject, trust, trustLeaf } from "./lib/machine"

// Scenario UI10 (spec task-harness-feedback, D20, EXPERIENCE "SCENARIOS list"; task T4.4): every expanded view lists
// the run's scenarios.
//
//   Given the release-notes status with thirteen scenarios, titles, one rejected scenario and one parked scenario
//   When each of the seven designs is expanded at 120 by 40 cells
//   Then the shared region lists S1 to S13 with glyph, id, state label and title
//   And the rejected scenario shows its reason under its entry
//   And after the run ends the parked scenario reads "not run"
//
// The status is the harness's own: facts of a release-notes run (T9 trusted, every task trusted, S1-S12 proved, S4
// rejected by its verifier with a long reason, every other runnable scenario trusted but S12, which is still under
// its verifier; S13 needs the outside precondition T8, which stays untrusted, so S13 is parked, as in RM13), folded
// by the engine (`TaskEngineXState`), projected by `TaskStatus.project` and written by `TaskStatus.write`; the ended
// status adds S12's trust, which ends the run. The task-ui side is the real code, imported by relative path: the
// store's `parse` on each written file, the real `taskView` actor (the tui test helper `viewFor`), and each design's
// real expanded view (the Ledger, the Dock, the full-screen Board, Matrix and Gantt, the HUD, the Ticker dialog)
// rendered with the opentui test renderer at 120 x 40. The region is read whole by scrolling its scroll box with the
// mouse wheel. The expected glyphs, labels and titles are written out here from the status vocabulary of EXPERIENCE
// and the scenario titles of the acceptance files, not taken from the code under test.

const it = testEffect(NodeServices.layer)

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }

const REJECTED =
  "the test asserts only that the heading exists and never checks that the groups under it come in the fixed order the format sets"
const START = 1_790_000_000_000

type Snapshot = ReturnType<typeof TaskEngineXState.initial>

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: Snapshot) =>
  list.reduce((snapshot, fact) => TaskEngineXState.apply(plan, snapshot, fact), from)

// The live status (S12 still under its verifier) and the ended one (S12 trusted), as the harness writes them, decoded
// by the task-ui. Every fact gets the next millisecond; the heartbeat is a second after the first fact.
const statuses = Effect.gen(function* () {
  const plan = yield* loadPlan("release-notes.spec")
  const f = facts(START)
  const runnable = Array.from({ length: 12 }, (_, index) => `S${index + 1}`)
  const live = fold(
    plan,
    [
      f.runStarted(),
      f.outside("T9"),
      ...trustLeaf(plan, f, "T1.1"),
      ...trustLeaf(plan, f, "T1.2"),
      ...trustLeaf(plan, f, "T1.3"),
      ...trustLeaf(plan, f, "T1.4"),
      ...trustLeaf(plan, f, "T1.5"),
      f.proved("T1", []),
      f.verified("T1", [trust("T1.e1")]),
      ...runnable.map((id) => f.scenarioProved(id, "passed")),
      ...runnable.slice(0, 11).map((id) => f.scenarioVerified(id === "S4" ? reject(id, REJECTED) : trust(id))),
    ],
    TaskEngineXState.initial(plan),
  )
  const ended = fold(plan, [f.scenarioVerified(trust("S12"))], live)
  const fs = yield* FileSystem.FileSystem
  const written = (snapshot: Snapshot) =>
    Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped()
      yield* TaskStatus.write(directory, TaskStatus.project(plan, snapshot), START + 1_000)
      return Option.getOrThrow(
        parse(yield* fs.readFileString(path.join(directory, ".opencode", "task", "status.json"))),
      )
    })
  return { plan, live: yield* written(live), ended: yield* written(ended) }
})

type View = Awaited<ReturnType<typeof viewFor>>["view"]

// The seven designs' expanded views, as the plugin draws them (the full-screen route for 3-5, the dialog for 7).
const DESIGNS: ReadonlyArray<{ name: string; design: number; node: (view: View) => JSX.Element }> = [
  {
    name: "Ledger",
    design: 1,
    node: (view) =>
      createComponent(LedgerView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 38 }),
  },
  {
    name: "Dock",
    design: 2,
    node: (view) =>
      createComponent(DockView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 120, height: 40 }),
  },
  ...[
    ["Board", 3],
    ["Matrix", 4],
    ["Gantt", 5],
  ].map(([name, design]) => ({
    name: String(name),
    design: Number(design),
    node: (view: View) =>
      createComponent(Screen, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 120, height: 40 }),
  })),
  {
    name: "HUD",
    design: 6,
    node: (view) => createComponent(HudView, { theme: () => theme, view, sessions: none, leader: "ctrl+x" }),
  },
  {
    name: "Ticker",
    design: 7,
    node: (view) => createComponent(TickerDialog, { theme: () => theme, view, sessions: none, leader: "ctrl+x" }),
  },
]

type App = Awaited<ReturnType<typeof testRender>>

const linesOf = (frame: string) => frame.split("\n").map((line) => line.trimEnd())

// The scroll boxes under a renderable.
const scrollBoxes = (node: Renderable): ReadonlyArray<ScrollBoxRenderable> => [
  ...(node instanceof ScrollBoxRenderable ? [node] : []),
  ...node.getChildren().flatMap(scrollBoxes),
]

// The rows of the frame inside `box`, cut to its cells.
const inBox = (frame: string, box: ScrollBoxRenderable) =>
  linesOf(frame)
    .slice(box.y, box.y + box.height)
    .map((line) => line.slice(box.x, box.x + box.width).trimEnd())

// The shared region's whole content, row by row: the scroll box that shows the SCENARIOS heading, scrolled with the
// mouse wheel until it stops moving, each row kept at its content offset.
const regionOf = async (app: App) => {
  const box = scrollBoxes(app.renderer.root).find((item) =>
    inBox(app.captureCharFrame(), item).some((line) => line.startsWith("SCENARIOS ")),
  )
  if (!box) throw new Error(`no shared region with a SCENARIOS list in:\n${app.captureCharFrame()}`)
  const content: string[] = []
  for (let tries = 0; tries < 40; tries++) {
    inBox(app.captureCharFrame(), box).forEach((line, index) => {
      content[box.scrollTop + index] = line
    })
    const top = box.scrollTop
    await app.mockMouse.scroll(box.x + 1, box.y + 1, "down")
    await app.renderOnce()
    if (box.scrollTop === top) break
  }
  return { width: box.width, height: box.height, y: box.y, content }
}

// A real view of `current` in `design`, T1.4 selected (so the Peek shows too), expanded or not; the actor takes each
// event on its own fiber, so wait until the view follows.
const viewOf = (current: Status, design: number, expanded: boolean) =>
  Effect.promise(async () => {
    const shown = await viewFor(current, { design })
    shown.view.select("T1.4")
    shown.view.setExpanded(expanded)
    for (let tries = 0; tries < 200; tries++) {
      await settle()
      if (shown.view.selected() === "T1.4" && shown.view.expanded() === expanded) break
    }
    return shown
  })

// The glyph and the state label of each scenario state this status holds (EXPERIENCE "State vocabulary").
const GLYPH: Readonly<Record<string, string>> = { trusted: "✓", rejected: "✗", pending: "·", waiting: "○" }

// The titles of S1-S13, read from the Scenario lines of release-notes.spec/acceptance/*.md.
const TITLES: Readonly<Record<string, string>> = {
  S1: "Release notes and next version for a known range",
  S2: "A conventional message is read into its parts",
  S3: "The next version follows the most significant change",
  S4: "Notes are grouped under fixed headings",
  S5: "Issue references become links when the key is known",
  S6: "The default range starts at the latest tag",
  S7: "A message that is not conventional is kept, not lost",
  S8: "Bad arguments stop the tool with exit code 2",
  S9: "A folder that is not a repository stops the tool with exit code 3",
  S10: "An invalid current version stops the tool with exit code 2",
  S11: "A machine without git stops the tool with exit code 4",
  S12: "Every commit in the range appears exactly once",
  S13: "The published package runs from the registry",
}
const IDS = Array.from({ length: 13 }, (_, index) => `S${index + 1}`)

// One region row cut into its column cells: a cell starts at the row's start or after the 3-cell column gap.
const ENTRY = /^(\S) (S\d+) /
const cellsOf = (row: string) => {
  const starts = [...row.matchAll(/(?:^|(?<= {3}))\S S\d+ /g)].map((match) => match.index ?? 0)
  return starts.map((x, index) => ({ x, text: row.slice(x, starts[index + 1] ?? row.length).trimEnd() }))
}

// The entries of the region, in reading order (column first), with where each one sits.
const entriesOf = (content: ReadonlyArray<string>) =>
  content
    .flatMap((row, y) => cellsOf(row ?? "").map((cell) => ({ ...cell, y })))
    .filter((cell) => ENTRY.test(cell.text))
    .toSorted((a, b) => a.x - b.x || a.y - b.y)

// A text cut to its column: the whole text, or its start with … (a title keeps at least 12 cells).
const cutOf = (shown: string, full: string, least: number) =>
  shown === full || (shown.endsWith("…") && shown.length >= least && full.startsWith(shown.slice(0, -1)))

// Every design expanded over `current`, rendered at 120 x 40: the region's rows, read whole.
const regions = (current: Status) =>
  Effect.gen(function* () {
    const result: Array<{ name: string; width: number; content: ReadonlyArray<string> }> = []
    for (const item of DESIGNS) {
      const { view, dispose } = yield* viewOf(current, item.design, true)
      expect({ design: item.name, expanded: view.expanded() }).toEqual({ design: item.name, expanded: true })
      const app = yield* Effect.promise(async () => {
        const app = await testRender(() => item.node(view), { width: 120, height: 40 })
        await app.renderOnce()
        return app
      })
      const region = yield* Effect.promise(() => regionOf(app))
      app.renderer.destroy()
      dispose()
      result.push({ name: item.name, width: region.width, content: region.content })
    }
    return result
  })

it.live(
  "[UI10] the given status: thirteen scenarios with titles, S4 rejected with its reason, S13 parked on the outside precondition T8",
  () =>
    Effect.gen(function* () {
      const { live, ended } = yield* statuses
      for (const current of [live, ended]) {
        expect(Object.keys(current.scenarios).toSorted()).toEqual(IDS.toSorted())
        expect(Object.fromEntries(IDS.map((id) => [id, current.scenarios[id]?.title]))).toEqual(TITLES)
        expect(current.scenarios["S4"]).toMatchObject({
          state: "rejected",
          reason: REJECTED,
          tags: ["ended", "stopped"],
        })
        expect(current.scenarios["S13"]).toMatchObject({
          state: "waiting",
          tags: ["waiting"],
          waitingOn: ["T8"],
          waitingOnOutside: ["T8"],
        })
      }
      expect(live.run.tags).toEqual(["active"])
      expect(live.scenarios["S12"]?.state).toBe("pending")
      // S12's trust ends the run; S13 never ran.
      expect(ended.run.tags).toContain("ended")
      expect(ended.scenarios["S12"]?.state).toBe("trusted")
      expect((ended.run.reason ?? "").split("\n")).toContain("not run: S13 waits on T8")
    }),
  60_000,
)

it.live(
  "[UI10] each of the seven designs expanded at 120 x 40: the shared region lists S1 to S13 with glyph, id, state label and title, and S4's reason under its entry",
  () =>
    Effect.gen(function* () {
      const { live } = yield* statuses
      for (const region of yield* regions(live)) {
        const design = region.name
        // The heading counts the scenarios and the trusted ones.
        expect({ design, heading: region.content.find((row) => row?.startsWith("SCENARIOS ")) }).toEqual({
          design,
          heading: "SCENARIOS 13 · 10/13 trusted",
        })
        // One entry per scenario, S1 to S13 in natural order, column first.
        const entries = entriesOf(region.content)
        expect({ design, ids: entries.map((entry) => entry.text.match(ENTRY)?.[2]) }).toEqual({ design, ids: IDS })
        for (const entry of entries) {
          const id = entry.text.match(ENTRY)?.[2] ?? ""
          const scenario = live.scenarios[id]
          const state = scenario?.state ?? ""
          // The glyph, the id, the state label (a waiting scenario's label names its wait), " · ", then the title.
          const label = state === "waiting" ? "waiting on T8 (outside)" : state
          const [head = "", title = ""] = entry.text.split(" · ")
          expect({ design, id, glyph: entry.text.slice(0, 1) }).toEqual({ design, id, glyph: GLYPH[state] })
          expect({
            design,
            head,
            ok: cutOf(head, `${GLYPH[state]} ${id} ${label}`, `${GLYPH[state]} ${id} waiting`.length),
          }).toEqual({
            design,
            head,
            ok: true,
          })
          expect({ design, id, title, ok: cutOf(title, TITLES[id] ?? "", 12) }).toEqual({ design, id, title, ok: true })
        }
        // S4's reason sits under its entry, 4 cells in, in at most 2 lines: the whole reason or its start cut with …,
        // and S5 follows it in the same column.
        const s4 = entries.find((entry) => entry.text.startsWith("✗ S4 rejected"))
        if (!s4) throw new Error(`${design}: no S4 entry`)
        const under = [1, 2, 3].map(
          (step) => (region.content[s4.y + step] ?? "").slice(s4.x).split(/ {3,}(?=\S S\d+ )/)[0],
        )
        const reasonRows = under.filter((row) => row.startsWith("    ") && !ENTRY.test(row))
        expect({ design, rows: reasonRows.length >= 1 && reasonRows.length <= 2 }).toEqual({ design, rows: true })
        expect({ design, next: under[reasonRows.length]?.startsWith("✓ S5 trusted") }).toEqual({ design, next: true })
        const reason = reasonRows.map((row) => row.trim()).join(" ")
        expect({ design, reason, ok: cutOf(reason, REJECTED, 4) }).toEqual({ design, reason, ok: true })
        expect({ design, words: reason.split(" ").length >= 6 }).toEqual({ design, words: true })
        // No other entry has a line under it.
        const lone = entries.filter(
          (entry) => entry !== s4 && (region.content[entry.y + 1] ?? "").slice(entry.x).startsWith("    "),
        )
        expect({ design, lone: lone.map((entry) => entry.text) }).toEqual({ design, lone: [] })
      }
    }),
  120_000,
)

it.live(
  "[UI10] after the run ends the parked scenario reads not run in each of the seven designs; while the run is live it reads its wait",
  () =>
    Effect.gen(function* () {
      const { live, ended } = yield* statuses
      const s13 = (content: ReadonlyArray<string>) =>
        entriesOf(content).find((entry) => entry.text.startsWith("○ S13 "))?.text ?? ""
      for (const region of yield* regions(live)) {
        const entry = s13(region.content)
        expect({ design: region.name, entry, live: entry.startsWith("○ S13 waiting on T8") }).toEqual({
          design: region.name,
          entry,
          live: true,
        })
        expect(entry).not.toContain("not run")
      }
      for (const region of yield* regions(ended)) {
        const entry = s13(region.content)
        expect({ design: region.name, entry, ended: entry.startsWith("○ S13 not run") }).toEqual({
          design: region.name,
          entry,
          ended: true,
        })
        // The title still follows; the heading now counts S12 trusted too.
        expect(cutOf(entry.split(" · ")[1] ?? "", TITLES["S13"] ?? "", 12)).toBe(true)
        expect(region.content.find((row) => row?.startsWith("SCENARIOS "))).toBe("SCENARIOS 13 · 11/13 trusted")
        // S4's reason still sits under its entry.
        const s4 = entriesOf(region.content).find((entry) => entry.text.startsWith("✗ S4 rejected"))
        expect((region.content[(s4?.y ?? -2) + 1] ?? "").slice(s4?.x ?? 0).startsWith("    the test asserts")).toBe(
          true,
        )
      }
    }),
  120_000,
)
