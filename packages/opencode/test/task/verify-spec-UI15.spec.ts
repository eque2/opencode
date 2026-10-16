import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Layer, Option, Result } from "effect"
import path from "path"
import { testRender, useRenderer } from "@opentui/solid"
import { jsx } from "@opentui/solid/jsx-runtime"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { Show, createComponent, createMemo, createRoot, createSignal, type JSX } from "solid-js"
import { createOpencodeClient, type GlobalEvent, type Session } from "@opencode-ai/sdk/v2"
import type {
  TuiDialogSelectProps,
  TuiDispose,
  TuiPluginApi,
  TuiPluginMeta,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TaskHarness } from "@/task/core/harness"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { RunSupervisor } from "@/task/core/supervise/run"
import { TaskWorkers } from "@/task/core/workers"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, trustLeaf } from "./lib/machine"
import { eventually, runOf } from "./lib/supervise"
import { TuiKeybind } from "../../../tui/src/config/keybind"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../tui/src/keymap"
import { createSlots } from "../../../tui/src/plugin/slots"
import { DEFAULT_THEMES, resolveTheme } from "../../../tui/src/theme"
import context from "../../../tui/src/feature-plugins/sidebar/context"
import TaskUi from "../../../tui/src/task-ui/index"
import { harnessOf, type Sessions } from "../../../tui/src/task-ui/peek"
import { parse, type Status } from "../../../tui/src/task-ui/store"
import { promptFooter } from "../../../tui/src/task-ui/usage"
import { DockView } from "../../../tui/src/task-ui/designs/2-dock"
import { HudView } from "../../../tui/src/task-ui/designs/6-hud"
import { TickerDialog } from "../../../tui/src/task-ui/designs/7-ticker"
import { Screen } from "../../../tui/src/task-ui/designs/screen"
import { createTuiPluginApi } from "../../../tui/test/fixture/tui-plugin"
import { mount, wait } from "../../../tui/test/cli/cmd/tui/sync-fixture"
import { viewFor } from "../../../tui/test/task-ui/view"

// Scenario UI15 (spec task-harness-feedback, D24, AD-18; tasks T4.5, T4.7, T4.8, T4.11, T4.12): the run's tokens and
// cost are shown for a /task root session.
//
//   Given a /task root session whose child harness sessions spent tokens
//   When the prompt footer, the sidebar and the task-ui render
//   Then each shows the summed tokens and cost of the child sessions, live
//   And nothing shows before any harness session reports tokens, and other sessions are unchanged
//   And a free model that spent tokens shows "$0.00", and a narrow footer drops the root's own figure, then the word
//     tokens
//   And the closing summary repeats the run total
//
// The sessions are opencode's own session records (the SDK `Session`): the root and its child harness sessions
// `T1.4 builder` (1,000,000 input, 350,000 output, 50,000 reasoning tokens, $2.00) and `T1.4 verifier` (2,000, 300, 31,
// $0.31), each with large cache counts that are not counted; the run total is 1,402,331 tokens and $2.31.
// - The prompt footer and the sidebar read the TUI's real sync store (the tui test fixture `mount`: the real
//   SyncProvider fed by SDK events), so a `session.updated` event changes what they show. The footer is the real
//   `promptFooter` over `sync.data.session`, the expression the prompt component renders (its source is checked); the
//   prompt component itself needs the whole app's providers and is not rendered here. The sidebar is the real
//   built-in Context panel plugin, its state read from the sync store as the plugin adapter reads it.
// - The task-ui is the real plugin entry in a host on the root's route: its session reads go through the SDK client,
//   so a changed answer reaches the Dock and the HUD on the next session read; each design that shows the run usage
//   (HUD, full-screen header, Dock, Ticker dialog) also renders on a real taskView actor.
// - The closing summary is the real run supervisor's last step: the run is cancelled, the supervisor says the summary
//   built from the root's child sessions (the same records), and its counts line is compared with the footer's.
// This file is .spec.ts, so components render through `createComponent` and the opentui `jsx` runtime.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
/** The run supervisor's root session in the harness's test runs (test/task/lib/supervise): the /task root here too. */
const ROOT = "ses_supervise_root"
const ALIVE_AT = 1_791_000_000_000
const OWN = Option.some({ context: "12.3K (5%)", cost: Option.some("$0.02") })

/** A session record as opencode's server sends it, with what it spent when given. */
const session = (
  id: string,
  title: string,
  parentID?: string,
  spent?: { input: number; output: number; reasoning: number; cost: number },
): Session => ({
  id,
  slug: id,
  projectID: "proj_test",
  directory: "/tmp/opencode/packages/tui",
  ...(parentID === undefined ? {} : { parentID }),
  title,
  version: "1.0.0",
  time: { created: 1, updated: 2 },
  ...(spent === undefined
    ? {}
    : {
        tokens: {
          input: spent.input,
          output: spent.output,
          reasoning: spent.reasoning,
          cache: { read: 99_999, write: 99_999 },
        },
        cost: spent.cost,
      }),
})

const builder = { input: 1_000_000, output: 350_000, reasoning: 50_000, cost: 2.0 }
const verifier = { input: 2_000, output: 300, reasoning: 31, cost: 0.31 }
/** The root and its two harness sessions before either reports tokens. */
const quiet = [
  session(ROOT, "Release notes"),
  session("ses_b", "T1.4 builder", ROOT),
  session("ses_v", "T1.4 verifier", ROOT),
]
/** The same sessions once both reported: 1,402,331 tokens and $2.31. */
const spent = [
  session(ROOT, "Release notes"),
  session("ses_b", "T1.4 builder", ROOT, builder),
  session("ses_v", "T1.4 verifier", ROOT, verifier),
]
/** The builder spent a dollar more since: 1,402,331 + 100,000 tokens and $3.31. */
const more = [
  session(ROOT, "Release notes"),
  session("ses_b", "T1.4 builder", ROOT, { ...builder, output: 450_000, cost: 3.0 }),
  session("ses_v", "T1.4 verifier", ROOT, verifier),
]
/** A session that is no /task root, whose subagent spent tokens; and another root's harness session. */
const others = [
  session("ses_plain", "Fix a bug"),
  session("ses_sub", "Explore the code", "ses_plain", { input: 9, output: 9, reasoning: 9, cost: 1 }),
  session("ses_elsewhere_b", "T9 builder", "ses_elsewhere", { input: 5, output: 5, reasoning: 5, cost: 5 }),
]

/** The release-notes run with T1.1 to T1.3 trusted and T1.4's builder at work, its facts stamped from `start`. */
const building = (plan: Plan, start = 0): ReadonlyArray<Fact> => {
  const f = facts(start)
  return [
    f.runStarted(),
    ...trustLeaf(plan, f, "T1.1"),
    ...trustLeaf(plan, f, "T1.2"),
    ...trustLeaf(plan, f, "T1.3"),
    f.started("T1.4"),
  ]
}

/**
 * The status the harness writes for the building run, stamped `aliveAt`, and the directory that holds it. By default
 * the run started 24m 10s before its heartbeat.
 */
const written = Effect.fnUntraced(function* (aliveAt = ALIVE_AT, start = ALIVE_AT - 1_450_001) {
  const plan = yield* loadPlan("release-notes.spec")
  const snapshot = building(plan, start).reduce(
    (each, fact) => TaskEngineXState.apply(plan, each, fact),
    TaskEngineXState.initial(plan),
  )
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  yield* TaskStatus.write(directory, TaskStatus.project(plan, snapshot), aliveAt)
  const text = yield* fs.readFileString(path.join(directory, ".opencode", "task", "status.json"))
  return { directory, status: Option.getOrThrow(parse(text)) }
})

// --- the prompt footer and the sidebar over the TUI's sync store ----------------------------------------------------

/**
 * A `session.updated` event from the server for `info`, as a copy: the sync store reconciles into the objects it holds,
 * so a record shared with the store would change under the test.
 */
const updated = (info: Session): GlobalEvent => ({
  directory: "/tmp/opencode/packages/tui",
  project: "proj_test",
  payload: {
    id: `evt_${info.id}_${info.time.updated}_${info.cost ?? 0}`,
    type: "session.updated",
    properties: { sessionID: info.id, info: structuredClone(info) },
  },
})

/** The sidebar Context panel (the built-in plugin) over the sync store, rendered for `sessionID`. */
const sidebarOf = async (sync: Awaited<ReturnType<typeof mount>>["sync"]) => {
  const slots: { node?: (ctx: unknown, props: { session_id: string }) => JSX.Element } = {}
  // The plugin's state as the plugin adapter reads it from the sync store (src/plugin/adapters.tsx).
  const api = {
    theme: { current: theme },
    state: {
      get provider() {
        return sync.data.provider
      },
      session: {
        get: (id: string) => sync.session.get(id),
        messages: (id: string) => sync.data.message[id] ?? [],
        children: (id: string) => sync.data.session.filter((item) => item.parentID === id),
      },
    },
    slots: {
      register: (input: { slots: { sidebar_content: NonNullable<typeof slots.node> } }) =>
        void (slots.node = input.slots.sidebar_content),
    },
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the Context panel reads only the theme, state and slots members above
  await context.tui(api as unknown as TuiPluginApi, undefined, { id: "internal:sidebar-context" } as TuiPluginMeta)
  const node = slots.node
  if (!node) throw new Error("the Context panel registered no slot")
  return async (sessionID: string) => {
    const app = await testRender(() => node({}, { session_id: sessionID }), { width: 50, height: 10 })
    try {
      await app.renderOnce()
      return app
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    } finally {
      app.renderer.destroy()
    }
  }
}

it.live(
  "[UI15] the prompt footer and the sidebar show the root's run total live from the synced sessions; others unchanged",
  () =>
    Effect.gen(function* () {
      // The prompt renders promptFooter over the synced sessions in place of today's figure; the adapter gives the
      // sidebar the same synced children.
      const prompt = yield* Effect.promise(() =>
        Bun.file(path.resolve(import.meta.dir, "../../../tui/src/component/prompt/index.tsx")).text(),
      )
      expect(prompt).toMatch(
        /promptFooter\(\{\s*sessionID: props\.sessionID,\s*own: usage\(\),\s*sessions: sync\.data\.session,\s*width: dimensions\(\)\.width,\s*shortcut: paletteShortcut\(\),\s*\}\)/,
      )
      expect(prompt).toMatch(
        /<Match when=\{Option\.getOrUndefined\(footer\(\)\)\}>\s*\{\(text\) => \(\s*<text fg=\{theme\.textMuted\} wrapMode="none">\s*\{text\(\)\}/,
      )
      const adapters = yield* Effect.promise(() =>
        Bun.file(path.resolve(import.meta.dir, "../../../tui/src/plugin/adapters.tsx")).text(),
      )
      expect(adapters).toContain("return sync.data.session.filter((item) => item.parentID === sessionID)")

      const fs = yield* FileSystem.FileSystem
      const state = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(path.join(state, "kv.json"), "{}")
      const mounted = yield* Effect.acquireRelease(
        Effect.promise(() => mount(undefined, state)),
        (made) => Effect.sync(() => made.app.renderer.destroy()),
      )
      const { sync, emit } = mounted
      const send = (list: ReadonlyArray<Session>) =>
        Effect.promise(async () => {
          for (const info of list) emit(updated(info))
          await wait(() =>
            list.every((info) => {
              const held = sync.data.session.find((item) => item.id === info.id)
              return (
                held !== undefined &&
                (held.cost ?? 0) === (info.cost ?? 0) &&
                held.tokens?.output === info.tokens?.output
              )
            }),
          )
        })
      // The footer as the prompt computes it: a memo over the synced sessions, at a wide prompt box.
      const footer = createRoot(() =>
        createMemo(() =>
          promptFooter({ sessionID: ROOT, own: OWN, sessions: sync.data.session, width: 200, shortcut: "ctrl+p" }),
        ),
      )
      const at = (width: number, sessionID = ROOT, own = OWN) =>
        promptFooter({ sessionID, own, sessions: sync.data.session, width, shortcut: "ctrl+p" })
      const sidebar = yield* Effect.promise(() => sidebarOf(sync))

      // Before any harness session reports tokens: no run usage anywhere; the footer keeps today's figure.
      yield* send([...quiet, ...others])
      expect(footer()).toEqual(Option.some("12.3K (5%) · $0.02"))
      expect(at(200, ROOT, Option.none())).toEqual(Option.none())
      expect(yield* Effect.promise(() => sidebar(ROOT))).toEqual(["Context"])

      // The harness sessions report: the summed tokens (input, output, reasoning; no cache) and cost show.
      yield* send(spent)
      expect(footer()).toEqual(Option.some("12.3K (5%) · $0.02 · run 1.4M tokens · $2.31"))
      expect(yield* Effect.promise(() => sidebar(ROOT))).toEqual([
        "Context",
        "1,402,331 tokens in the run",
        "$2.31 spent in the run",
      ])

      // Live: the builder spends more, and both follow the next session update.
      yield* send(more)
      expect(footer()).toEqual(Option.some("12.3K (5%) · $0.02 · run 1.5M tokens · $3.31"))
      expect(yield* Effect.promise(() => sidebar(ROOT))).toEqual([
        "Context",
        "1,502,331 tokens in the run",
        "$3.31 spent in the run",
      ])
      yield* send(spent)

      // A narrow footer drops the root's own figure first, then the word tokens, then shows the cost alone. The room
      // is the width less 4 cells of padding, the "ctrl+p commands" hint and a 2-cell gap.
      expect(at(65)).toEqual(Option.some("12.3K (5%) · $0.02 · run 1.4M tokens · $2.31"))
      expect(at(64)).toEqual(Option.some("run 1.4M tokens · $2.31"))
      expect(at(44)).toEqual(Option.some("run 1.4M tokens · $2.31"))
      expect(at(43)).toEqual(Option.some("run 1.4M · $2.31"))
      expect(at(37)).toEqual(Option.some("run 1.4M · $2.31"))
      expect(at(36)).toEqual(Option.some("run $2.31"))
      // With no figure of its own, the root's footer shows the run alone.
      expect(at(200, ROOT, Option.none())).toEqual(Option.some("run 1.4M tokens · $2.31"))

      // Other sessions are unchanged: a session that owns no harness session keeps today's figure and its three
      // sidebar lines, though its subagent spent tokens; another root's harness session is not this run's.
      expect(at(200, "ses_plain")).toEqual(OWN.pipe(Option.map((own) => `${own.context} · $0.02`)))
      expect(at(200, "ses_plain", Option.none())).toEqual(Option.none())
      expect(yield* Effect.promise(() => sidebar("ses_plain"))).toEqual([
        "Context",
        "0 tokens",
        "0% used",
        "$0.00 spent",
      ])

      // A free model that spent tokens: $0.00, on purpose.
      yield* send([
        session("ses_b", "T1.4 builder", ROOT, { input: 10, output: 1, reasoning: 0, cost: 0 }),
        session("ses_v", "T1.4 verifier", ROOT),
      ])
      expect(at(200, ROOT, Option.none())).toEqual(Option.some("run 11 tokens · $0.00"))
      expect(yield* Effect.promise(() => sidebar(ROOT))).toEqual([
        "Context",
        "11 tokens in the run",
        "$0.00 spent in the run",
      ])
    }),
  60_000,
)

// --- the task-ui designs --------------------------------------------------------------------------------------------

/** The task-ui's session source over a fixed list: what the plugin reads from the SDK client, through `harnessOf`. */
const sessionsOf = (list: ReadonlyArray<Session>): Sessions => ({
  children: () => () => [],
  activity: () => () => [],
  all: () => () => list.filter((item) => item.parentID === ROOT).flatMap(harnessOf),
})

const render = (node: () => JSX.Element, width: number, height: number) =>
  Effect.promise(async () => {
    const app = await testRender(node, { width, height })
    try {
      await app.renderOnce()
      return app.captureCharFrame()
    } finally {
      app.renderer.destroy()
    }
  })

const viewOf = (status: Status, design: number) =>
  Effect.acquireRelease(
    Effect.promise(() => viewFor(status, { design })),
    (made) => Effect.sync(made.dispose),
  )

it.live(
  "[UI15] the HUD, the full-screen header, the Dock and the Ticker dialog show the run total; nothing before tokens",
  () =>
    Effect.gen(function* () {
      const { status } = yield* written()
      const shown = (list: ReadonlyArray<Session>) =>
        Effect.gen(function* () {
          const sessions = sessionsOf(list)
          const base = { theme: () => theme, sessions, leader: "ctrl+x" }
          const hud = (yield* viewOf(status, 6)).view
          const screen = (yield* viewOf(status, 3)).view
          const dock = (yield* viewOf(status, 2)).view
          const ticker = (yield* viewOf(status, 7)).view
          return {
            hud: yield* render(() => createComponent(HudView, { ...base, view: hud }), 120, 30),
            screen:
              (yield* render(
                () => createComponent(Screen, { ...base, view: screen, width: 160, height: 40 }),
                160,
                40,
              )).split("\n")[0] ?? "",
            dock: yield* render(() => createComponent(DockView, { ...base, view: dock, width: 160 }), 160, 40),
            ticker: yield* render(() => createComponent(TickerDialog, { ...base, view: ticker }), 120, 30),
          }
        })
      const total = yield* shown(spent)
      expect(total.hud).toContain("elapsed 24m 10s · 1.4M tokens · $2.31")
      expect(total.screen).toMatch(/1\.4M tokens · \$2\.31/)
      expect(total.dock).toContain("$2.31")
      expect(total.ticker).toContain("◆ In the Flow tasks · $2.31")
      // Before any harness session reports tokens: no tokens and no cost on any of them.
      const none = yield* shown(quiet)
      for (const [site, text] of Object.entries(none))
        expect({ site, tokens: text.includes("tokens"), cost: text.includes("$") }).toEqual({
          site,
          tokens: false,
          cost: false,
        })
      // A free model that spent tokens: $0.00.
      const free = yield* shown([
        session("ses_b", "T1.4 builder", ROOT, { input: 10, output: 1, reasoning: 0, cost: 0 }),
      ])
      expect(free.hud).toContain("11 tokens · $0.00")
      expect(free.ticker).toContain("◆ In the Flow tasks · $0.00")
      // Another root's harness sessions are not this run's.
      const elsewhere = yield* shown(others)
      for (const [site, text] of Object.entries(elsewhere))
        expect({ site, cost: text.includes("$") }).toEqual({ site, cost: false })
    }),
  120_000,
)

// --- the real task-ui plugin, live from the SDK's session reads ------------------------------------------------------

const meta = {
  id: "internal:task-ui",
  source: "internal",
  spec: "internal:task-ui",
  target: "internal:task-ui",
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: "test",
  state: "same",
} satisfies TuiPluginMeta

/** Solid's `Show` at its unkeyed signature, for `createComponent` (which would infer its keyed overload). */
const ShowWhen: (props: { when: boolean; children: JSX.Element }) => JSX.Element = Show

/**
 * Loads the plugin entry the way the runtime does, over `directory`, on the root session's route. The SDK client
 * answers the root's children with `answer.list` at the time of each read, and anything else with an empty list. The
 * Dock's and the HUD's slots and the shortcut bar are on screen; the design picker chooses at once.
 */
async function load(directory: string, answer: { list: ReadonlyArray<Session>; reads: number }) {
  const pickers: Array<(value: number) => void> = []
  const disposers: TuiDispose[] = []
  const slots = createSlots()
  const handles: { api?: TuiPluginApi } = {}
  const [loaded, setLoaded] = createSignal(false)

  function Host(): JSX.Element {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const keybinds = createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse({})), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    })
    registerOpencodeKeymap(keymap, renderer, { keybinds, leader_timeout: 2000 })
    const respond = async (request: RequestInfo | URL) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.pathname !== `/session/${ROOT}/children`) return Response.json([])
      answer.reads += 1
      return Response.json(answer.list.filter((item) => item.parentID === ROOT))
    }
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      fetch: Object.assign(respond, { preconnect: fetch.preconnect }),
    })
    const base = createTuiPluginApi({ renderer, keymap, client })
    const host = slots.setup(base)
    const registered = { count: 0 }
    handles.api = {
      ...base,
      route: {
        ...base.route,
        navigate: () => {},
        get current() {
          return { name: "session", params: { sessionID: ROOT } }
        },
      },
      state: { ...base.state, path: { ...base.state.path, directory } },
      slots: {
        register(plugin: TuiSlotPlugin) {
          registered.count += 1
          const id = `${meta.id}:${registered.count}`
          host.register({ ...plugin, id })
          return id
        },
      },
      ui: {
        ...base.ui,
        toast: () => {},
        DialogSelect: <Value>(props: TuiDialogSelectProps<Value>) => {
          pickers.push((value) => {
            const option = props.options.find((item) => item.value === value)
            if (option) props.onSelect?.(option)
          })
          return null
        },
        dialog: {
          ...base.ui.dialog,
          replace: (render) =>
            createRoot((dispose) => {
              render()
              dispose()
            }),
        },
      },
      lifecycle: {
        ...base.lifecycle,
        onDispose: (fn) => {
          disposers.push(fn)
          return () => {}
        },
      },
    }
    return createComponent(OpencodeKeymapProvider, {
      keymap,
      get children() {
        return jsx("box", {
          flexDirection: "column",
          get children() {
            return createComponent(ShowWhen, {
              get when() {
                return loaded()
              },
              get children() {
                return [
                  createComponent(slots.Slot, { name: "app", session_id: "" }),
                  createComponent(slots.Slot, { name: "app_bottom", session_id: "" }),
                  createComponent(slots.Slot, { name: "session_prompt_right", session_id: "" }),
                ]
              },
            })
          },
        })
      },
    })
  }

  const app = await testRender(() => createComponent(Host, {}), { width: 200, height: 40 })
  const { api } = handles
  if (!api) throw new Error("the host did not render")
  await TaskUi.tui(api, undefined, meta)
  setLoaded(true)

  const frame = async () => {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  /** Waits until the screen shows `text`, over several session reads (one each 2 s). */
  const shows = async (text: string, within = 8000) => {
    const end = Date.now() + within
    while (Date.now() < end) {
      if ((await frame()).includes(text)) return true
      await Bun.sleep(50)
    }
    return (await frame()).includes(text)
  }
  /** Chooses a design through `/task-design`'s command. */
  const choose = (design: number) => {
    api.keymap.dispatchCommand("task_ui.pick")
    pickers.at(-1)?.(design)
  }
  return {
    frame,
    shows,
    choose,
    async [Symbol.asyncDispose]() {
      for (const dispose of disposers.splice(0)) await dispose()
      app.renderer.destroy()
    },
  }
}

it.live(
  "[UI15] the real task-ui plugin follows the root's child sessions live: nothing before tokens, then the run total",
  () =>
    Effect.gen(function* () {
      // A heartbeat a minute ahead: the run stays live for the whole test. The run started a few minutes ago.
      const { directory } = yield* written(Date.now() + 60_000, Date.now() - 300_000)
      const answer: { list: ReadonlyArray<Session>; reads: number } = { list: quiet, reads: 0 }
      const plugin = yield* Effect.acquireRelease(
        Effect.promise(() => load(directory, answer)),
        (made) => Effect.promise(() => made[Symbol.asyncDispose]()),
      )
      plugin.choose(2)
      expect(yield* Effect.promise(() => plugin.shows("run: running"))).toBe(true)
      // Two session reads with no tokens reported: the Dock shows no cost.
      const before = answer.reads
      for (let tries = 0; tries < 160 && answer.reads < before + 2; tries++) yield* Effect.promise(() => Bun.sleep(50))
      expect(answer.reads).toBeGreaterThanOrEqual(before + 2)
      expect((yield* Effect.promise(plugin.frame)).includes("$")).toBe(false)
      // The harness sessions report: the Dock shows the run's cost at the next read.
      answer.list = spent
      expect(yield* Effect.promise(() => plugin.shows("$2.31"))).toBe(true)
      // Live: the builder spends more.
      answer.list = more
      expect(yield* Effect.promise(() => plugin.shows("$3.31"))).toBe(true)
      expect((yield* Effect.promise(plugin.frame)).includes("$2.31")).toBe(false)
      // The HUD shows the tokens and the cost.
      plugin.choose(6)
      expect(yield* Effect.promise(() => plugin.shows("1.5M tokens · $3.31"))).toBe(true)
      expect((yield* Effect.promise(plugin.frame)).split("\n").find((line) => line.includes("$3.31"))).toMatch(
        /elapsed \d+m \d+s · 1\.5M tokens · \$3\.31/,
      )
    }),
  60_000,
)

// --- the closing summary --------------------------------------------------------------------------------------------

it.live(
  "[UI15] the closing summary repeats the run total of the root's child sessions",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const setup = { plan, ...(yield* runOf({ plan, directory: "/root", stored: [facts().runStarted()] })) }
      expect(String(setup.run.root)).toBe(ROOT)
      const said: Array<{ sessionID: string; text: string }> = []
      const asked: string[] = []
      Object.assign(setup.run.env.ops, {
        say: (input: { sessionID: string; text: string }) => Effect.sync(() => void said.push(input)),
      })
      // The run's sessions are the root's child sessions, as the session store holds them.
      Object.assign(setup.run.env.sessions, {
        children: (id: string) =>
          Effect.sync(() => {
            asked.push(id)
            return [...spent, ...others].filter((item) => item.parentID === id)
          }),
      })
      const harness = yield* TaskHarness.make
      yield* harness.spawnRun(setup.id, RunSupervisor.machine, {
        run: setup.run,
        events: setup.events,
        resumed: false,
        path: plan.path,
        trusts: Effect.succeed([]),
        externals: [],
        release: Effect.void,
        writer: setup.recorder.writer,
      })
      yield* eventually(
        Effect.map(setup.recorder.actor.getSnapshot, () => true),
        "the run actor",
      )
      yield* TaskWorkers.record(setup.run, { type: "run.cancelled", reason: "user stop" })
      yield* RunSupervisor.awaitClosed(harness, setup.id).pipe(Effect.timeout(20_000))

      // One summary, in the root session, summed over the root's child sessions only.
      expect(said.map((item) => item.sessionID)).toEqual([ROOT])
      expect(asked).toEqual([ROOT])
      const lines = said[0]?.text.split("\n") ?? []
      expect(lines[0]).toBe("Spec **Release notes from conventional commits** — cancelled: user stop")
      expect(lines[2]).toEndWith(" · 1.4M tokens · $2.31")
      // The same total the prompt footer, the sidebar and the task-ui show for these sessions.
      const footer = promptFooter({
        sessionID: ROOT,
        own: Option.none(),
        sessions: [...spent, ...others],
        width: 200,
        shortcut: "ctrl+p",
      })
      expect(footer).toEqual(Option.some("run 1.4M tokens · $2.31"))
      expect(lines[2]?.endsWith(` · ${Option.getOrThrow(footer).slice("run ".length)}`)).toBe(true)
    }),
  60_000,
)
