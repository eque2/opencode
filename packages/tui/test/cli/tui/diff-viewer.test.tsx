/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { DiffRenderable, KeyEvent, type Renderable, ScrollBoxRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import type { TuiPluginApi, TuiPluginMeta, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import { createOpencodeClient, type Session } from "@opencode-ai/sdk/v2"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { TuiKeybind } from "../../../src/config/keybind"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import diffViewerPlugin from "../../../src/feature-plugins/system/diff-viewer"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { json } from "../../fixture/tui-sdk"

type DiffCommand = NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
type DiffCommandContext = Parameters<NonNullable<DiffCommand["run"]>>[0]

test("closing the diff viewer returns to the route it opened from", async () => {
  const viewer = await renderDiffViewer([])
  try {
    expect(viewer.current()).toEqual({
      name: "diff",
      params: { mode: "git", sessionID: "session-1", returnRoute: startRoute },
    })
    // The SDK client sends the request a few microtasks after the viewer asks for it.
    await viewer.app.waitFor(() => viewer.vcsDiffInput() !== undefined)
    expect(viewer.vcsDiffInput()).toEqual({ directory: "/repo/session", mode: "git", context: "12" })

    expect(viewer.commands.has("diff.close")).toBe(true)
    await viewer.run("diff.close")
    expect(viewer.current()).toEqual(startRoute)
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("brackets navigate diff hunks", async () => {
  const viewer = await renderDiffViewer(
    [
      {
        file: "src/file.ts",
        additions: 3,
        deletions: 3,
        status: "modified",
        patch: `--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,3 @@
 const first = true
-const oldFirst = true
+const newFirst = true
 const afterFirst = true
@@ -20,3 +20,3 @@
 const second = true
-const oldSecond = true
+const newSecond = true
 const afterSecond = true
@@ -40,3 +40,3 @@
 const third = true
-const oldThird = true
+const newThird = true
 const afterThird = true`,
      },
    ],
    12,
  )
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("const first"))
    await viewer.app.waitFor(() => Boolean(findScrollBox(viewer.app.renderer.root)))
    await viewer.app.flush()
    const scroll = findScrollBox(viewer.app.renderer.root)!
    const initial = scroll.scrollTop

    expect(TuiKeybind.defaultValue("diff_next_hunk")).toBe("]")
    expect(TuiKeybind.defaultValue("diff_previous_hunk")).toBe("[")

    await viewer.run("diff.next_hunk")
    await viewer.app.renderOnce()
    const first = scroll.scrollTop
    expect(first).toBeGreaterThan(initial)

    await viewer.run("diff.next_hunk")
    await viewer.app.renderOnce()
    const second = scroll.scrollTop
    expect(second).toBeGreaterThan(first)

    await viewer.run("diff.previous_hunk")
    await viewer.app.renderOnce()
    expect(scroll.scrollTop).toBe(first)

    await viewer.run("diff.next_hunk")
    await viewer.app.renderOnce()
    expect(scroll.scrollTop).toBe(second)

    scroll.scrollTo(initial)
    await viewer.run("diff.next_hunk")
    await viewer.app.renderOnce()
    expect(scroll.scrollTop).toBe(first)
  } finally {
    viewer.app.renderer.destroy()
  }
})

async function renderDiffViewer(vcsDiff: unknown[], height = 20, initialRoute?: TuiRouteCurrent) {
  const commands = new Map<string, DiffCommand>()
  let current = initialRoute ?? startRoute
  let renderDiff: TuiRouteDefinition["render"] | undefined
  let context: DiffCommandContext | undefined
  let vcsDiffInput: unknown
  let sessionDiffInput: unknown
  const config = createTuiResolvedConfig()
  // A real SDK client over a fetch that answers the two diff endpoints and records their query parameters.
  const answer = async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const query = Object.fromEntries(url.searchParams)
    if (url.pathname === "/vcs/diff") {
      vcsDiffInput = query
      return json(vcsDiff)
    }
    const sessionDiff = /^\/session\/([^/]+)\/diff$/.exec(url.pathname)
    if (sessionDiff) {
      sessionDiffInput = { sessionID: decodeURIComponent(sessionDiff[1]), ...query }
      return json([])
    }
    return new Response(null, { status: 404 })
  }
  const client = createOpencodeClient({
    baseUrl: "http://localhost:4096",
    fetch: Object.assign(answer, { preconnect: fetch.preconnect }),
  })
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const commandContext = createCommandContext(keymap)
    context = commandContext
    const registerLayer = keymap.registerLayer.bind(keymap)
    keymap.registerLayer = (layer) => {
      layer.commands?.forEach((command) => commands.set(command.name, command))
      return registerLayer(layer)
    }
    const base = createTuiPluginApi({
      renderer,
      keymap,
      client,
      state: {
        session: {
          get: () => session,
        },
      },
    })
    const api = {
      ...base,
      route: {
        register(routes) {
          renderDiff = routes.find((route) => route.name === "diff")?.render
          return () => {}
        },
        navigate(name, params) {
          current = params ? { name, params } : { name }
        },
        get current() {
          return current
        },
      },
    } satisfies TuiPluginApi

    void diffViewerPlugin.tui(api, undefined, pluginMeta)
    // The component body is synchronous, and diff.open navigates synchronously before the route renders below.
    if (!initialRoute) void commands.get("diff.open")?.run?.(commandContext)

    return (
      <TestTuiContexts>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                {renderDiff?.({ params: "params" in current ? current.params : undefined })}
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height })
  await waitForCommand(app, commands, "diff.close")
  return {
    app,
    commands,
    current: () => current,
    vcsDiffInput: () => vcsDiffInput,
    sessionDiffInput: () => sessionDiffInput,
    run: async (name: string) => {
      const command = commands.get(name)
      if (!command?.run || !context) throw new Error(`command ${name} is not registered`)
      await command.run(context)
    },
  }
}

function createCommandContext(keymap: TuiPluginApi["keymap"]): DiffCommandContext {
  return {
    keymap,
    event: new KeyEvent({
      name: "",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      sequence: "",
      number: false,
      raw: "",
      eventType: "press",
      source: "raw",
    }),
    focused: null,
    target: null,
    data: {},
    input: "",
    payload: undefined,
  }
}

const startRoute: TuiRouteCurrent = { name: "session", params: { sessionID: "session-1" } }

function findScrollBox(root: Renderable): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable && containsDiff(root)) return root
  return root.getChildren().map(findScrollBox).find(Boolean)
}

function containsDiff(root: Renderable): boolean {
  if (root instanceof DiffRenderable) return true
  return root.getChildren().some(containsDiff)
}

const session = {
  id: "session-1",
  slug: "session-1",
  projectID: "project-1",
  directory: "/repo/session",
  title: "Session",
  version: "1",
  time: {
    created: 0,
    updated: 0,
  },
} satisfies Session

test("branch diff source requests branch VCS diff", async () => {
  const viewer = await renderDiffViewer([], 20, {
    name: "diff",
    params: { mode: "branch", sessionID: "session-1", returnRoute: startRoute },
  })
  try {
    expect(viewer.current()).toEqual({
      name: "diff",
      params: { mode: "branch", sessionID: "session-1", returnRoute: startRoute },
    })
    await viewer.app.waitFor(() => viewer.vcsDiffInput() !== undefined)
    expect(viewer.vcsDiffInput()).toEqual({ directory: "/repo/session", mode: "branch", context: "12" })
    expect(viewer.sessionDiffInput()).toBeUndefined()
  } finally {
    viewer.app.renderer.destroy()
  }
})

test("last-turn diff source requests session diff", async () => {
  const viewer = await renderDiffViewer([], 20, {
    name: "diff",
    params: { mode: "last-turn", sessionID: "session-1", messageID: "message-1", returnRoute: startRoute },
  })
  try {
    expect(viewer.current()).toEqual({
      name: "diff",
      params: { mode: "last-turn", sessionID: "session-1", messageID: "message-1", returnRoute: startRoute },
    })
    await viewer.app.waitFor(() => viewer.sessionDiffInput() !== undefined)
    expect(viewer.sessionDiffInput()).toEqual({ sessionID: "session-1", messageID: "message-1" })
    expect(viewer.vcsDiffInput()).toBeUndefined()
  } finally {
    viewer.app.renderer.destroy()
  }
})

async function waitForCommand(
  app: Awaited<ReturnType<typeof testRender>>,
  commands: Map<string, unknown>,
  command: string,
) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await app.renderOnce()
    if (commands.has(command)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const pluginMeta = {
  id: "diff-viewer",
  source: "internal",
  spec: "diff-viewer",
  target: "diff-viewer",
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: "test",
  state: "same",
} satisfies TuiPluginMeta
