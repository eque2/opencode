import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Option, Result } from "effect"
import path from "path"
import type { CapturedFrame, RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createComponent, createRoot, type JSX } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, observed, trust, trustLeaf } from "./lib/machine"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import type { Sessions } from "../../../tui/src/task-ui/peek"
import { parse, type Status } from "../../../tui/src/task-ui/store"
import { LedgerView } from "../../../tui/src/task-ui/designs/1-ledger"
import { endNotice, registerTicker } from "../../../tui/src/task-ui/designs/7-ticker"
import { Screen } from "../../../tui/src/task-ui/designs/screen"
import { settle, viewFor } from "../../../tui/test/task-ui/view"

// Scenario UI19 (spec task-harness-feedback, AD-16 over EXPERIENCE, spec.md "Known conflicts" 5; task T4.8): the
// not-run line of a done run is muted and raises no notification.
//
//   Given a done status whose reason is "not run: S13 waits on T8"
//   When the Ledger, the full-screen header and the Ticker render
//   Then the run reason line uses the muted tone, and the Ticker raises no notification for it
//   And a run with the stopped tag shows its reason line in the error tone
//
// Every status is the harness's own: facts of the release-notes plan (loaded by the real loader) folded by the
// engine, projected by `TaskStatus.project`, written by `TaskStatus.write`, and read back with the task-ui's `parse`.
// The done run is the one of RM13: T9 trusted, T8 not, every task trusted, S1 to S12 trusted, so S13 is parked and
// the run ends done with "not run: S13 waits on T8". The stopped run is the observed run (T1.4 budget exhausted)
// cancelled by the user. Two controls show that the Ticker's notification is real: a done run with T8 trusted (no
// reason) and the stopped run each raise one. The task-ui is the real code, imported by relative path from
// packages/tui; each view renders on a real taskView actor (the tui test helper `viewFor`) with the opentui test
// renderer, through `createComponent` (this file is .spec.ts, so it has no JSX).

const it = testEffect(NodeServices.layer)

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }
/** The heartbeat the status writer stamps. */
const ALIVE_AT = 1_791_000_000_000
const NOT_RUN = "not run: S13 waits on T8"
const RUNNABLE = Array.from({ length: 12 }, (_, index) => `S${index + 1}`)

/** A release-notes run that ends done: T9 trusted (and T8 when `withT8`), every task trusted, each scenario trusted. */
const doneRun =
  (withT8: boolean) =>
  (plan: Plan): ReadonlyArray<Fact> => {
    const f = facts()
    const scenarios = withT8 ? [...RUNNABLE, "S13"] : RUNNABLE
    return [
      f.runStarted(),
      f.outside("T9"),
      ...(withT8 ? [f.outside("T8")] : []),
      ...["T1.1", "T1.2", "T1.3", "T1.4", "T1.5"].flatMap((id) => trustLeaf(plan, f, id)),
      f.proved("T1", []),
      f.verified("T1", [trust("T1.e1")]),
      ...scenarios.map((id) => f.scenarioProved(id, "passed")),
      ...scenarios.map((id) => f.scenarioVerified(trust(id))),
    ]
  }

/** The observed run (T1.4 budget exhausted after three attempts), then cancelled by the user. */
const stoppedRun = (plan: Plan): ReadonlyArray<Fact> => {
  const f = facts()
  return [...observed(plan, f), f.cancelled("stopped by the user")]
}

/** The status file the harness writes after `list`, as the task-ui decodes it. */
const statusAfter = Effect.fnUntraced(function* (list: (plan: Plan) => ReadonlyArray<Fact>) {
  const plan = yield* loadPlan("release-notes.spec")
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

/** A real taskView actor over `status` (and the statuses of its next reads), disposed with the test's scope. */
const viewOf = (status: Status, design: number, later: ReadonlyArray<Status> = []) =>
  Effect.acquireRelease(
    Effect.promise(() => viewFor(status, { design, later })),
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

/** The colour of the first span that holds `text`, and the row it is on. */
const spanOf = (captured: CapturedFrame, text: string) => {
  const row = captured.lines.findIndex((line) => line.spans.some((span) => span.text.includes(text)))
  const span = captured.lines[row]?.spans.find((item) => item.text.includes(text))
  return { row, fg: rgb(span?.fg) }
}

/** The collapsed Ledger, 38 cells wide, as in the sidebar. */
const ledger = (status: Status) =>
  Effect.gen(function* () {
    const { view } = yield* viewOf(status, 1)
    return yield* render(
      () => createComponent(LedgerView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 38 }),
      120,
      60,
    )
  })

/** The full-screen Board at 120 × 50: its header is the rows above the board's column headings. */
const fullScreen = (status: Status) =>
  Effect.gen(function* () {
    const { view } = yield* viewOf(status, 3)
    const shown = yield* render(
      () =>
        createComponent(Screen, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 120, height: 50 }),
      120,
      50,
    )
    const board = shown.text.split("\n").findIndex((line) => line.includes("WAITING"))
    return { ...shown, board }
  })

/** What the Ticker raises through the host while its view reads `before`, then `after`. */
const ticker = (before: Status, after: Status) =>
  Effect.gen(function* () {
    const toasts: Array<{ variant?: string; title?: string; message: string }> = []
    const notices: Array<{ title: string; message: string }> = []
    const made = yield* viewOf(before, 7, [after])
    const host = {
      ui: {
        toast: (toast: (typeof toasts)[number]) => void toasts.push(toast),
        dialog: { replace: () => {}, setSize: () => {}, clear: () => {} },
      },
      attention: { notify: async (notice: (typeof notices)[number]) => void notices.push(notice) },
      keymap: { registerLayer: () => () => {} },
    }
    const stop = createRoot((dispose) => {
      registerTicker({
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- registerTicker reads only the ui, attention and keymap members above
        api: host as unknown as TuiPluginApi,
        view: made.view,
        sessions: none,
        theme: () => theme,
        active: () => true,
        leader: "ctrl+x",
        root: () => "",
        owns: () => true,
        harness: () => [],
        logs: () => [],
      })
      return dispose
    })
    yield* Effect.promise(() => made.advance(1_000))
    for (let tries = 0; tries < 200 && made.view.status()?.run.state !== after.run.state; tries++)
      yield* Effect.promise(settle)
    yield* Effect.promise(settle)
    stop()
    expect(made.view.status()?.run).toEqual(after.run)
    return { toasts, notices }
  })

it.live("[UI19] the harness ends the run done with the reason line 'not run: S13 waits on T8'", () =>
  Effect.gen(function* () {
    const done = yield* statusAfter(doneRun(false))
    expect(done.run.state).toBe("done")
    expect(done.run.tags).toEqual(["ended"])
    expect(done.run.reason).toBe(NOT_RUN)
    expect(done.scenarios.S13).toMatchObject({ state: "waiting", waitingOnOutside: ["T8"] })
    // One verdict earlier the run has not ended.
    const before = yield* statusAfter((plan) => doneRun(false)(plan).slice(0, -1))
    expect(before.run.tags).toEqual(["active"])
  }),
)

it.live(
  "[UI19] the Ledger and the full-screen header draw the done run's not-run line in the muted tone",
  () =>
    Effect.gen(function* () {
      const done = yield* statusAfter(doneRun(false))
      const side = yield* ledger(done)
      expect(side.text.split("\n").map((line) => line.trimEnd())).toContain(NOT_RUN)
      expect(spanOf(side.spans, NOT_RUN).fg).toEqual(rgb(theme.textMuted))
      const header = yield* fullScreen(done)
      const line = spanOf(header.spans, NOT_RUN)
      // The line is in the header, above the board, in the muted tone.
      expect(line.row).toBeGreaterThan(0)
      expect(line.row).toBeLessThan(header.board)
      expect(line.fg).toEqual(rgb(theme.textMuted))
      // Muted is not the error or the warning tone: the line does not read as a stop or a warning.
      for (const fg of [side.spans, header.spans].map((spans) => spanOf(spans, NOT_RUN).fg)) {
        expect(fg).not.toEqual(rgb(theme.error))
        expect(fg).not.toEqual(rgb(theme.warning))
      }
    }),
  120_000,
)

it.live(
  "[UI19] the Ticker raises no notification for the done run's not-run line; a clean done run and a stopped run each raise one",
  () =>
    Effect.gen(function* () {
      const before = yield* statusAfter((plan) => doneRun(false)(plan).slice(0, -1))
      const done = yield* statusAfter(doneRun(false))
      expect(endNotice(before, done)).toEqual(Option.none())
      const quiet = yield* ticker(before, done)
      expect(quiet.notices).toEqual([])
      expect(quiet.toasts.filter((toast) => toast.message.includes("not run"))).toEqual([])

      // Control: the same run with T8 trusted ends done with no reason, and the Ticker notifies its end.
      const cleanBefore = yield* statusAfter((plan) => doneRun(true)(plan).slice(0, -1))
      const clean = yield* statusAfter(doneRun(true))
      expect(clean.run).toMatchObject({ state: "done", tags: ["ended"] })
      expect(clean.run.reason ?? undefined).toBeUndefined()
      expect((yield* ticker(cleanBefore, clean)).notices).toEqual([{ title: "In the Flow", message: "Run done" }])

      // Control: the stopped run notifies its end with its reason line.
      const running = yield* statusAfter(observed)
      const stopped = yield* statusAfter(stoppedRun)
      const loud = yield* ticker(running, stopped)
      expect(loud.notices).toEqual([
        { title: "In the Flow", message: "Run budget exhausted: T1.4 budget exhausted (+3 more)" },
      ])
    }),
  150_000,
)

it.live(
  "[UI19] a run with the stopped tag shows its reason line in the error tone in the Ledger and the full-screen header",
  () =>
    Effect.gen(function* () {
      const stopped = yield* statusAfter(stoppedRun)
      expect(stopped.run.tags).toContain("stopped")
      const lines = (stopped.run.reason ?? "").split("\n").filter(Boolean)
      expect(lines.length).toBeGreaterThan(1)
      // The run reason line: the first reason line, then how many more there are.
      const text = `${lines[0]} (+${lines.length - 1} more)`
      expect(text).toBe("T1.4 budget exhausted (+3 more)")
      const header = yield* fullScreen(stopped)
      const line = spanOf(header.spans, text)
      expect(line.row).toBeGreaterThan(0)
      expect(line.row).toBeLessThan(header.board)
      expect(line.fg).toEqual(rgb(theme.error))
      // The sidebar's 38 cells cut the line; its start shows in the error tone.
      const side = yield* ledger(stopped)
      const start = text.slice(0, 30)
      expect(side.text).toContain(start)
      expect(spanOf(side.spans, start).fg).toEqual(rgb(theme.error))
    }),
  120_000,
)
