import { render, TimeToFirstDraw, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { registerOpencodeSpinner } from "./component/register-spinner"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { Config, Deferred, Effect, Option, Predicate, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FlagConfig } from "@opencode-ai/core/flag/flag"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ClipboardProvider, useClipboard } from "./context/clipboard"
import { ExitProvider, useExit } from "./context/exit"
import { EpilogueProvider } from "./context/epilogue"
import * as Selection from "./util/selection"
import { createCliRenderer, MouseButton } from "@opentui/core"
import { RouteProvider, useRoute } from "./context/route"
import {
  Switch,
  Match,
  createEffect,
  createMemo,
  ErrorBoundary,
  createSignal,
  onMount,
  onCleanup,
  batch,
  Show,
  on,
} from "solid-js"
import {
  TuiFlagsProvider,
  TuiPathsProvider,
  TuiStartupProvider,
  TuiTerminalEnvironmentProvider,
  useTuiFlags,
  useTuiStartup,
  type TuiStartup,
  type TuiTerminalEnvironment,
} from "./context/runtime"
import { DialogProvider, useDialog } from "./ui/dialog"
import { DialogProvider as DialogProviderList } from "./component/dialog-provider"
import { ErrorComponent } from "./component/error-component"
import { PluginRouteMissing } from "./component/plugin-route-missing"
import { ProjectProvider, useProject } from "./context/project"
import { EditorContextProvider } from "./context/editor"
import { useEvent } from "./context/event"
import { SDKProvider, useSDK } from "./context/sdk"
import { StartupLoading } from "./component/startup-loading"
import { SyncProvider, useSync } from "./context/sync"
import { DataProvider } from "./context/data"
import { LocationProvider } from "./context/location"
import { LocalProvider, useLocal } from "./context/local"
import { PermissionProvider } from "./context/permission"
import { DialogModel } from "./component/dialog-model"
import { useConnected } from "./component/use-connected"
import { DialogMcp } from "./component/dialog-mcp"
import { DialogStatus } from "./component/dialog-status"
import { DialogDebug } from "./component/dialog-debug"
import { DialogThemeList } from "./component/dialog-theme-list"
import { DialogHelp } from "./ui/dialog-help"
import { DialogAgent } from "./component/dialog-agent"
import { DialogSessionList } from "./component/dialog-session-list"
import { DialogWorkspaceList } from "./component/dialog-workspace-list"
import { DialogConsoleOrg } from "./component/dialog-console-org"
import { ThemeProvider, useTheme } from "./context/theme"
import { Home } from "./routes/home"
import { Session } from "./routes/session"
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { DialogAlert } from "./ui/dialog-alert"
import { DialogConfirm } from "./ui/dialog-confirm"
import { ToastProvider, useToast } from "./ui/toast"
import { isDefaultTitle } from "./util/session"
import { KVProvider, useKV } from "./context/kv"
import * as Model from "./util/model"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import open from "open"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { TuiConfigProvider, useTuiConfig, type TuiConfig } from "./config"
import { createTuiApiAdapters } from "./plugin/adapters"
import { createTuiApi } from "./plugin/api"
import { createPluginRuntime, PluginRuntimeProvider, usePluginRuntime, type TuiPluginHost } from "./plugin/runtime"
import { CommandPaletteDialog } from "./component/command-palette"
import {
  COMMAND_PALETTE_COMMAND,
  OPENCODE_BASE_MODE,
  OpencodeKeymapProvider,
  registerOpencodeKeymap,
  useBindings,
  useOpencodeKeymap,
} from "./keymap"

import type { EventSource } from "./context/sdk"
import { DialogVariant } from "./component/dialog-variant"
import { createTuiAttention } from "./attention"
import * as TuiAudio from "./audio"
import { win32DisableProcessedInput, win32FlushInputBuffer } from "./terminal-win32"
import { destroyRenderer } from "./util/renderer"
import { cliErrorMessage, errorFormat } from "./util/error"

registerOpencodeSpinner()

// Run a UI handler program. A defect is logged, as an unhandled rejection reached the console before.
function runHandler(effect: Effect.Effect<void>) {
  Effect.runFork(effect.pipe(Effect.tapDefect((defect) => Effect.logError(defect))))
}

// OpenTUI types a mouse event button as a plain number; narrow it to MouseButton before comparing.
const isMouseButton = Schema.is(Schema.Enum(MouseButton))

const appGlobalBindingCommands = [
  "session.list",
  "session.new",
  "session.quick_switch.1",
  "session.quick_switch.2",
  "session.quick_switch.3",
  "session.quick_switch.4",
  "session.quick_switch.5",
  "session.quick_switch.6",
  "session.quick_switch.7",
  "session.quick_switch.8",
  "session.quick_switch.9",
] as const

const appBindingCommands = [
  "command.palette.show",
  "model.list",
  "model.cycle_recent",
  "model.cycle_recent_reverse",
  "model.cycle_favorite",
  "model.cycle_favorite_reverse",
  "agent.list",
  "mcp.list",
  "agent.cycle",
  "agent.cycle.reverse",
  "variant.cycle",
  "variant.list",
  "provider.connect",
  "console.org.switch",
  "opencode.status",
  "opencode.debug",
  "theme.switch",
  "theme.switch_mode",
  "theme.mode.lock",
  "help.show",
  "docs.open",
  "diff.open",
  "workspace.list",
  "app.debug",
  "app.console",
  "app.heap_snapshot",
  "terminal.suspend",
  "terminal.title.toggle",
  "app.toggle.animations",
  "app.toggle.file_context",
  "app.toggle.diffwrap",
  "app.toggle.paste_summary",
  "app.toggle.session_directory_filter",
] as const

/** The terminal renderer could not start. The cause is the value createCliRenderer rejected with. */
export class TuiRendererError extends Schema.TaggedError<TuiRendererError>()("Tui.RendererError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export type TuiInput = {
  url: string
  args: Args
  config: TuiConfig.Resolved
  onSnapshot?: () => Promise<string[]>
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
  pluginHost: TuiPluginHost
}

function errorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    Predicate.isNotNull(error) &&
    "data" in error &&
    typeof error.data === "object" &&
    Predicate.isNotNull(error.data) &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return error instanceof Error ? error.message : String(error)
}

function isVersionGreater(left: string, right: string) {
  const parse = (value: string) => {
    const [core, prerelease] = value.replace(/^v/, "").split("-", 2)
    return { core: core.split(".").map((part) => Number.parseInt(part, 10) || 0), prerelease }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index++) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (difference) return difference > 0
  }
  if (a.prerelease === b.prerelease) return false
  if (!a.prerelease) return true
  if (!b.prerelease) return false
  return a.prerelease.localeCompare(b.prerelease, [], { numeric: true }) > 0
}

export const run = Effect.fn("Tui.run")(function* (input: TuiInput) {
  const global = yield* Global.Service
  // Every flag has a default, so reading them cannot fail.
  const flags = yield* Config.all({
    OPENCODE_DISABLE_MOUSE: FlagConfig.OPENCODE_DISABLE_MOUSE,
    OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT: FlagConfig.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT,
    OPENCODE_DISABLE_TERMINAL_TITLE: FlagConfig.OPENCODE_DISABLE_TERMINAL_TITLE,
    OPENCODE_EXPERIMENTAL_WORKSPACES: FlagConfig.OPENCODE_EXPERIMENTAL_WORKSPACES,
    OPENCODE_SHOW_TTFD: FlagConfig.OPENCODE_SHOW_TTFD,
  }).pipe(Effect.orDie)
  // The ambient provider treats an empty variable as not set, as the old truthy checks did.
  // OPENCODE_ROUTE must hold JSON; RouteProvider validates the route shape.
  const environment = yield* Config.all({
    TMUX: Config.option(Config.String("TMUX")),
    STY: Config.option(Config.String("STY")),
    WAYLAND_DISPLAY: Config.option(Config.String("WAYLAND_DISPLAY")),
    DISPLAY: Config.option(Config.String("DISPLAY")),
    OPENCODE_ROUTE: Config.option(Config.schema(Schema.fromJsonString(Schema.Json), "OPENCODE_ROUTE")),
    OPENCODE_FAST_BOOT: Config.option(Config.String("OPENCODE_FAST_BOOT")),
  })
  const multiplexer = Option.orElse(Option.as(environment.TMUX, "tmux" as const), () =>
    Option.as(environment.STY, "screen" as const),
  )
  const displayServer = Option.orElse(Option.as(environment.WAYLAND_DISPLAY, "wayland" as const), () =>
    Option.as(environment.DISPLAY, "x11" as const),
  )
  const terminalEnvironment: TuiTerminalEnvironment = {
    platform: process.platform,
    ...Option.match(multiplexer, { onNone: () => ({}), onSome: (value) => ({ multiplexer: value }) }),
    ...Option.match(displayServer, { onNone: () => ({}), onSome: (value) => ({ displayServer: value }) }),
  }
  const startup: TuiStartup = {
    ...Option.match(environment.OPENCODE_ROUTE, { onNone: () => ({}), onSome: (route) => ({ initialRoute: route }) }),
    skipInitialLoading: Option.isSome(environment.OPENCODE_FAST_BOOT),
  }
  const exit: { epilogue: Option.Option<string>; reason: Option.Option<unknown> } = {
    epilogue: Option.none(),
    reason: Option.none(),
  }
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const renderer = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            createCliRenderer({
              externalOutputMode: "passthrough",
              targetFps: 60,
              gatherStats: false,
              exitOnCtrlC: false,
              useKittyKeyboard: {},
              autoFocus: false,
              openConsoleOnError: false,
              useMouse: !flags.OPENCODE_DISABLE_MOUSE && input.config.mouse,
              consoleOptions: {
                keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
              },
            }),
          catch: (cause) =>
            new TuiRendererError({ message: Predicate.isError(cause) ? cause.message : String(cause), cause }),
        }),
        (renderer) =>
          Effect.sync(() => {
            destroyRenderer(renderer)
          }),
      )
      win32DisableProcessedInput()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => registerOpencodeKeymap(keymap, renderer, input.config)),
        (unregister) => Effect.sync(unregister),
      )
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise(() => input.pluginHost.dispose()).pipe(
          Effect.catch((error) => Effect.logError("Failed to dispose TUI plugins", error.cause)),
        ),
      )
      yield* Effect.addFinalizer(() => Effect.sync(TuiAudio.dispose))
      const shutdown = yield* Deferred.make<unknown>()
      const onSighup = () => destroyRenderer(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on("SIGHUP", onSighup)),
        () => Effect.sync(() => process.off("SIGHUP", onSighup)),
      )
      renderer.once("destroy", () => Deferred.doneUnsafe(shutdown, Effect.void))
      const pluginRuntime = createPluginRuntime()

      // Prewarm palette before ThemeProvider mounts so `system` theme avoids a first-paint fallback flash.
      // Start it before the theme-mode query, and ignore a failure, as before.
      yield* Effect.forkChild(Effect.tryPromise(() => renderer.getPalette({ size: 16 })).pipe(Effect.ignore), {
        startImmediately: true,
      })
      const mode = (yield* Effect.tryPromise(() => renderer.waitForThemeMode(1000))) ?? "dark"

      if (!renderer.isDestroyed) {
        yield* Effect.tryPromise(() =>
          render(() => {
            return (
              <ExitProvider
                exit={(reason) => {
                  if (renderer.isDestroyed) return
                  exit.reason = Option.liftPredicate(reason, Predicate.isNotUndefined)
                  destroyRenderer(renderer)
                }}
              >
                <EpilogueProvider
                  set={(value) => {
                    exit.epilogue = Option.fromNullishOr(value)
                  }}
                >
                  <ErrorBoundary
                    fallback={(error, reset) => <ErrorComponent error={error} reset={reset} mode={mode} />}
                  >
                    <TuiPathsProvider
                      value={{
                        cwd: process.cwd(),
                        home: global.home,
                        state: global.state,
                        worktree: global.data + "/worktree",
                      }}
                    >
                      <TuiTerminalEnvironmentProvider value={terminalEnvironment}>
                        <TuiStartupProvider value={startup}>
                          <TuiFlagsProvider value={flags}>
                            <ClipboardProvider>
                              <OpencodeKeymapProvider keymap={keymap}>
                                <ArgsProvider {...input.args}>
                                  <KVProvider>
                                    <ToastProvider>
                                      <RouteProvider
                                        {...(input.args.continue
                                          ? { initialRoute: { type: "session", sessionID: "dummy" } as const }
                                          : {})}
                                      >
                                        <TuiConfigProvider config={input.config}>
                                          <PluginRuntimeProvider value={pluginRuntime}>
                                            <SDKProvider
                                              url={input.url}
                                              directory={input.directory}
                                              fetch={input.fetch}
                                              headers={input.headers}
                                              events={input.events}
                                            >
                                              <PermissionProvider>
                                                <ProjectProvider>
                                                  <SyncProvider>
                                                    <DataProvider>
                                                      <ThemeProvider mode={mode}>
                                                        <LocalProvider>
                                                          <PromptStashProvider>
                                                            <DialogProvider>
                                                              <FrecencyProvider>
                                                                <PromptHistoryProvider>
                                                                  <PromptRefProvider>
                                                                    <EditorContextProvider>
                                                                      <LocationProvider>
                                                                        <App
                                                                          onSnapshot={input.onSnapshot}
                                                                          pluginHost={input.pluginHost}
                                                                        />
                                                                      </LocationProvider>
                                                                    </EditorContextProvider>
                                                                  </PromptRefProvider>
                                                                </PromptHistoryProvider>
                                                              </FrecencyProvider>
                                                            </DialogProvider>
                                                          </PromptStashProvider>
                                                        </LocalProvider>
                                                      </ThemeProvider>
                                                    </DataProvider>
                                                  </SyncProvider>
                                                </ProjectProvider>
                                              </PermissionProvider>
                                            </SDKProvider>
                                          </PluginRuntimeProvider>
                                        </TuiConfigProvider>
                                      </RouteProvider>
                                    </ToastProvider>
                                  </KVProvider>
                                </ArgsProvider>
                              </OpencodeKeymapProvider>
                            </ClipboardProvider>
                          </TuiFlagsProvider>
                        </TuiStartupProvider>
                      </TuiTerminalEnvironmentProvider>
                    </TuiPathsProvider>
                  </ErrorBoundary>
                </EpilogueProvider>
              </ExitProvider>
            )
          }, renderer),
        )
      }
      yield* Deferred.await(shutdown)
      return { epilogue: exit.epilogue, reason: exit.reason }
    }),
  )
  yield* Effect.sync(() => {
    win32FlushInputBuffer()
    if (Option.isSome(result.reason)) {
      const reason = result.reason.value
      process.stderr.write((cliErrorMessage(reason) ?? errorFormat(reason)) + "\n")
      process.exitCode = 1
    }
    if (Option.isSome(result.epilogue) && result.epilogue.value) process.stdout.write(result.epilogue.value + "\n")
  })
})

function App(props: { onSnapshot?: () => Promise<string[]>; pluginHost: TuiPluginHost }) {
  const startup = useTuiStartup()
  const flags = useTuiFlags()
  const tuiConfig = useTuiConfig()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const keymap = useOpencodeKeymap()
  const event = useEvent()
  const sdk = useSDK()
  const toast = useToast()
  const themeState = useTheme()
  const { theme, mode, setMode, locked, lock, unlock } = themeState
  const sync = useSync()
  const project = useProject()
  const exit = useExit()
  const promptRef = usePromptRef()
  const pluginRuntime = usePluginRuntime()
  const attention = createTuiAttention({ renderer, config: tuiConfig, kv })
  const clipboard = useClipboard()

  const api = createTuiApi(
    createTuiApiAdapters({
      version: InstallationVersion,
      tuiConfig,
      dialog,
      keymap,
      kv,
      route,
      routes: pluginRuntime.routes,
      event,
      sdk,
      sync,
      theme: themeState,
      toast,
      renderer,
      attention,
      Slot: pluginRuntime.Slot,
    }),
  )
  const [ready, setReady] = createSignal(false)
  runHandler(
    Effect.tryPromise(() =>
      props.pluginHost.start({
        api,
        config: tuiConfig,
        runtime: pluginRuntime,
        dispose: () => attention.dispose(),
      }),
    ).pipe(
      Effect.catch((error) => Effect.logError("Failed to load TUI plugins", error.cause)),
      Effect.ensuring(Effect.sync(() => setReady(true))),
    ),
  )

  // Copy text and confirm with a toast; a failed write shows an error toast. Without a clipboard it does nothing.
  const copyWithToast = (text: string, message: string) =>
    Effect.gen(function* () {
      const write = clipboard.write?.bind(clipboard)
      if (!write) return
      yield* Effect.tryPromise(() => write(text)).pipe(
        Effect.andThen(Effect.sync(() => toast.show({ message, variant: "info" }))),
        Effect.catch((error) => Effect.sync(() => toast.error(error.cause))),
      )
    })

  // Let selection copy/dismiss win ahead of normal bindings when explicit copy is required.
  const offSelectionKeys = keymap.intercept(
    "key",
    ({ event }) => {
      if (!flags.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
      Selection.handleSelectionKey(renderer, toast, event, clipboard)
    },
    { priority: 1 },
  )
  onCleanup(() => {
    offSelectionKeys()
    attention.dispose()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = (text: string) => {
    if (!text || text.length === 0) return
    runHandler(
      copyWithToast(text, "Copied to clipboard").pipe(Effect.andThen(Effect.sync(() => renderer.clearSelection()))),
    )
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))
  const [pasteSummaryEnabled, setPasteSummaryEnabled] = createSignal(
    kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary),
  )

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (!terminalTitleEnabled() || flags.OPENCODE_DISABLE_TERMINAL_TITLE) return

    if (route.data.type === "home") {
      renderer.setTerminalTitle("OpenCode")
      return
    }

    if (route.data.type === "session") {
      const session = sync.session.get(route.data.sessionID)
      if (!session || isDefaultTitle(session.title)) {
        renderer.setTerminalTitle("OpenCode")
        return
      }

      const title = session.title.length > 40 ? session.title.slice(0, 37) + "…" : session.title
      renderer.setTerminalTitle(`OC | ${title}`)
      return
    }

    if (route.data.type === "plugin") {
      renderer.setTerminalTitle(`OC | ${route.data.id}`)
    }
  })

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerID, modelID } = Model.parse(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  let continued = false
  createEffect(() => {
    // When using -c, session list is loaded in blocking phase, so we can navigate at "partial"
    if (continued || sync.status === "loading" || !args.continue) return
    const match = sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined)?.id
    if (match) {
      continued = true
      if (args.fork) {
        void sdk.client.session.fork({ sessionID: match }).then((result) => {
          if (result.data?.id) {
            route.navigate({ type: "session", sessionID: result.data.id })
          } else {
            toast.show({ message: "Failed to fork session", variant: "error" })
          }
        })
      } else {
        route.navigate({ type: "session", sessionID: match })
      }
    }
  })

  // Handle --session with --fork: wait for sync to be fully complete before forking
  // (session list loads in non-blocking phase for --session, so we must wait for "complete"
  // to avoid a race where reconcile overwrites the newly forked session)
  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    void sdk.client.session.fork({ sessionID: args.sessionID }).then((result) => {
      if (result.data?.id) {
        route.navigate({ type: "session", sessionID: result.data.id })
      } else {
        toast.show({ message: "Failed to fork session", variant: "error" })
      }
    })
  })

  createEffect(
    on(
      () => sync.status === "complete" && sync.data.provider.length === 0,
      (isEmpty, wasEmpty) => {
        // only trigger when we transition into an empty-provider state
        if (!isEmpty || wasEmpty) return
        dialog.replace(() => <DialogProviderList />)
      },
    ),
  )

  const connected = useConnected()
  const currentWorktreeWorkspace = createMemo(() => {
    const workspaceID = project.workspace.current()
    if (!workspaceID) return
    const workspace = project.workspace.get(workspaceID)
    if (workspace?.type !== "worktree" || !workspace.directory) return
    return workspace
  })
  const appCommands = createMemo(() =>
    [
      {
        name: COMMAND_PALETTE_COMMAND,
        title: "Show command palette",
        category: "System",
        hidden: true,
        run: () => {
          dialog.replace(() => <CommandPaletteDialog />)
        },
      },
      {
        name: "session.list",
        title: "Switch session",
        category: "Session",
        suggested: sync.data.session.length > 0,
        slashName: "sessions",
        slashAliases: ["resume", "continue"],
        run: () => {
          dialog.replace(() => <DialogSessionList />)
        },
      },
      {
        name: "session.new",
        title: "New session",
        suggested: route.data.type === "session",
        category: "Session",
        slashName: "new",
        slashAliases: ["clear"],
        run: () => {
          route.navigate({
            type: "home",
          })
          dialog.clear()
        },
      },
      {
        name: "workspace.copy_path",
        title: "Copy worktree path",
        category: "Workspace",
        enabled: () => currentWorktreeWorkspace() !== undefined,
        run: () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const workspace = currentWorktreeWorkspace()
              if (!workspace?.directory) return
              yield* copyWithToast(workspace.directory, "Copied worktree path")
              dialog.clear()
            }),
          ),
      },
      {
        name: "workspace.list",
        title: "Manage workspaces",
        category: "Workspace",
        hidden: !flags.OPENCODE_EXPERIMENTAL_WORKSPACES,
        slashName: "workspaces",
        run: () => {
          dialog.replace(() => <DialogWorkspaceList />)
        },
      },
      ...Array.from({ length: 9 }, (_, i) => ({
        name: `session.quick_switch.${i + 1}`,
        title: `Switch to session in quick slot ${i + 1}`,
        category: "Session",
        hidden: true,
        run: () => {
          local.session.quickSwitch(i + 1)
        },
      })),
      {
        name: "model.list",
        title: "Switch model",
        suggested: true,
        category: "Agent",
        slashName: "models",
        // Bias /mo toward /models over /move without changing global fuzzy scoring.
        slashAliases: ["mo"],
        run: () => {
          dialog.replace(() => <DialogModel />)
        },
      },
      {
        name: "model.cycle_recent",
        title: "Model cycle",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycle(1)
        },
      },
      {
        name: "model.cycle_recent_reverse",
        title: "Model cycle reverse",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycle(-1)
        },
      },
      {
        name: "model.cycle_favorite",
        title: "Favorite cycle",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycleFavorite(1)
        },
      },
      {
        name: "model.cycle_favorite_reverse",
        title: "Favorite cycle reverse",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycleFavorite(-1)
        },
      },
      {
        name: "agent.list",
        title: "Switch agent",
        category: "Agent",
        slashName: "agents",
        run: () => {
          dialog.replace(() => <DialogAgent />)
        },
      },
      {
        name: "mcp.list",
        title: "Toggle MCPs",
        category: "Agent",
        slashName: "mcps",
        run: () => {
          dialog.replace(() => <DialogMcp />)
        },
      },
      {
        name: "agent.cycle",
        title: "Agent cycle",
        category: "Agent",
        hidden: true,
        run: () => {
          local.agent.move(1)
        },
      },
      {
        name: "variant.cycle",
        title: "Variant cycle",
        category: "Agent",
        run: () => {
          local.model.variant.cycle()
        },
      },
      {
        name: "variant.list",
        title: "Switch model variant",
        category: "Agent",
        hidden: local.model.variant.list().length === 0,
        slashName: "variants",
        run: () => {
          if (local.model.variant.list().length === 0) {
            return toast.show({
              title: "No variants available",
              message: "The current model does not support any variants.",
              variant: "info",
            })
          }
          dialog.replace(() => <DialogVariant />)
        },
      },
      {
        name: "agent.cycle.reverse",
        title: "Agent cycle reverse",
        category: "Agent",
        hidden: true,
        run: () => {
          local.agent.move(-1)
        },
      },
      {
        name: "provider.connect",
        title: "Connect provider",
        suggested: !connected(),
        slashName: "connect",
        run: () => {
          dialog.replace(() => <DialogProviderList />)
        },
        category: "Provider",
      },
      ...(sync.data.console_state.switchableOrgCount > 1
        ? [
            {
              name: "console.org.switch",
              title: "Switch org",
              suggested: Boolean(sync.data.console_state.activeOrgName),
              slashName: "org",
              slashAliases: ["orgs", "switch-org"],
              run: () => {
                dialog.replace(() => <DialogConsoleOrg />)
              },
              category: "Provider",
            },
          ]
        : []),
      {
        name: "opencode.status",
        title: "View status",
        slashName: "status",
        run: () => {
          dialog.replace(() => <DialogStatus />)
        },
        category: "System",
      },
      {
        name: "opencode.debug",
        title: "View debug info",
        slashName: "debug",
        run: () => {
          dialog.replace(() => <DialogDebug />)
        },
        category: "System",
      },
      {
        name: "theme.switch",
        title: "Switch theme",
        slashName: "themes",
        run: () => {
          dialog.replace(() => <DialogThemeList />)
        },
        category: "System",
      },
      {
        name: "theme.switch_mode",
        title: mode() === "dark" ? "Switch to light mode" : "Switch to dark mode",
        run: () => {
          setMode(mode() === "dark" ? "light" : "dark")
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "theme.mode.lock",
        title: locked() ? "Unlock theme mode" : "Lock theme mode",
        run: () => {
          if (locked()) unlock()
          else lock()
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "help.show",
        title: "Help",
        slashName: "help",
        run: () => {
          dialog.replace(() => <DialogHelp />)
        },
        category: "System",
      },
      {
        name: "docs.open",
        title: "Open docs",
        run: () => {
          open("https://opencode.ai/docs").catch(() => {})
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "app.exit",
        title: "Exit the app",
        slashName: "exit",
        slashAliases: ["quit", "q"],
        run: () => exit(),
        category: "System",
      },
      {
        name: "app.debug",
        title: "Toggle debug panel",
        category: "System",
        run: () => {
          renderer.toggleDebugOverlay()
          dialog.clear()
        },
      },
      {
        name: "app.console",
        title: "Toggle console",
        category: "System",
        run: () => {
          renderer.console.toggle()
          dialog.clear()
        },
      },
      {
        name: "app.heap_snapshot",
        title: "Write heap snapshot",
        category: "System",
        run: () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const snapshot = props.onSnapshot
              const files = snapshot ? yield* Effect.promise(() => snapshot()) : []
              toast.show({
                variant: "info",
                message: `Heap snapshot written to ${files.join(", ")}`,
                duration: 5000,
              })
              dialog.clear()
            }),
          ),
      },
      {
        name: "terminal.suspend",
        title: "Suspend terminal",
        category: "System",
        hidden: true,
        enabled: process.platform !== "win32",
        run: () => {
          renderer.suspend()
          process.once("SIGCONT", () => renderer.resume())
          process.kill(0, "SIGTSTP")
        },
      },
      {
        name: "terminal.title.toggle",
        title: terminalTitleEnabled() ? "Disable terminal title" : "Enable terminal title",
        category: "System",
        run: () => {
          setTerminalTitleEnabled((prev) => {
            const next = !prev
            kv.set("terminal_title_enabled", next)
            if (!next) renderer.setTerminalTitle("")
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.animations",
        title: kv.get("animations_enabled", true) ? "Disable animations" : "Enable animations",
        category: "System",
        run: () => {
          kv.set("animations_enabled", !kv.get("animations_enabled", true))
          dialog.clear()
        },
      },
      {
        name: "app.toggle.file_context",
        title: kv.get("file_context_enabled", true) ? "Disable file context" : "Enable file context",
        category: "System",
        run: () => {
          kv.set("file_context_enabled", !kv.get("file_context_enabled", true))
          dialog.clear()
        },
      },
      {
        name: "app.toggle.diffwrap",
        title: kv.get("diff_wrap_mode", "word") === "word" ? "Disable diff wrapping" : "Enable diff wrapping",
        category: "System",
        run: () => {
          const current = kv.get("diff_wrap_mode", "word")
          kv.set("diff_wrap_mode", current === "word" ? "none" : "word")
          dialog.clear()
        },
      },
      {
        name: "app.toggle.paste_summary",
        title: pasteSummaryEnabled() ? "Disable paste summary" : "Enable paste summary",
        category: "System",
        run: () => {
          setPasteSummaryEnabled((prev) => {
            const next = !prev
            kv.set("paste_summary_enabled", next)
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.session_directory_filter",
        title: kv.get("session_directory_filter_enabled", true)
          ? "Disable session directory filtering"
          : "Enable session directory filtering",
        category: "System",
        run: () =>
          Effect.runPromise(
            Effect.gen(function* () {
              kv.set("session_directory_filter_enabled", !kv.get("session_directory_filter_enabled", true))
              yield* Effect.promise(() => sync.session.refresh())
              dialog.clear()
            }),
          ),
      },
      {
        name: "permission.mode",
        title:
          local.permission.mode === "auto" ? "Disable auto-approve permissions" : "Enable auto-approve permissions",
        category: "System",
        run: () => {
          local.permission.toggle()
          dialog.clear()
        },
      },
    ].map((command) => ({
      namespace: "palette",
      ...command,
    })),
  )

  useBindings(() => ({
    commands: appCommands(),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("app", appBindingCommands),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("app.global", appGlobalBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: () => {
      const current = promptRef.current
      if (!current?.focused) return true
      return current.current.input === ""
    },
    bindings: tuiConfig.keybinds.gather("app_exit", ["app.exit"]),
  }))

  event.on("tui.command.execute", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    keymap.dispatchCommand(evt.properties.command)
  })

  event.on("tui.toast.show", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    toast.show({
      title: evt.properties.title,
      message: evt.properties.message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
    })
  })

  event.on("tui.session.select", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    route.navigate({
      type: "session",
      sessionID: evt.properties.sessionID,
    })
  })

  event.on("session.deleted", (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: "The current session was deleted",
      })
    }
  })

  event.on("session.error", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    const error = evt.properties.error
    if (error && typeof error === "object" && error.name === "MessageAbortedError") return
    const message = errorMessage(error)

    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })
  })

  event.on("installation.update-available", (evt) =>
    runHandler(
      Effect.gen(function* () {
        yield* Effect.logInfo("installation.update-available", evt)
        const version = evt.properties.version

        const skipped = kv.get("skipped_version")
        if (skipped && !isVersionGreater(version, skipped)) return

        const choice = yield* Effect.promise(() =>
          DialogConfirm.show(
            dialog,
            `Update Available`,
            `A new release v${version} is available. Would you like to update now?`,
            "skip",
          ),
        )

        if (choice === false) {
          kv.set("skipped_version", version)
          return
        }

        if (choice !== true) return

        toast.show({
          variant: "info",
          message: `Updating to v${version}…`,
          duration: 30000,
        })

        const result = yield* Effect.promise(() => sdk.client.global.upgrade({ target: version }))

        if (result.error || !result.data?.success) {
          toast.show({
            variant: "error",
            title: "Update Failed",
            message: "Update failed",
            duration: 10000,
          })
          return
        }

        const upgraded = result.data.version
        yield* Effect.promise(() =>
          DialogAlert.show(
            dialog,
            "Update Complete",
            `Successfully updated to OpenCode v${upgraded}. Please restart the application.`,
          ),
        )

        exit()
      }),
    ),
  )

  const plugin = createMemo(() => {
    if (!ready()) return
    if (route.data.type !== "plugin") return
    const render = pluginRuntime.routes.get(route.data.id)
    if (!render) return <PluginRouteMissing id={route.data.id} onHome={() => route.navigate({ type: "home" })} />
    return render({ params: route.data.data })
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
      onMouseDown={(evt) => {
        if (!flags.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
        if (!isMouseButton(evt.button) || evt.button !== MouseButton.RIGHT) return

        if (!Selection.copy(renderer, toast, clipboard)) return
        evt.preventDefault()
        evt.stopPropagation()
      }}
      {...(flags.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
        ? {}
        : { onMouseUp: () => Selection.copy(renderer, toast, clipboard) })}
    >
      <Show when={flags.OPENCODE_SHOW_TTFD}>
        <TimeToFirstDraw />
      </Show>
      <Show when={ready()}>
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <Switch>
            <Match when={route.data.type === "home"}>
              <Home />
            </Match>
            <Match when={route.data.type === "session"}>
              <Show when={route.data.type === "session" && route.data.sessionID} keyed>
                {(_) => <Session />}
              </Show>
            </Match>
          </Switch>
          {plugin()}
        </box>
        <box flexShrink={0}>
          <pluginRuntime.Slot name="app_bottom" />
        </box>
        <pluginRuntime.Slot name="app" />
      </Show>
      <Show when={!startup.skipInitialLoading}>
        <StartupLoading ready={ready} />
      </Show>
    </box>
  )
}
