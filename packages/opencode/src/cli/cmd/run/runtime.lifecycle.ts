// Lifecycle management for the split-footer renderer.
//
// Creates the OpenTUI CliRenderer in split-footer mode, resolves the theme
// from the terminal palette, writes the entry splash to scrollback, and
// constructs the RunFooter. Returns a Lifecycle handle whose close() writes
// the exit splash and tears everything down in the right order:
// footer.close → footer.destroy → renderer shutdown.
//
// Also wires SIGINT so Ctrl-c clears a live prompt draft first, then falls
// back to the usual two-press exit sequence through RunFooter.requestExit().
import path from "path"
import { CliRenderEvents, createCliRenderer, type CliRenderer, type ScrollbackWriter } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { Effect, Option, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { openEditor } from "@opencode-ai/tui/editor"
import { registerOpencodeKeymap } from "@opencode-ai/tui/keymap"
import { Session as SessionApi } from "@/session/session"
import * as Locale from "@/util/locale"
import { interactiveStdin } from "./runtime.stdin"
import { entrySplash, exitSplash, splashMeta } from "./splash"
import { resolveRunTheme } from "./theme"
import type {
  FooterApi,
  PermissionReply,
  QuestionReject,
  QuestionReply,
  RunAgent,
  RunInput,
  RunPrompt,
  RunResource,
  RunTuiConfig,
} from "./types"
import { formatModelLabel } from "./variant.shared"

const FOOTER_HEIGHT = 4

// The renderer or the footer closed before the requested work could run.
export class RuntimeClosedError extends Schema.TaggedError<RuntimeClosedError>()("RuntimeClosedError", {
  message: Schema.String,
}) {}

const runtimeClosed = () => new RuntimeClosedError({ message: "runtime closed" })

// Waits for a Promise and ignores its failure.
const settle = (run: () => Promise<unknown>) => Effect.tryPromise(run).pipe(Effect.ignore)

type SplashState = {
  entry: boolean
  exit: boolean
}

type CycleResult = {
  modelLabel?: string
  status?: string
  variant?: string | undefined
  variants?: string[]
}

type FooterLabels = {
  agentLabel: string
  modelLabel: string
}

export type LifecycleInput = {
  directory: string
  findFiles: (query: string) => Promise<string[]>
  agents: RunAgent[]
  resources: RunResource[]
  sessionID: string
  sessionTitle?: string
  getSessionID?: () => string | undefined
  first: boolean
  history: RunPrompt[]
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
  tuiConfig: RunTuiConfig
  backgroundSubagents: boolean
  onPermissionReply: (input: PermissionReply) => void | Promise<void>
  onQuestionReply: (input: QuestionReply) => void | Promise<void>
  onQuestionReject: (input: QuestionReject) => void | Promise<void>
  onCycleVariant?: () => CycleResult | void
  onModelSelect?: (model: NonNullable<RunInput["model"]>) => CycleResult | void | Promise<CycleResult | void>
  onVariantSelect?: (variant: string | undefined) => CycleResult | void | Promise<CycleResult | void>
  onInterrupt?: () => void
  onBackground?: () => void
  onSubagentSelect?: (sessionID: string | undefined) => void
}

export type Lifecycle = {
  footer: FooterApi
  onResize(fn: () => void): () => void
  refreshTheme(): void
  resetForReplay(input: { sessionTitle?: string; sessionID?: string; history: RunPrompt[] }): Promise<void>
  close(input: { showExit: boolean; sessionTitle?: string; sessionID?: string; history?: RunPrompt[] }): Promise<void>
}

// Gracefully tears down the renderer. Order matters: switch external output
// back to passthrough before leaving split-footer mode, so pending stdout
// doesn't get captured into the now-dead scrollback pipeline.
function shutdown(renderer: CliRenderer): void {
  if (renderer.isDestroyed) {
    return
  }

  if (renderer.externalOutputMode === "capture-stdout") {
    renderer.externalOutputMode = "passthrough"
  }

  if (renderer.screenMode === "split-footer") {
    renderer.screenMode = "main-screen"
  }

  if (!renderer.isDestroyed) {
    renderer.destroy()
  }
}

function splashInfo(title: string | undefined, history: RunPrompt[]) {
  if (title && !SessionApi.isDefaultTitle(title)) {
    return {
      title,
      showSession: true,
    }
  }

  const next = history.find((item) => item.text.trim().length > 0)
  return {
    title: next?.text ?? title,
    showSession: !!next,
  }
}

function footerLabels(input: Pick<RunInput, "agent" | "model" | "variant">): FooterLabels {
  const agentLabel = Locale.titlecase(input.agent ?? "build")

  if (!input.model) {
    return {
      agentLabel,
      modelLabel: "Model default",
    }
  }

  return {
    agentLabel,
    modelLabel: formatModelLabel(input.model, input.variant),
  }
}

function directoryLabel(directory: string, home: string) {
  const resolved = path.resolve(directory)
  const display =
    resolved === home ? "~" : resolved.startsWith(`${home}${path.sep}`) ? resolved.replace(home, "~") : resolved
  return display.replaceAll("\\", "/")
}

function queueSplash(
  renderer: Pick<CliRenderer, "writeToScrollback" | "requestRender">,
  state: SplashState,
  phase: keyof SplashState,
  write: ScrollbackWriter | undefined,
): boolean {
  if (state[phase]) {
    return false
  }

  if (!write) {
    return false
  }

  state[phase] = true
  renderer.writeToScrollback(write)
  renderer.requestRender()
  return true
}

// Boots the split-footer renderer and constructs the RunFooter.
//
// The renderer starts in split-footer mode with captured stdout so that
// scrollback commits and footer repaints happen in the same frame. After
// the entry splash, RunFooter takes over the footer region.
export function createRuntimeLifecycle(input: LifecycleInput): Promise<Lifecycle> {
  return Effect.runPromise(makeLifecycle(input).pipe(Effect.provide(Global.layerWith({}))))
}

const makeLifecycle = Effect.fnUntraced(function* (input: LifecycleInput) {
  const home = (yield* Global.Service).home
  const source = yield* Effect.fromResult(interactiveStdin())
  let unregisterKeymap = Option.none<() => void>()

  const build = Effect.gen(function* () {
    const renderer = yield* Effect.promise(() =>
      createCliRenderer({
        stdin: source.stdin,
        targetFps: 30,
        maxFps: 60,
        useMouse: false,
        autoFocus: false,
        openConsoleOnError: false,
        exitOnCtrlC: false,
        useKittyKeyboard: { events: process.platform === "win32" },
        screenMode: "split-footer",
        footerHeight: FOOTER_HEIGHT,
        externalOutputMode: "capture-stdout",
        consoleMode: "disabled",
        clearOnShutdown: false,
      }),
    )
    const theme = yield* Effect.promise(() => resolveRunTheme(renderer))
    renderer.setBackgroundColor(theme.background)
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const unregister = registerOpencodeKeymap(keymap, renderer, input.tuiConfig)
    unregisterKeymap = Option.some(unregister)
    const state: SplashState = {
      entry: false,
      exit: false,
    }
    const splash = splashInfo(input.sessionTitle, input.history)
    const meta = splashMeta({
      title: splash.title,
      session_id: input.sessionID,
    })
    const labels = footerLabels({
      agent: input.agent,
      model: input.model,
      variant: input.variant,
    })
    const footerTask = import("./footer")
    const wrote = queueSplash(
      renderer,
      state,
      "entry",
      entrySplash({
        ...meta,
        theme: theme.splash,
        showSession: splash.showSession,
        detail: directoryLabel(input.directory, home),
      }),
    )
    yield* settle(() => renderer.idle())

    const { RunFooter } = yield* Effect.promise(() => footerTask)
    let closed = false
    let sigintRegistered = false

    const sigint = () => {
      footer.requestExit()
    }

    const attachSigint = () => {
      if (closed || sigintRegistered) {
        return
      }

      process.on("SIGINT", sigint)
      sigintRegistered = true
    }

    const detachSigint = () => {
      if (!sigintRegistered) {
        return
      }

      process.off("SIGINT", sigint)
      sigintRegistered = false
    }

    // Opens the external editor. SIGINT is ignored while the editor owns the
    // terminal, and the footer handler comes back when the editor exits.
    const editorOpen = (value: string) =>
      Effect.gen(function* () {
        if (closed || renderer.isDestroyed) {
          return Option.none<string>()
        }

        yield* settle(() => renderer.idle())
        const ignore = () => {}
        detachSigint()
        process.on("SIGINT", ignore)
        return yield* Effect.promise(() =>
          openEditor({
            value,
            cwd: input.directory,
            renderer,
            stdin: source.stdin,
          }),
        ).pipe(
          Effect.map(Option.fromNullishOr),
          Effect.ensuring(
            Effect.sync(() => {
              process.off("SIGINT", ignore)
              attachSigint()
            }),
          ),
        )
      })

    const footer = new RunFooter(renderer, {
      directory: input.directory,
      findFiles: input.findFiles,
      agents: input.agents,
      resources: input.resources,
      sessionID: input.getSessionID ?? (() => input.sessionID),
      ...labels,
      model: input.model,
      variant: input.variant,
      first: input.first,
      history: input.history,
      theme,
      wrote,
      keymap,
      tuiConfig: input.tuiConfig,
      backgroundSubagents: input.backgroundSubagents,
      diffStyle: input.tuiConfig.diff_style ?? "auto",
      onPermissionReply: input.onPermissionReply,
      onQuestionReply: input.onQuestionReply,
      onQuestionReject: input.onQuestionReject,
      onCycleVariant: input.onCycleVariant,
      onModelSelect: input.onModelSelect,
      onVariantSelect: input.onVariantSelect,
      onInterrupt: input.onInterrupt,
      onBackground: input.onBackground,
      onEditorOpen: ({ value }) => Effect.runPromise(editorOpen(value).pipe(Effect.map(Option.getOrUndefined))),
      onSubagentSelect: input.onSubagentSelect,
    })

    attachSigint()

    const close = (next: { showExit: boolean; sessionTitle?: string; sessionID?: string; history?: RunPrompt[] }) =>
      Effect.gen(function* () {
        if (closed) {
          return
        }

        closed = true
        detachSigint()
        let wroteExit = false

        yield* Effect.gen(function* () {
          yield* settle(() => footer.idle())

          const show = renderer.isDestroyed ? false : next.showExit
          if (renderer.isDestroyed || !show) {
            return
          }

          const sessionID = next.sessionID || input.getSessionID?.() || input.sessionID
          const splash = splashInfo(next.sessionTitle ?? input.sessionTitle, next.history ?? input.history)
          wroteExit = queueSplash(
            renderer,
            state,
            "exit",
            exitSplash({
              ...splashMeta({
                title: splash.title,
                session_id: sessionID,
              }),
              theme: footer.currentTheme().splash,
            }),
          )
          yield* settle(() => renderer.idle())
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              footer.close()
              yield* settle(() => footer.idle())
              footer.destroy()
              unregister()
              shutdown(renderer)
              if (!wroteExit) {
                process.stdout.write("\n")
              }
              source.cleanup?.()
            }),
          ),
        )
      })

    // Fails when the lifecycle, the renderer or the footer has closed.
    const ensureOpen = Effect.suspend(() =>
      closed || renderer.isDestroyed || footer.isClosed ? Effect.fail(runtimeClosed()) : Effect.void,
    )

    const resetForReplay = (next: { sessionTitle?: string; sessionID?: string; history: RunPrompt[] }) =>
      Effect.gen(function* () {
        yield* ensureOpen
        yield* Effect.promise(() => footer.idle())
        yield* ensureOpen

        footer.resetForReplay(true)
        renderer.resetSplitFooterForReplay({ clearSavedLines: true })
        const splash = splashInfo(next.sessionTitle ?? input.sessionTitle, next.history)
        renderer.writeToScrollback(
          entrySplash({
            ...splashMeta({
              title: splash.title,
              session_id: next.sessionID ?? input.getSessionID?.() ?? input.sessionID,
            }),
            theme: footer.currentTheme().splash,
            showSession: splash.showSession,
            detail: directoryLabel(input.directory, home),
          }),
        )
        renderer.requestRender()
      })

    const lifecycle: Lifecycle = {
      footer,
      refreshTheme() {
        footer.refreshTheme()
      },
      onResize(fn) {
        let width = renderer.terminalWidth
        let height = renderer.terminalHeight
        const resize = () => {
          if (width === renderer.terminalWidth && height === renderer.terminalHeight) {
            return
          }

          width = renderer.terminalWidth
          height = renderer.terminalHeight
          fn()
        }
        renderer.on(CliRenderEvents.RESIZE, resize)
        return () => renderer.off(CliRenderEvents.RESIZE, resize)
      },
      resetForReplay: (next) => Effect.runPromise(resetForReplay(next)),
      close: (next) => Effect.runPromise(close(next)),
    }
    return lifecycle
  })

  return yield* build.pipe(
    Effect.onError(() =>
      Effect.sync(() => {
        if (Option.isSome(unregisterKeymap)) {
          unregisterKeymap.value()
        }
        source.cleanup?.()
      }),
    ),
  )
})
