import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Option, Result } from "effect"
import path from "path"
import type { CapturedFrame, RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createComponent, type JSX } from "solid-js"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { exhaustLeaf, facts, loadPlan, obligationsOf, trust, trustLeaf } from "./lib/machine"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import { Peek, type Sessions } from "../../../tui/src/task-ui/peek"
import { parse, tagged, type Status } from "../../../tui/src/task-ui/store"
import { ShortcutBar } from "../../../tui/src/task-ui/ui"
import { WatchBand, chooseWatch } from "../../../tui/src/task-ui/watch"
import { LedgerView } from "../../../tui/src/task-ui/designs/1-ledger"
import { DockView } from "../../../tui/src/task-ui/designs/2-dock"
import { HudView } from "../../../tui/src/task-ui/designs/6-hud"
import { Screen } from "../../../tui/src/task-ui/designs/screen"
import { settle, viewFor } from "../../../tui/test/task-ui/view"

// Scenario UI21 (spec task-harness-feedback, D19, D20, D21, EXPERIENCE "Stopped count", "Watch band", "Peek BUILDER
// heading", "SCENARIOS list"; tasks T4.3, T4.4, T4.5, T4.8): the stopped count, the idle watch band, the
// did-not-start Peek and the empty scenario list read as set.
//
//   Given a status with 2 stopped tasks, a run waiting only on T9, a cancelled task with no start time, and no scenarios
//   When the designs, the watch band and the Peek render
//   Then each trusted count ends with "· 2 stopped" in the error tone, and shows nothing at 0
//   And the watch band reads "Nothing is running. The run is waiting on T9 (outside) — run /task trust T9."
//   And the Peek reads "no builder session: the task did not start"
//   And the SCENARIOS heading reads "SCENARIOS none in this run"
//
// The harness never writes all four parts of the Given at once: a run that waits on T9 has not ended, and a cancelled
// task means it has. So each part is the harness's own status for it, all written by the real code (facts folded by
// the engine, projected by `TaskStatus.project`, written by `TaskStatus.write`, read back with the task-ui's `parse`):
//   W  release-notes, T9 untrusted, T1.1 to T1.4 trusted: no task in work, T1.5 waits on T9;
//   X  W, then the user cancels the run: T1.5 and T1 cancelled with no start time, so 2 stopped tasks;
//   Z  release-notes with T8 and T9 trusted and every task and scenario trusted: 0 stopped;
//   C  example-cascade.spec, a plan with no scenarios: T1.1's proof fails with its budget of 1.
// The task-ui is the real code, imported by relative path from packages/tui; each view renders on a real taskView
// actor (the tui test helper `viewFor`) with the opentui test renderer, through `createComponent` (this file is
// .spec.ts, so it has no JSX).

const it = testEffect(NodeServices.layer)

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }
/** The heartbeat the status writer stamps. */
const ALIVE_AT = 1_791_000_000_000
const IDLE = "Nothing is running. The run is waiting on T9 (outside) — run /task trust T9."
const DID_NOT_START = "no builder session: the task did not start"
const NO_SCENARIOS = "SCENARIOS none in this run"

/** W: release-notes with T9 untrusted; T1.1 to T1.4 trusted, so T1.5 waits on T9 and nothing is in work. */
const waitingOnT9 = (plan: Plan, f = facts()): ReadonlyArray<Fact> => [
  f.runStarted(),
  ...["T1.1", "T1.2", "T1.3", "T1.4"].flatMap((id) => trustLeaf(plan, f, id)),
]

/** X: W, then the user cancels the run. */
const cancelled = (plan: Plan): ReadonlyArray<Fact> => {
  const f = facts()
  return [...waitingOnT9(plan, f), f.cancelled("stopped by the user")]
}

/** Z: release-notes with both outside preconditions trusted, every task trusted and every scenario trusted. */
const allTrusted = (plan: Plan): ReadonlyArray<Fact> => {
  const f = facts()
  const scenarios = plan.scenarios.map((scenario) => scenario.id)
  return [
    f.runStarted(),
    f.outside("T8"),
    f.outside("T9"),
    ...["T1.1", "T1.2", "T1.3", "T1.4", "T1.5"].flatMap((id) => trustLeaf(plan, f, id)),
    f.proved("T1", []),
    f.verified("T1", [trust("T1.e1")]),
    ...scenarios.map((id) => f.scenarioProved(id, "passed")),
    ...scenarios.map((id) => f.scenarioVerified(trust(id))),
  ]
}

/** C: example-cascade.spec; T1.3 trusted, and T1.1's proof fails on its one attempt. */
const cascade = (plan: Plan): ReadonlyArray<Fact> => {
  const f = facts()
  return [f.runStarted(), ...trustLeaf(plan, f, "T1.3"), ...exhaustLeaf(f, "T1.1", obligationsOf(plan, "T1.1")[0], 1)]
}

/** The status file the harness writes after `list` for the plan of `spec`, as the task-ui decodes it. */
const statusAfter = Effect.fnUntraced(function* (
  list: (plan: Plan) => ReadonlyArray<Fact>,
  spec = "release-notes.spec",
) {
  const plan = yield* loadPlan(spec)
  const snapshot = list(plan).reduce(
    (each, fact) => TaskEngineXState.apply(plan, each, fact),
    TaskEngineXState.initial(plan),
  )
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  yield* TaskStatus.write(directory, TaskStatus.project(plan, snapshot), ALIVE_AT)
  const text = yield* fs.readFileString(path.join(directory, ".opencode", "task", "status.json"))
  return Option.getOrThrow(parse(text))
})

type View = Awaited<ReturnType<typeof viewFor>>["view"]

/** A real taskView actor over `status`, disposed with the test's scope. */
const viewOf = (status: Status, design: number) =>
  Effect.acquireRelease(
    Effect.promise(() => viewFor(status, { design })),
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
const linesOf = (text: string) => text.split("\n").map((line) => line.trimEnd())

/** The colours of every span that holds `text`. */
const colorsOf = (captured: CapturedFrame, text: string) =>
  captured.lines
    .flatMap((line) => line.spans)
    .filter((span) => span.text.includes(text))
    .map((span) => rgb(span.fg))

/** Every view that shows a trusted count, each with the design it belongs to and its frame size. */
const COUNTS: ReadonlyArray<{
  readonly name: string
  readonly design: number
  readonly width: number
  readonly height: number
  readonly node: (view: View) => JSX.Element
}> = [
  {
    name: "Ledger",
    design: 1,
    width: 120,
    height: 40,
    node: (view) =>
      createComponent(LedgerView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 38 }),
  },
  {
    name: "Dock strip",
    design: 2,
    width: 200,
    height: 10,
    node: (view) =>
      createComponent(DockView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 200, height: 10 }),
  },
  ...[3, 4, 5].map((design) => ({
    name: `full-screen header ${["Board", "Matrix", "Gantt"][design - 3]}`,
    design,
    width: 140,
    height: 60,
    node: (view: View) =>
      createComponent(Screen, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 140, height: 60 }),
  })),
  {
    name: "HUD",
    design: 6,
    width: 80,
    height: 20,
    node: (view) => createComponent(HudView, { theme: () => theme, view, sessions: none, leader: "ctrl+x" }),
  },
  {
    name: "Ticker line (shortcut bar)",
    design: 7,
    width: 200,
    height: 4,
    node: (view) =>
      createComponent(ShortcutBar, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 200 }),
  },
]

it.live(
  "[UI21] the harness's statuses: 2 stopped tasks, a run waiting only on T9, a cancelled task with no start, no scenarios",
  () =>
    Effect.gen(function* () {
      const waiting = yield* statusAfter(waitingOnT9)
      expect(waiting.run.tags).toEqual(["active"])
      expect(Object.entries(waiting.tasks).filter(([, task]) => tagged(task, "active"))).toEqual([])
      expect(waiting.tasks["T1.5"]).toMatchObject({ state: "waiting", waitingOn: ["T9"], waitingOnOutside: ["T9"] })
      expect(waiting.outside?.T9?.state).toBe("untrusted")
      const stopped = yield* statusAfter(cancelled)
      expect(
        Object.entries(stopped.tasks)
          .filter(([, task]) => tagged(task, "stopped"))
          .map(([id]) => id)
          .toSorted(),
      ).toEqual(["T1", "T1.5"])
      expect(stopped.tasks["T1.5"]?.state).toBe("cancelled")
      expect(stopped.tasks["T1.5"]?.startedAt).toBeUndefined()
      expect(stopped.tasks["T1.5"]?.endedAt).toBeNumber()
      const clean = yield* statusAfter(allTrusted)
      expect(Object.values(clean.tasks).filter((task) => tagged(task, "stopped"))).toEqual([])
      const empty = yield* statusAfter(cascade, "example-cascade.spec")
      expect(empty.scenarios).toEqual({})
    }),
)

it.live(
  "[UI21] each trusted count ends with · 2 stopped in the error tone, and shows nothing at 0",
  () =>
    Effect.gen(function* () {
      const stopped = yield* statusAfter(cancelled)
      const clean = yield* statusAfter(allTrusted)
      for (const place of COUNTS) {
        const { view } = yield* viewOf(stopped, place.design)
        const shown = yield* render(() => place.node(view), place.width, place.height)
        const row = linesOf(shown.text).find((line) => line.includes("4/6 trusted")) ?? ""
        // The count, then the stopped count: right after it, or as the bar's next part (two cells on).
        expect({ place: place.name, ends: /4\/6 trusted {0,2}· 2 stopped/.test(row) }).toEqual({
          place: place.name,
          ends: true,
        })
        const colors = colorsOf(shown.spans, "· 2 stopped")
        expect({ place: place.name, colors }).toEqual({ place: place.name, colors: [rgb(theme.error)] })
        // At 0 the trusted count stands alone.
        const quiet = yield* viewOf(clean, place.design)
        const zero = yield* render(() => place.node(quiet.view), place.width, place.height)
        expect({
          place: place.name,
          trusted: zero.text.includes("6/6 trusted"),
          stopped: zero.text.includes("stopped"),
        }).toEqual({ place: place.name, trusted: true, stopped: false })
      }
    }),
  180_000,
)

it.live("[UI21] the watch band reads that nothing is running and gives the trust command for T9", () =>
  Effect.gen(function* () {
    const waiting = yield* statusAfter(waitingOnT9)
    const { view } = yield* viewOf(waiting, 1)
    yield* Effect.promise(settle)
    const watch = chooseWatch({ status: waiting, task: view.selected(), children: [], loaded: () => true })
    expect(watch.band).toEqual({ kind: "note", text: IDLE })
    const shown = yield* render(
      () => createComponent(WatchBand, { theme: () => theme, watch, width: 140, live: view.live() }),
      140,
      4,
    )
    // The band has a 1-cell left padding.
    expect(linesOf(shown.text)[0]?.trim()).toBe(`◆ In the Flow ${IDLE} · watch only`)
  }),
)

it.live(
  "[UI21] the Peek of a cancelled task with no start time reads that the task did not start",
  () =>
    Effect.gen(function* () {
      const stopped = yield* statusAfter(cancelled)
      const { view } = yield* viewOf(stopped, 3)
      view.select("T1.5")
      yield* Effect.promise(settle)
      expect(view.selected()).toBe("T1.5")
      const peek = yield* render(
        () => createComponent(Peek, { theme: () => theme, view, sessions: none, unit: "T1.5", width: 72, lines: 4 }),
        80,
        30,
      )
      const lines = linesOf(peek.text)
      expect(lines.some((line) => line.includes(DID_NOT_START))).toBe(true)
      expect(lines.some((line) => line.includes("no verifier session: the task did not start"))).toBe(true)
      // The full-screen Board shows it in the Peek beside the board.
      const screen = yield* render(
        () =>
          createComponent(Screen, {
            theme: () => theme,
            view,
            sessions: none,
            leader: "ctrl+x",
            width: 160,
            height: 60,
          }),
        160,
        60,
      )
      expect(screen.text).toContain("T1.5 details")
      expect(screen.text).toContain(DID_NOT_START)
    }),
  120_000,
)

it.live(
  "[UI21] with no scenarios in the run, the SCENARIOS heading reads SCENARIOS none in this run",
  () =>
    Effect.gen(function* () {
      const empty = yield* statusAfter(cascade, "example-cascade.spec")
      const { view } = yield* viewOf(empty, 3)
      view.setExpanded(true)
      yield* Effect.promise(settle)
      for (const node of [
        () =>
          createComponent(Screen, {
            theme: () => theme,
            view,
            sessions: none,
            leader: "ctrl+x",
            width: 120,
            height: 50,
          }),
        () => createComponent(LedgerView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 38 }),
      ]) {
        const shown = yield* render(node, 120, 50)
        // The region's heading, from where it starts to the end of its row (a Peek can share the row on its left).
        expect(
          linesOf(shown.text)
            .filter((line) => line.includes("SCENARIOS"))
            .map((line) => line.slice(line.indexOf("SCENARIOS"))),
        ).toEqual([NO_SCENARIOS])
      }
      // A run with scenarios has a count instead.
      const waiting = yield* statusAfter(waitingOnT9)
      const other = yield* viewOf(waiting, 3)
      const counted = yield* render(
        () =>
          createComponent(Screen, {
            theme: () => theme,
            view: other.view,
            sessions: none,
            leader: "ctrl+x",
            width: 120,
            height: 50,
          }),
        120,
        50,
      )
      expect(counted.text).toContain("SCENARIOS 13 · 0/13 trusted")
      expect(counted.text).not.toContain(NO_SCENARIOS)
    }),
  120_000,
)
