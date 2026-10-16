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
import { loadPlan, observed } from "./lib/machine"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import type { Sessions } from "../../../tui/src/task-ui/peek"
import { DISPLAY, glyph, parse, tagged, type Status } from "../../../tui/src/task-ui/store"
import { LedgerView } from "../../../tui/src/task-ui/designs/1-ledger"
import { DockView } from "../../../tui/src/task-ui/designs/2-dock"
import { HudView } from "../../../tui/src/task-ui/designs/6-hud"
import { TickerDialog, registerTicker, tickerToasts } from "../../../tui/src/task-ui/designs/7-ticker"
import { Screen } from "../../../tui/src/task-ui/designs/screen"
import { settle, viewFor } from "../../../tui/test/task-ui/view"

// Scenario UI18 (spec task-harness-feedback, D16, AD-16, EXPERIENCE "State vocabulary"; tasks T4.2, T4.6, T4.8):
// a blocked unit has its own glyph and tone.
//
//   Given a status with a blocked task and a blocked scenario
//   When the designs render
//   Then the blocked units show ⊖ in the warning tone
//   And the Matrix legend lists "⊖ blocked"
//   And a Ticker toast for a task that turns blocked shows its reason
//
// The status is the harness's own: the observed release-notes facts (T1.1 to T1.3 trusted, T1.4 budget exhausted after
// three attempts) folded by the engine, projected by `TaskStatus.project`, written by `TaskStatus.write` to a temporary
// directory, and read back with the task-ui's `parse`. In it T1 and T1.5 are blocked by T1.4, and so are the
// scenarios S1, S5, S6 and S8 to S11 and S13. The task-ui is the real code, imported by relative path from
// packages/tui; each design renders on a real taskView actor (the tui test helper `viewFor`), with the opentui test
// renderer. This file is .spec.ts, so components render through `createComponent`, which is what JSX compiles to.

const it = testEffect(NodeServices.layer)

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }
/** The heartbeat the status writer stamps. */
const ALIVE_AT = 1_791_000_000_000
const REASON = "blocked by T1.4: budget exhausted"

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

/** Every span of a frame that draws ⊖ before a task or scenario id, trimmed, with its colour. */
const blockedSpans = (captured: CapturedFrame) =>
  captured.lines
    .flatMap((line) => line.spans)
    .filter((span) => /⊖ [TS]\d/.test(span.text))
    .map((span) => ({ text: span.text.trim(), fg: rgb(span.fg) }))

/** Each design, expanded, with T1.5 selected: the design's own lines and its shared region. */
const DESIGNS: ReadonlyArray<{
  readonly id: number
  readonly name: string
  readonly width: number
  readonly height: number
  readonly node: (view: Awaited<ReturnType<typeof viewFor>>["view"]) => JSX.Element
}> = [
  {
    id: 1,
    name: "Ledger",
    width: 120,
    height: 60,
    node: (view) =>
      createComponent(LedgerView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 38 }),
  },
  {
    id: 2,
    name: "Dock",
    width: 140,
    height: 60,
    node: (view) =>
      createComponent(DockView, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 140, height: 60 }),
  },
  ...[3, 4, 5].map((id) => ({
    id,
    name: ["Board", "Matrix", "Gantt"][id - 3],
    width: 120,
    height: 80,
    node: (view: Awaited<ReturnType<typeof viewFor>>["view"]) =>
      createComponent(Screen, { theme: () => theme, view, sessions: none, leader: "ctrl+x", width: 120, height: 80 }),
  })),
  {
    id: 6,
    name: "HUD",
    width: 80,
    height: 60,
    node: (view) => createComponent(HudView, { theme: () => theme, view, sessions: none, leader: "ctrl+x" }),
  },
  {
    id: 7,
    name: "Ticker",
    width: 120,
    height: 60,
    node: (view) => createComponent(TickerDialog, { theme: () => theme, view, sessions: none, leader: "ctrl+x" }),
  },
]

it.live("[UI18] the harness's status has a blocked task and a blocked scenario, and ⊖ is the warning tone's own", () =>
  Effect.gen(function* () {
    const status = yield* statusAfter(observed)
    // The blocked task and the blocked scenario, by their tags and causes, as the harness wrote them.
    for (const id of ["T1", "T1.5"]) {
      expect(status.tasks[id]).toMatchObject({ state: "blocked", reason: REASON })
      expect(tagged(status.tasks[id], "blocked")).toBe(true)
    }
    expect(status.scenarios.S1).toMatchObject({ state: "blocked", reason: REASON })
    expect(tagged(status.scenarios.S1, "blocked")).toBe(true)
    // The display table gives blocked its own glyph, unlike waiting's ○, in the warning tone.
    expect(DISPLAY.blocked).toMatchObject({ glyph: "⊖", tone: "warn" })
    expect(glyph("blocked")).toBe("⊖")
    expect(glyph("waiting")).toBe("○")
    // The warning colour is not the colour of any other tone, so a colour check tells them apart.
    for (const other of [theme.error, theme.textMuted, theme.text, theme.primary, theme.success, theme.info])
      expect(rgb(theme.warning)).not.toEqual(rgb(other))
  }),
)

it.live(
  "[UI18] every design draws the blocked task and the blocked scenario as ⊖ in the warning tone",
  () =>
    Effect.gen(function* () {
      const status = yield* statusAfter(observed)
      for (const design of DESIGNS) {
        const { view } = yield* viewOf(status, design.id)
        view.select("T1.5")
        view.setExpanded(true)
        yield* Effect.promise(settle)
        expect({ design: design.name, selected: view.selected(), expanded: view.expanded() }).toEqual({
          design: design.name,
          selected: "T1.5",
          expanded: true,
        })
        const shown = yield* render(() => design.node(view), design.width, design.height)
        const blocked = blockedSpans(shown.spans)
        // The design's own line for the blocked task (tree line, chip, card, row, lane label, HUD line, list line).
        expect({ design: design.name, task: blocked.some((span) => /⊖ T1\.5\b/.test(span.text)) }).toEqual({
          design: design.name,
          task: true,
        })
        // The blocked scenario's entry in the design's shared region.
        expect({ design: design.name, scenario: blocked.some((span) => /⊖ S1\b/.test(span.text)) }).toEqual({
          design: design.name,
          scenario: true,
        })
        // Every ⊖ before a unit id is in the warning tone.
        expect({
          design: design.name,
          tones: blocked.filter((span) => !Bun.deepEquals(span.fg, rgb(theme.warning))),
        }).toEqual({ design: design.name, tones: [] })
      }
    }),
  180_000,
)

it.live(
  "[UI18] the Matrix legend lists ⊖ blocked",
  () =>
    Effect.gen(function* () {
      const status = yield* statusAfter(observed)
      const { view } = yield* viewOf(status, 4)
      const shown = yield* render(
        () =>
          createComponent(Screen, {
            theme: () => theme,
            view,
            sessions: none,
            leader: "ctrl+x",
            width: 120,
            height: 80,
          }),
        120,
        80,
      )
      const legend = shown.text.split("\n").find((line) => line.includes("pending ◉ proof passed")) ?? ""
      expect(legend.trim()).toBe("· pending ◉ proof passed ✓ trusted ✗ failed or rejected ~ stale ○ waiting ⊖ blocked")
      expect(legend).toContain("⊖ blocked")
    }),
  120_000,
)

it.live(
  "[UI18] a Ticker toast for a task that turns blocked shows its reason, through the host",
  () =>
    Effect.gen(function* () {
      // Before T1.4's last proof, and after it: T1 and T1.5 turn from waiting to blocked.
      const before = yield* statusAfter((plan) => observed(plan).slice(0, -1))
      const after = yield* statusAfter(observed)
      for (const id of ["T1", "T1.5"]) {
        expect(before.tasks[id]).toMatchObject({ state: "waiting" })
        expect(tagged(before.tasks[id], "blocked")).toBe(false)
        expect(tagged(after.tasks[id], "blocked")).toBe(true)
      }
      const toasts = tickerToasts(before, after)
      // The task that turned blocked shows its reason, not "waiting → blocked", in the warning variant.
      expect(toasts).toContainEqual({ variant: "warning", message: `T1.5 ${REASON}` })
      expect(toasts).toContainEqual({ variant: "warning", message: `T1 ${REASON}` })
      expect(toasts.map((toast) => toast.message).filter((message) => message.includes("→ blocked"))).toEqual([])
      // The blocker comes first.
      expect(toasts[0]?.message).toStartWith("T1.4 ")

      // Wired: the Ticker on a real view actor that reads the status before, then after, toasts through the host.
      const shown: Array<{ variant?: string; title?: string; message: string }> = []
      const made = yield* viewOf(before, 7, [after])
      const host = {
        ui: {
          toast: (toast: (typeof shown)[number]) => void shown.push(toast),
          dialog: { replace: () => {}, setSize: () => {}, clear: () => {} },
        },
        attention: { notify: async () => {} },
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
      for (let tries = 0; tries < 200 && made.view.status()?.tasks["T1.5"]?.state !== "blocked"; tries++)
        yield* Effect.promise(settle)
      yield* Effect.promise(settle)
      stop()
      expect(made.view.status()?.tasks["T1.5"]?.state).toBe("blocked")
      expect(shown).toContainEqual({ variant: "warning", title: "◆ In the Flow", message: `T1.5 ${REASON}` })
      expect(shown.map((toast) => toast.message)).toEqual(toasts.map((toast) => toast.message))
    }),
  120_000,
)
