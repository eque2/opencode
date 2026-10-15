/** @jsxImportSource @opentui/solid */
// The run usage (T4.12: D24, UI15): the summed tokens and cost of a /task root session's run, live from the synced
// session data, in the prompt footer, the sidebar Context panel and the task-ui.
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Option, Result } from "effect"
import type { JSX } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import context from "../../src/feature-plugins/sidebar/context"
import type { Sessions } from "../../src/task-ui/peek"
import { parse } from "../../src/task-ui/store"
import { footerText, isTaskRoot, runOf } from "../../src/task-ui/usage"
import { Screen } from "../../src/task-ui/designs/screen"
import { TickerDialog } from "../../src/task-ui/designs/7-ticker"
import projected from "./fixture-projected.json"
import { viewFor } from "./view"

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))
const ROOT = "ses_root"

// A session as the sync store holds it.
const session = (
  id: string,
  title: string,
  parentID?: string,
  spent?: { input: number; output: number; reasoning: number; cost: number },
) => ({
  id,
  title,
  ...(parentID === undefined ? {} : { parentID }),
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

const run = [
  session(ROOT, "Release notes"),
  session("ses_b", "T1.4 builder", ROOT, { input: 1_000_000, output: 350_000, reasoning: 50_000, cost: 2.0 }),
  session("ses_v", "T1.4 verifier", ROOT, { input: 2_000, output: 300, reasoning: 31, cost: 0.31 }),
  // Another root's harness session: not this run's.
  session("ses_other", "T9 builder", "ses_elsewhere", { input: 5, output: 5, reasoning: 5, cost: 5 }),
]

test("UI15 the run's sessions are the root's child sessions; tokens are input, output and reasoning; no cache", () => {
  expect(runOf(run, ROOT)).toEqual(Option.some({ tokens: 1_402_331, cost: 2.31 }))
  expect(isTaskRoot(run.filter((item) => item.parentID === ROOT))).toBe(true)
  // A session that owns no harness session is not a /task root: no run usage.
  const plain = [
    session("ses_plain", "Fix a bug"),
    session("ses_sub", "Explore the code", "ses_plain", { input: 9, output: 9, reasoning: 9, cost: 1 }),
  ]
  expect(runOf(plain, "ses_plain")).toEqual(Option.none())
  // Before any harness session reports tokens: hidden.
  expect(runOf([session(ROOT, "x"), session("ses_b", "T1.4 builder", ROOT)], ROOT)).toEqual(Option.none())
  // A free model that spent tokens: $0.00 on purpose.
  expect(
    runOf([session("ses_b", "T1.4 builder", ROOT, { input: 10, output: 1, reasoning: 0, cost: 0 })], ROOT),
  ).toEqual(Option.some({ tokens: 11, cost: 0 }))
})

test("UI15 the footer: the root's own figure, then the run; narrow, the own figure goes, then the word tokens, then all but the cost", () => {
  const usage = runOf(run, ROOT)
  const own = Option.some("12.3K (5%) · $0.02")
  expect(footerText(own, usage, 80)).toEqual(Option.some("12.3K (5%) · $0.02 · run 1.4M tokens · $2.31"))
  expect(footerText(own, usage, 40)).toEqual(Option.some("run 1.4M tokens · $2.31"))
  expect(footerText(own, usage, 20)).toEqual(Option.some("run 1.4M · $2.31"))
  expect(footerText(own, usage, 12)).toEqual(Option.some("run $2.31"))
  // No own figure: the run alone; no run usage: today's figure, unchanged.
  expect(footerText(Option.none(), usage, 80)).toEqual(Option.some("run 1.4M tokens · $2.31"))
  expect(footerText(own, Option.none(), 80)).toEqual(own)
  expect(footerText(Option.none(), Option.none(), 80)).toEqual(Option.none())
  expect(footerText(Option.none(), Option.some({ tokens: 61_000, cost: 0 }), 80)).toEqual(
    Option.some("run 61.0K tokens · $0.00"),
  )
})

// The sidebar Context panel of a session, rendered from the built-in plugin's slot over a host with these sessions.
async function sidebar(
  sessions: ReadonlyArray<ReturnType<typeof session>>,
  sessionID: string,
  messages: ReadonlyArray<unknown> = [],
) {
  let slot: ((ctx: unknown, props: { session_id: string }) => JSX.Element) | undefined
  const api = {
    theme: { current: theme },
    state: {
      provider: [],
      session: {
        get: (id: string) => sessions.find((item) => item.id === id),
        messages: () => messages,
        children: (id: string) => sessions.filter((item) => item.parentID === id),
      },
    },
    slots: {
      register: (input: { slots: { sidebar_content: typeof slot } }) => void (slot = input.slots.sidebar_content),
    },
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (b) the panel reads only the theme, state and slots members above
  await context.tui(api as unknown as TuiPluginApi, undefined as never, undefined as never)
  const node = slot
  if (!node) throw new Error("the panel registered no slot")
  const app = await testRender(() => node({}, { session_id: sessionID }), { width: 50, height: 10 })
  await app.renderOnce()
  const text = app.captureCharFrame()
  app.renderer.destroy()
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
}

const own = {
  role: "assistant",
  providerID: "p",
  modelID: "m",
  tokens: { input: 10_000, output: 2_300, reasoning: 0, cache: { read: 0, write: 0 } },
}

test("UI15 the sidebar panel adds the run's tokens and cost; the root's own lines show only with its own output", async () => {
  expect(await sidebar(run, ROOT)).toEqual(["Context", "1,402,331 tokens in the run", "$2.31 spent in the run"])
  expect(await sidebar(run, ROOT, [own])).toEqual([
    "Context",
    "12,300 tokens",
    "0% used",
    "$0.00 spent",
    "1,402,331 tokens in the run",
    "$2.31 spent in the run",
  ])
  // A session that is not a /task root is unchanged: its three lines, even at zero.
  expect(await sidebar([session("ses_plain", "Fix a bug")], "ses_plain")).toEqual([
    "Context",
    "0 tokens",
    "0% used",
    "$0.00 spent",
  ])
  // A /task root before any harness session reports tokens: the run lines are hidden.
  expect(await sidebar([session(ROOT, "x"), session("ses_b", "T1.4 builder", ROOT)], ROOT)).toEqual(["Context"])
})

const status = Option.getOrThrow(parse(JSON.stringify(projected)))
const spent = (cost: number, tokens = 1_402_331): Sessions => ({
  children: () => () => [],
  activity: () => () => [],
  all: () => () => [{ id: "b", unit: "T1.4", role: "builder", again: false, created: 1, updated: 1, tokens, cost }],
})

test("UI15 the full-screen header shows the run usage before the trusted bar; the tokens drop first, then the cost", async () => {
  const header = async (width: number, sessions: Sessions) => {
    const { view } = await viewFor(status, { design: 3 })
    const app = await testRender(
      () => <Screen theme={() => theme} view={view} sessions={sessions} leader="ctrl+x" width={width} height={40} />,
      { width, height: 40 },
    )
    await app.renderOnce()
    const line = app.captureCharFrame().split("\n")[0]?.trimEnd() ?? ""
    app.renderer.destroy()
    return line
  }
  const wide = await header(160, spent(2.31))
  expect(wide).toContain("Release notes from conventional commits · run: running")
  expect(wide).toMatch(/run: running +1\.4M tokens · \$2\.31 ▰/)
  // Narrower: the title keeps its room, so the tokens go, then the cost.
  const middle = await header(120, spent(2.31))
  expect(middle).toContain("Release notes from conventional commits · run: running")
  expect(middle).toMatch(/run: running +\$2\.31 ▰/)
  expect(middle).not.toContain("tokens")
  const narrow = await header(110, spent(2.31))
  expect(narrow).not.toContain("$")
  // Before any session reports tokens: nothing.
  expect(await header(160, spent(0, 0))).not.toContain("tokens")
})

test("UI15 the Ticker dialog's heading names the run's cost", async () => {
  const { view } = await viewFor(status, { design: 7 })
  const app = await testRender(
    () => <TickerDialog theme={() => theme} view={view} sessions={spent(2.31)} leader="ctrl+x" />,
    {
      width: 120,
      height: 30,
    },
  )
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("◆ In the Flow tasks · $2.31")
  app.renderer.destroy()
  const { view: quiet } = await viewFor(status, { design: 7 })
  const none = await testRender(
    () => <TickerDialog theme={() => theme} view={quiet} sessions={spent(0, 0)} leader="ctrl+x" />,
    {
      width: 120,
      height: 30,
    },
  )
  await none.renderOnce()
  expect(none.captureCharFrame()).toContain("◆ In the Flow tasks")
  expect(none.captureCharFrame()).not.toContain("$")
  none.renderer.destroy()
})
