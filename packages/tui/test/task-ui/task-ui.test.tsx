/** @jsxImportSource @opentui/solid */
// The task-ui designs, store and watch view against a real status file: the release-notes run that stopped at
// T1.4.c8 (paths replaced). plugin.test.tsx loads the plugin entry itself.
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
import { Peek, lines, type Sessions } from "../../src/task-ui/peek"
import { counts, createView, focus, obligationsOf, parse, rows, type Status } from "../../src/task-ui/store"
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
  proofTail,
  recentProof,
  registerWatch,
  stopper,
} from "../../src/task-ui/watch"
import type { Child, Harness } from "../../src/task-ui/peek"

const status = Option.getOrThrow(parse(JSON.stringify(fixture)))
const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const none: Sessions = { children: () => () => [], activity: () => () => [], all: () => () => [] }

const view = (sessions: Sessions = none, input: Status = status, design = 1) =>
  createRoot(() => ({ theme: () => theme, sessions, leader: "ctrl+x", view: createView({ status: () => input, now: () => 0, design }) }))

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
  expect(ledger).toContain("◆ In the Flow run: budget exhausted")
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
  expect(await frame(() => <TickerDialog {...props} />)).toContain("◆ In the Flow · T1.4 details · read-only")
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
  const props = view(sessions)
  const peek = await frame(() => <Peek {...props} unit="T1.4" width={70} lines={3} />)
  expect(peek).toContain("◆ In the Flow · T1.4 details · read-only")
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
  // The run has ended, so Tab switches agents again and the bar offers `ctrl+x j/k` to select a task.
  expect(wide).toContain(
    "◆ In the Flow Ledger  ctrl+x o expand  /task-design switch  ctrl+x j/k select task  ctrl+x w watch",
  )
  expect(wide).not.toContain("trusted")
  const narrow = await frame(() => <ShortcutBar {...ledger} width={100} />, 100, 3)
  expect(narrow).toContain("◆ In the Flow Ledger  ctrl+x o expand  /task-design switch")
  expect(narrow).not.toContain("select task")
  const ticker = view(none, status, 7)
  const line = await frame(() => <ShortcutBar {...ticker} width={200} />, 200, 3)
  expect(line).toContain("◆ In the Flow Ticker  3/6 trusted  ⊘ T1.4 budget exhausted  ctrl+x o expand")
  ticker.view.toggleExpanded()
  expect(await frame(() => <ShortcutBar {...ticker} width={200} />, 200, 3)).toContain("ctrl+x o collapse")
})

// --- the watch view -------------------------------------------------------------------------------------------------

// The fixture run, live again: the given tasks in the given states.
const live = (states: Record<string, string>) => {
  const copy = structuredClone(fixture)
  copy.run.state = "running"
  const tasks: Record<string, { state: string }> = copy.tasks
  for (const [id, state] of Object.entries(states)) tasks[id].state = state
  return Option.getOrThrow(parse(JSON.stringify(copy)))
}

const child = (id: string, role: string, created: number, again = false): Child => ({
  id,
  role,
  again,
  created,
  updated: created,
})
const builders = [child("b1", "builder", 1), child("b2", "builder", 3), child("v1", "verifier", 2)]
const everyLoaded = () => true

test("Tab in the watch view moves to the next task in work, and does nothing with one or none", () => {
  const two = rows(live({ "T1.2": "proving", "T1.4": "building" }))
  expect(nextRunning(two, "T1.4", 1)).toEqual(Option.some("T1.2"))
  expect(nextRunning(two, "T1.2", 1)).toEqual(Option.some("T1.4"))
  expect(nextRunning(two, "T1.2", -1)).toEqual(Option.some("T1.4"))
  // From a task out of work, the next one in work after it.
  expect(nextRunning(two, "T1.3", 1)).toEqual(Option.some("T1.4"))
  const one = rows(live({ "T1.4": "building" }))
  expect(Option.isNone(nextRunning(one, "T1.4", 1))).toBe(true)
  expect(Option.isNone(nextRunning(rows(status), "T1.4", 1))).toBe(true)
  createRoot((dispose) => {
    const state = createView({ status: () => live({ "T1.2": "verifying", "T1.4": "building" }), now: () => 0, design: 1 })
    expect(state.selected()).toBe("T1.2")
    state.nextRunning()
    expect(state.selected()).toBe("T1.4")
    state.nextRunning()
    expect(state.selected()).toBe("T1.2")
    dispose()
  })
})

test("a run is active until it ends, and waits on its waiting tasks' dependencies", () => {
  expect(runActive(status)).toBe(false)
  expect(runActive(live({ "T1.4": "building" }))).toBe(true)
  expect(waitsOn(status)).toEqual(["T1.4"])
  // Without a live signal of its own, the view is live while the status says the run has not ended.
  createRoot((dispose) => {
    expect(createView({ status: () => status, now: () => 0, design: 1 }).live()).toBe(false)
    expect(createView({ status: () => live({}), now: () => 0, design: 1 }).live()).toBe(true)
    expect(createView({ status: () => live({}), now: () => 0, design: 1, live: () => false }).live()).toBe(false)
    dispose()
  })
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
  const ended = chooseWatch({ status, task: "T1.4", children: builders, loaded: everyLoaded })
  expect(bandText(ended)).toBe("◆ In the Flow Nothing is running · run: budget exhausted · watch only")
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
  const theme = view().theme
  const watch = chooseWatch({ status: live({ "T1.4": "building" }), task: "T1.4", children: builders, loaded: everyLoaded })
  const band = await frame(() => <WatchBand theme={theme} watch={watch} width={120} live={true} />, 120, 3)
  expect(band).toContain("◆ In the Flow watching T1.4 builder · attempt 3 · watch only")
  expect(band).toContain("watch only: you type to the main session · esc twice stops the run · the same /task starts it")
  // Once the run is not live, `esc` no longer stops anything, so the note does not offer it.
  const ended = await frame(() => <WatchBand theme={theme} watch={watch} width={120} live={false} />, 120, 3)
  expect(lineWith(ended, "watch only:")).toBe("watch only: you type to the main session")
})

test("the proof panel shows the log's last lines as a shell call, or says there is no output yet", async () => {
  const theme = view().theme
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
  const running = view(none, live({ "T1.4": "building" }))
  const bar = await frame(() => <ShortcutBar {...running} width={200} />, 200, 3)
  expect(bar).toContain("tab select task")
  expect(bar).toContain("ctrl+x w watch")
  running.view.setWatching(true)
  const watching = await frame(() => <ShortcutBar {...running} width={200} />, 200, 3)
  expect(lineWith(watching, "◆")).toBe("◆ In the Flow Ledger  tab next running  ctrl+x w stop watching  esc stop run")
  // After the run ends, Tab and esc no longer act on the run: `ctrl+x j/k` selects, and the toggle stays.
  const ended = view()
  ended.view.setWatching(true)
  const after = await frame(() => <ShortcutBar {...ended} width={200} />, 200, 3)
  expect(lineWith(after, "◆")).toBe("◆ In the Flow Ledger  ctrl+x j/k select task  ctrl+x w stop watching")
})

test("esc twice stops the run: the first press warns, the second stops, autocomplete keeps the key", async () => {
  const calls: string[] = []
  const state = { open: false }
  const [press, dispose] = createRoot((done) => [
    stopper({
      open: () => state.open,
      warn: () => calls.push("warn"),
      stop: () => calls.push("stop"),
      window: "50 millis",
    }),
    done,
  ])
  expect(press()).toBe(true)
  expect(press()).toBe(true)
  expect(calls).toEqual(["warn", "stop"])
  // A second press after the window has passed asks again instead of stopping.
  expect(press()).toBe(true)
  await Bun.sleep(150)
  expect(press()).toBe(true)
  expect(calls).toEqual(["warn", "stop", "warn", "warn"])
  // While the autocomplete shows, esc belongs to it.
  state.open = true
  expect(press()).toBe(false)
  expect(calls).toHaveLength(4)
  dispose()
})

// --- the plugin's keys and route, with the plugin API fixture and a real keymap --------------------------------------

const ROOT = "ses_root"

// The watch view and the Tab layer over a fixed status, on the root session's route. Tab that the plugin does not
// take reaches a stand-in for opencode's agent key. A real SDK client over a fetch records each abort.
async function wired(input: { status: Status; design?: number; harness?: ReadonlyArray<Harness> }) {
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
      view: createView({ status: () => input.status, now: () => 0, design: input.design ?? 1 }),
      sessions: none,
      theme: () => theme,
      active: () => true,
      leader: "ctrl+x",
      root: () => ROOT,
      owns: () => true,
      harness: () => input.harness ?? [],
      logs: () => [],
    }
    handles.ctx = ctx
    handles.toggle = registerWatch(ctx)
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
  return { app, view: ctx.view, toggle, navigations, aborted, toasts, agent }
}

// Waits until `done` holds: keys and the SDK answer on later ticks.
async function until(done: () => boolean) {
  for (let tries = 0; tries < 100 && !done(); tries++) await Bun.sleep(10)
  return done()
}

const harnessOfT14 = [{ ...child("b2", "builder", 3), unit: "T1.4" }]

test("ctrl+x w from an expanded Board collapses it and puts the builder in the session route's watch", async () => {
  const plugin = await wired({ status: live({ "T1.4": "building" }), design: 3, harness: harnessOfT14 })
  try {
    plugin.view.setExpanded(true)
    plugin.toggle()
    expect(plugin.view.expanded()).toBe(false)
    expect(plugin.view.watching()).toBe(true)
    expect(await until(() => plugin.navigations.length > 0)).toBe(true)
    expect(plugin.navigations.at(-1)).toEqual({ sessionID: ROOT, watch: "b2" })
    // The toggle again returns the root's own transcript.
    plugin.toggle()
    expect(await until(() => plugin.navigations.length > 1)).toBe(true)
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
  const plugin = await wired({ status })
  try {
    plugin.app.mockInput.pressTab()
    expect(await until(() => plugin.agent.moves === 1)).toBe(true)
    expect(plugin.view.selected()).toBe("T1.4")
  } finally {
    plugin.app.renderer.destroy()
  }
})
