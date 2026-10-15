/** @jsxImportSource @opentui/solid */
// The /task run header in the transcript (T4.10, D17): drawn from its message's metadata, never from the text.
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { Option, Result } from "effect"
import type { JSX } from "solid-js"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import { TaskHeader, headerOf, splitHeader } from "../../src/routes/session/task-header"

const theme = Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, "dark"))

const whole = { spec: { id: "release-notes.spec", title: "Release notes from conventional commits" }, leftOut: [] }
const subtree = {
  spec: { id: "release-notes.spec", title: "Release notes from conventional commits" },
  task: { id: "T1.2", title: "Compute the next version" },
  leftOut: ["S1", "S5"],
}
const meta = (header: unknown) => ({ taskHarness: { header } })

async function render(node: () => JSX.Element, width = 100) {
  const app = await testRender(node, { width, height: 8 })
  try {
    await app.renderOnce()
    return { text: app.captureCharFrame(), spans: app.captureSpans().lines.flatMap((line) => line.spans) }
  } finally {
    app.renderer.destroy()
  }
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
const span = (spans: Awaited<ReturnType<typeof render>>["spans"], text: string) =>
  spans.find((item) => item.text.includes(text))
const bold = (item: { attributes: number } | undefined) => ((item?.attributes ?? 0) & TextAttributes.BOLD) !== 0
const rgb = (item: { fg: { r: number; g: number; b: number } } | undefined) =>
  item ? [item.fg.r, item.fg.g, item.fg.b] : []

test("header: the metadata decodes to a header; anything else is none", () => {
  expect(headerOf(meta(whole))).toEqual(Option.some(whole))
  expect(headerOf(meta(subtree))).toEqual(Option.some(subtree))
  expect(headerOf(undefined)).toEqual(Option.none())
  expect(headerOf({ taskHarness: { header: { spec: { id: 1 } } } })).toEqual(Option.none())
  expect(headerOf({ other: true })).toEqual(Option.none())
})

test("header: Implementing spec muted, the title bold in the text tone (UI6)", async () => {
  const shown = await render(() => <TaskHeader theme={theme} header={whole} />)
  expect(lines(shown.text)).toEqual(["Implementing spec Release notes from conventional commits"])
  expect(rgb(span(shown.spans, "Implementing spec"))).toEqual(rgb({ fg: theme.textMuted }))
  expect(bold(span(shown.spans, "Implementing spec"))).toBe(false)
  expect(rgb(span(shown.spans, "Release notes"))).toEqual(rgb({ fg: theme.text }))
  expect(bold(span(shown.spans, "Release notes"))).toBe(true)
})

test("header: a subtree run names its task bold, then from spec and the spec title; the left-out line is muted (VF8)", async () => {
  const shown = await render(() => <TaskHeader theme={theme} header={subtree} />)
  expect(lines(shown.text)).toEqual([
    "Implementing T1.2 Compute the next version from spec Release notes from conventional commits",
    "Left out: S1, S5 — they need tasks outside this run.",
  ])
  expect(bold(span(shown.spans, "T1.2 Compute the next version"))).toBe(true)
  expect(bold(span(shown.spans, " from spec "))).toBe(false)
  expect(rgb(span(shown.spans, " from spec "))).toEqual(rgb({ fg: theme.textMuted }))
  expect(rgb(span(shown.spans, "Left out"))).toEqual(rgb({ fg: theme.textMuted }))
})

test("header: an empty title falls back to the spec id in the same bold style; a narrow panel wraps, never cuts", async () => {
  const untitled = await render(() => (
    <TaskHeader theme={theme} header={{ ...whole, spec: { ...whole.spec, title: "" } }} />
  ))
  expect(lines(untitled.text)).toEqual(["Implementing spec release-notes.spec"])
  expect(bold(span(untitled.spans, "release-notes.spec"))).toBe(true)
  const narrow = await render(() => <TaskHeader theme={theme} header={whole} />, 30)
  expect(lines(narrow.text).join(" ")).toBe("Implementing spec Release notes from conventional commits")
  expect(narrow.text).not.toContain("…")
})

test("header: the transcript splits the header part from the other text parts; an older header keeps its own title", () => {
  const parts = [
    {
      type: "text" as const,
      text: "Implementing spec **Release notes from conventional commits**",
      metadata: meta(whole),
    },
    { type: "text" as const, text: "The stored run could not be resumed (x), so a new run started." },
  ]
  const split = splitHeader(parts)
  expect(split.header).toEqual(Option.some(whole))
  expect(split.texts).toEqual(["The stored run could not be resumed (x), so a new run started."])
  // A synthetic part is not the user's: it is left out.
  expect(splitHeader([...parts, { type: "text" as const, text: "context", synthetic: true }]).texts).toEqual([
    "The stored run could not be resumed (x), so a new run started.",
  ])
  // A plain message has no header and keeps every text.
  expect(splitHeader([{ type: "text" as const, text: "hello" }])).toEqual({ header: Option.none(), texts: ["hello"] })
  // Each message reads its own metadata: a later run's header does not change an older one.
  const older = splitHeader([{ type: "text" as const, text: "x", metadata: meta(subtree) }])
  expect(Option.map(older.header, (header) => header.task?.title)).toEqual(Option.some("Compute the next version"))
})

test("header: the session route's user message splits its parts and draws the header with TaskHeader", async () => {
  // The route needs the app's providers to render; its user message reads the split and the component.
  const route = await Bun.file(new URL("../../src/routes/session/index.tsx", import.meta.url)).text()
  const user = route.slice(route.indexOf("function UserMessage("), route.indexOf("function AssistantMessage("))
  expect(user).toContain("splitHeader(props.parts)")
  expect(user).toContain("<TaskHeader theme={theme} header={value()} />")
  expect(user).not.toMatch(/x\.type === "text" && !x\.synthetic && x\.text/)
})
