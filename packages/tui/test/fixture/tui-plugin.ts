import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { RGBA, type CliRenderer } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createTuiResolvedConfig } from "./tui-runtime"

type Opts = {
  renderer: CliRenderer
  client?: TuiPluginApi["client"]
  keymap?: TuiPluginApi["keymap"]
  attention?: Partial<TuiPluginApi["attention"]>
  event?: TuiPluginApi["event"]
  state?: { session?: Partial<TuiPluginApi["state"]["session"]> }
}

function themeCurrent(): TuiPluginApi["theme"]["current"] {
  const color = RGBA.fromInts(200, 200, 200)
  return {
    primary: color,
    secondary: color,
    accent: color,
    error: color,
    warning: color,
    success: color,
    info: color,
    text: color,
    textMuted: color,
    selectedListItemText: color,
    background: color,
    backgroundPanel: color,
    backgroundElement: color,
    backgroundMenu: color,
    border: color,
    borderActive: color,
    borderSubtle: color,
    diffAdded: color,
    diffRemoved: color,
    diffContext: color,
    diffHunkHeader: color,
    diffHighlightAdded: color,
    diffHighlightRemoved: color,
    diffAddedBg: color,
    diffRemovedBg: color,
    diffContextBg: color,
    diffLineNumber: color,
    diffAddedLineNumberBg: color,
    diffRemovedLineNumberBg: color,
    markdownText: color,
    markdownHeading: color,
    markdownLink: color,
    markdownLinkText: color,
    markdownCode: color,
    markdownBlockQuote: color,
    markdownEmph: color,
    markdownStrong: color,
    markdownHorizontalRule: color,
    markdownListItem: color,
    markdownListEnumeration: color,
    markdownImage: color,
    markdownImageText: color,
    markdownCodeBlock: color,
    syntaxComment: color,
    syntaxKeyword: color,
    syntaxFunction: color,
    syntaxVariable: color,
    syntaxString: color,
    syntaxNumber: color,
    syntaxType: color,
    syntaxOperator: color,
    syntaxPunctuation: color,
    thinkingOpacity: 0.6,
  }
}

export function createTuiPluginApi(opts: Opts): TuiPluginApi {
  const values: Record<string, unknown> = {}
  const lifecycle = new AbortController()

  function kvGet(name: string): unknown
  function kvGet<Value>(name: string, fallback: Value): Value
  function kvGet(name: string, fallback?: unknown) {
    return Object.hasOwn(values, name) ? values[name] : fallback
  }

  return {
    app: { version: "0.0.0-test" },
    attention: {
      notify: async () => ({ ok: false, notification: false, sound: false }),
      soundboard: {
        registerPack: () => () => {},
        activate: () => false,
        current: () => "opencode.default",
        list: () => [],
      },
      ...opts.attention,
    },
    keys: {
      formatSequence: () => "",
      formatBindings: () => undefined,
    },
    keymap: opts.keymap ?? createDefaultOpenTuiKeymap(opts.renderer),
    mode: {
      current: () => "base",
      push: () => () => {},
    },
    route: {
      register: () => () => {},
      navigate: () => {},
      current: { name: "home" },
    },
    ui: {
      Dialog: () => null,
      DialogAlert: () => null,
      DialogConfirm: () => null,
      DialogPrompt: () => null,
      DialogSelect: () => null,
      Slot: () => null,
      Prompt: () => null,
      toast: () => {},
      dialog: { clear() {}, replace() {}, setSize() {}, size: "medium", depth: 0, open: false },
    },
    tuiConfig: createTuiResolvedConfig(),
    kv: {
      get: kvGet,
      set(name, value) {
        values[name] = value
      },
      ready: true,
    },
    state: {
      ready: true,
      config: {},
      provider: [],
      path: { state: "", config: "", worktree: "", directory: "" },
      vcs: undefined,
      session: {
        count: () => 0,
        get: () => undefined,
        diff: () => [],
        todo: () => [],
        messages: () => [],
        status: () => undefined,
        permission: () => [],
        question: () => [],
        ...opts.state?.session,
      },
      part: () => [],
      lsp: () => [],
      mcp: () => [],
    },
    theme: {
      current: themeCurrent(),
      selected: "opencode",
      has: () => false,
      set: () => false,
      install: async () => {},
      mode: () => "dark",
      ready: true,
    },
    client: opts.client ?? createOpencodeClient({ baseUrl: "http://localhost:4096" }),
    event: opts.event ?? { on: () => () => {} },
    renderer: opts.renderer,
    slots: { register: () => "fixture-slot" },
    plugins: {
      list: () => [],
      activate: async () => false,
      deactivate: async () => false,
      add: async () => false,
      install: async () => ({ ok: false, message: "not implemented in fixture" }),
    },
    lifecycle: {
      signal: lifecycle.signal,
      onDispose: () => () => {},
    },
  }
}
