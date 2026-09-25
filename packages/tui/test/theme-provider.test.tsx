/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { TuiConfigProvider } from "../src/config"
import { KVProvider, useKV } from "../src/context/kv"
import { DEFAULT_THEMES, ThemeDiscoveryError, ThemeProvider, useTheme, type ThemeSource } from "../src/context/theme"
import { tmpdir } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

type Contexts = {
  theme: ReturnType<typeof useTheme>
  kv: ReturnType<typeof useKV>
}

async function waitFor(condition: () => boolean, timeout = 20000) {
  const start = performance.now()
  while (!condition()) {
    if (performance.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountTheme(root: string, source: ThemeSource, theme?: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const contexts: Contexts[] = []

  function Probe() {
    contexts.push({ theme: useTheme(), kv: useKV() })
    return <box />
  }

  const config = createTuiResolvedConfig(theme === undefined ? {} : { theme })
  const app = await testRender(() => (
    <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
      <TuiConfigProvider config={config}>
        <KVProvider>
          <ThemeProvider mode="dark" source={source}>
            <Probe />
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  ))
  await waitFor(() => contexts.length > 0)
  const [mounted] = contexts
  if (mounted === undefined) throw new Error("the theme provider did not render")
  await waitFor(() => mounted.theme.ready)
  return { app, ...mounted }
}

test("theme provider loads only valid custom themes", async () => {
  await using tmp = await tmpdir()
  const custom = structuredClone(DEFAULT_THEMES.opencode)
  const { app, theme } = await mountTheme(tmp.path, { discover: Effect.succeed({ custom, notTheme: { a: 1 } }) })
  try {
    expect(theme.has("custom")).toBe(true)
    expect(theme.has("notTheme")).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("theme provider persists the mode lock only while locked", async () => {
  await using tmp = await tmpdir()
  const { app, theme, kv } = await mountTheme(tmp.path, { discover: Effect.succeed({}) })
  try {
    expect(theme.locked()).toBe(false)
    theme.setMode("light")
    expect(theme.locked()).toBe(true)
    expect(theme.mode()).toBe("light")
    expect(kv.get("theme_mode_lock")).toBe("light")
    expect(kv.get("theme_mode")).toBe("light")
    theme.unlock()
    expect(theme.locked()).toBe(false)
    expect(Object.keys(kv.store)).not.toContain("theme_mode_lock")
    expect(Object.keys(kv.store)).not.toContain("theme_mode")
  } finally {
    app.renderer.destroy()
  }
})

test("theme provider resets the active theme when discovery fails", async () => {
  await using tmp = await tmpdir()
  const { app, theme } = await mountTheme(
    tmp.path,
    { discover: Effect.fail(new ThemeDiscoveryError({ message: "discovery failed" })) },
    "custom",
  )
  try {
    expect(theme.selected).toBe("opencode")
  } finally {
    app.renderer.destroy()
  }
})

test("theme provider falls back to opencode when a theme reference does not resolve", async () => {
  await using tmp = await tmpdir()
  const broken = structuredClone(DEFAULT_THEMES.opencode)
  broken.theme.primary = "missing"
  broken.theme.accent = "#123456"
  const { app, theme } = await mountTheme(tmp.path, { discover: Effect.succeed({ broken }) })
  try {
    const accent = theme.theme.accent
    expect(theme.set("broken")).toBe(true)
    expect(theme.selected).toBe("broken")
    expect(theme.theme.accent).toEqual(accent)
  } finally {
    app.renderer.destroy()
  }
})
