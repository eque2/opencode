import { withAlpha } from "@opencode-ai/ui/theme/color"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { resolveThemeVariant } from "@opencode-ai/ui/theme/resolve"
import { resolveThemeVariantV2 } from "@opencode-ai/ui/theme/v2/resolve"
import type { HexColor, ResolvedV2Theme } from "@opencode-ai/ui/theme/types"
import { isHexColor } from "@opencode-ai/ui/theme/validate"
import { showToast } from "@/utils/toast"
import type { FitAddon, Ghostty, Terminal as Term } from "ghostty-web"
import { Cause, Chunk, Data, Duration, Effect, Option, Predicate, References, Result, Schema } from "effect"
import { type ComponentProps, createEffect, createMemo, onCleanup, onMount, splitProps } from "solid-js"
import { SerializeAddon } from "@/addons/serialize"
import { matchKeybind, parseKeybind } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { terminalFontFamily, useSettings } from "@/context/settings"
import type { LocalPTY } from "@/context/terminal"
import { createFiberSlot } from "@/utils/fiber-slot"
import { disposeIfDisposable, getHoveredLinkText, setOptionIfSupported } from "@/utils/runtime-adapters"
import { terminalRequest } from "@/utils/terminal-request"
import { terminalWriter } from "@/utils/terminal-writer"
import { terminalWebSocketURL } from "@/utils/terminal-websocket-url"

const TOGGLE_TERMINAL_ID = "terminal.toggle"
const DEFAULT_TOGGLE_TERMINAL_KEYBIND = "ctrl+`"
export interface TerminalProps extends ComponentProps<"div"> {
  pty: LocalPTY
  autoFocus?: boolean
  onAutoFocus?: () => void
  onSubmit?: () => void
  onCleanup?: (pty: Partial<LocalPTY> & { id: string }) => void
  onConnect?: () => void
  onConnectError?: (error: unknown) => void
}

/** The server refused a PTY connect ticket. `message` is the localized reason. */
class TerminalTicketError extends Data.TaggedError("App.TerminalTicketError")<{ readonly message: string }> {}

/** The PTY socket closed with a code other than 1000. */
class TerminalConnectionLostError extends Data.TaggedError("App.TerminalConnectionLostError")<{
  readonly message: string
  readonly code: number
}> {}

type LoadedGhostty = { mod: typeof import("ghostty-web"); ghostty: Ghostty }

// Every terminal shares one load. A failed load clears it, so the next terminal loads again.
let shared: Option.Option<Promise<LoadedGhostty>> = Option.none()

const importGhostty = Effect.gen(function* () {
  const mod = yield* Effect.promise(() => import("ghostty-web"))
  const ghostty = yield* Effect.promise(() => mod.Ghostty.load())
  return { mod, ghostty }
}).pipe(
  Effect.onError(() =>
    Effect.sync(() => {
      shared = Option.none()
    }),
  ),
)

const loadGhostty = Effect.suspend(() => {
  const loading = Option.getOrElse(shared, () => Effect.runPromise(importGhostty))
  shared = Option.some(loading)
  return Effect.promise(() => loading)
})

const decodeControlFrame = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

type TerminalColors = {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

const DEFAULT_TERMINAL_COLORS: Record<"light" | "dark", TerminalColors & { foreground: HexColor }> = {
  light: {
    background: "#fcfcfc",
    foreground: "#211e1e",
    cursor: "#211e1e",
    selectionBackground: withAlpha("#211e1e", 0.2),
  },
  dark: {
    background: "#191515",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: withAlpha("#d4d4d4", 0.25),
  },
}

// Debug lines print in development only, so the log level is raised to Debug there.
const debugTerminal = (...values: ReadonlyArray<unknown>) =>
  import.meta.env.DEV
    ? Effect.logDebug("[terminal]", ...values).pipe(Effect.provideService(References.MinimumLogLevel, "Debug"))
    : Effect.void

const resolveV2Token = (tokens: ResolvedV2Theme, key: string) => {
  let current = tokens[key]
  for (let i = 0; i < 8 && current; i++) {
    const match = /^var\(--([^)]+)\)$/.exec(current.trim())
    if (!match) {
      const hex = current.trim()
      if (/^#[0-9a-fA-F]{8}$/.test(hex)) return hex.slice(0, 7)
      return hex
    }
    current = tokens[match[1]]
  }
  return undefined
}

const useTerminalUiBindings = (input: {
  container: HTMLDivElement
  term: Term
  addCleanup: (fn: VoidFunction) => void
  handlePointerDown: () => void
  handleLinkClick: (event: MouseEvent) => void
}) => {
  const handleCopy = (event: ClipboardEvent) => {
    const selection = input.term.getSelection()
    if (!selection) return

    const clipboard = event.clipboardData
    if (!clipboard) return

    event.preventDefault()
    clipboard.setData("text/plain", selection)
  }

  const handlePaste = (event: ClipboardEvent) => {
    const clipboard = event.clipboardData
    const text = clipboard?.getData("text/plain") ?? clipboard?.getData("text") ?? ""
    if (!text) return

    event.preventDefault()
    event.stopPropagation()
    input.term.paste(text)
  }

  const handleTextareaFocus = () => {
    input.term.options.cursorBlink = true
  }
  const handleTextareaBlur = () => {
    input.term.options.cursorBlink = false
  }

  input.container.addEventListener("copy", handleCopy, true)
  input.addCleanup(() => input.container.removeEventListener("copy", handleCopy, true))

  input.container.addEventListener("paste", handlePaste, true)
  input.addCleanup(() => input.container.removeEventListener("paste", handlePaste, true))

  input.container.addEventListener("pointerdown", input.handlePointerDown)
  input.addCleanup(() => input.container.removeEventListener("pointerdown", input.handlePointerDown))

  input.container.addEventListener("click", input.handleLinkClick, {
    capture: true,
  })
  input.addCleanup(() =>
    input.container.removeEventListener("click", input.handleLinkClick, {
      capture: true,
    }),
  )

  input.term.textarea?.addEventListener("focus", handleTextareaFocus)
  input.term.textarea?.addEventListener("blur", handleTextareaBlur)
  input.addCleanup(() => input.term.textarea?.removeEventListener("focus", handleTextareaFocus))
  input.addCleanup(() => input.term.textarea?.removeEventListener("blur", handleTextareaBlur))
}

const persistTerminal = (input: {
  term: Term | undefined
  addon: SerializeAddon | undefined
  cursor: number
  id: string
  onCleanup?: (pty: Partial<LocalPTY> & { id: string }) => void
}) =>
  Effect.gen(function* () {
    const addon = input.addon
    const save = input.onCleanup
    const term = input.term
    if (!addon || !save || !term) return
    const buffer = yield* Effect.sync(() => addon.serialize()).pipe(
      Effect.catchDefect(() => debugTerminal("failed to serialize terminal buffer").pipe(Effect.as(""))),
    )

    save({
      id: input.id,
      buffer,
      cursor: input.cursor,
      rows: term.rows,
      cols: term.cols,
      scrollY: term.getViewportY(),
    })
  })

export const Terminal = (props: TerminalProps) => {
  const platform = usePlatform()
  const sdk = useSDK()
  const settings = useSettings()
  const theme = useTheme()
  const language = useLanguage()
  // Terminal captures its connection for the PTY lifetime, so callers must key it per server/session.
  const connection = useServerSDK()().server
  const directory = sdk().directory
  const url = sdk().url
  const auth = connection.http
  const username = auth?.username ?? "opencode"
  const password = auth?.password ?? ""
  const authToken = connection.type === "http" ? connection.authToken : false
  const sameOrigin = new URL(url, location.href).origin === location.origin
  let container!: HTMLDivElement
  const [local, others] = splitProps(props, [
    "pty",
    "class",
    "classList",
    "autoFocus",
    "onAutoFocus",
    "onConnect",
    "onConnectError",
  ])
  const id = local.pty.id
  const restore = typeof local.pty.buffer === "string" ? local.pty.buffer : ""
  const restoreSize: Option.Option<{ cols: number; rows: number }> =
    restore &&
    typeof local.pty.cols === "number" &&
    Number.isSafeInteger(local.pty.cols) &&
    local.pty.cols > 0 &&
    typeof local.pty.rows === "number" &&
    Number.isSafeInteger(local.pty.rows) &&
    local.pty.rows > 0
      ? Option.some({ cols: local.pty.cols, rows: local.pty.rows })
      : Option.none()
  const scrollY = Option.liftPredicate(local.pty.scrollY, Predicate.isNumber)
  let ws: Option.Option<WebSocket> = Option.none()
  let term: Term | undefined
  let _ghostty: Ghostty
  let serializeAddon: SerializeAddon
  let fitAddon: FitAddon
  let handleResize: () => void
  let fitFrame: Option.Option<number> = Option.none()
  const sizeSync = createFiberSlot()
  let sizeQueued = false
  let pendingSize: Option.Option<{ cols: number; rows: number }> = Option.none()
  let lastSize: { cols: number; rows: number } | undefined
  let disposed = false
  let cleanups = Chunk.empty<VoidFunction>()
  const start = Option.filter(Option.liftPredicate(local.pty.cursor, Predicate.isNumber), Number.isSafeInteger)
  let cursor = Option.getOrElse(start, () => 0)
  let seek = Option.getOrElse(start, () => (restore ? -1 : 0))
  let output: ReturnType<typeof terminalWriter> | undefined
  let drop: Option.Option<VoidFunction> = Option.none()
  const reconnect = createFiberSlot()
  let reconnecting = false
  const textareaFocus = createFiberSlot()
  const mountFocus = createFiberSlot()
  let tries = 0

  const addCleanup = (fn: VoidFunction) => {
    cleanups = Chunk.append(cleanups, fn)
  }

  // Runs every cleanup in reverse order. A cleanup that throws does not stop the others.
  const cleanup = Effect.suspend(() => {
    const fns = Chunk.reverse(cleanups)
    cleanups = Chunk.empty()
    return Effect.forEach(
      fns,
      (fn) => Effect.sync(fn).pipe(Effect.catchDefect((err) => debugTerminal("cleanup failed", err))),
      { discard: true },
    )
  })

  const pushSize = (cols: number, rows: number) =>
    Effect.gen(function* () {
      if ((yield* Effect.promise(() => sdk().protocol)) === "v1") {
        yield* terminalRequest(() => sdk().client.pty.update({ ptyID: id, size: { cols, rows } }))
        return
      }
      yield* terminalRequest(() => sdk().api.pty.update({ ptyID: id, location: { directory }, size: { cols, rows } }))
    }).pipe(
      Effect.catchTag("App.TerminalRequestError", (err) => debugTerminal("failed to sync terminal size", err.cause)),
    )

  const getTerminalColors = (): TerminalColors => {
    const mode = theme.mode() === "dark" ? "dark" : "light"
    const fallback = DEFAULT_TERMINAL_COLORS[mode]
    const currentTheme = theme.themes()[theme.themeId()]
    if (!currentTheme) return fallback
    const variant = mode === "dark" ? currentTheme.dark : currentTheme.light
    if (!variant?.seeds && !variant?.palette) return fallback
    const resolved = resolveThemeVariant(variant, mode === "dark")
    const text = resolved["text-stronger"] ?? fallback.foreground
    const background = settings.general.newLayoutDesigns()
      ? (resolveV2Token(resolveThemeVariantV2(variant, mode === "dark"), "v2-background-bg-base") ??
        fallback.background)
      : (resolved["background-stronger"] ?? fallback.background)
    const alpha = mode === "dark" ? 0.25 : 0.2
    const base = isHexColor(text) ? text : fallback.foreground
    const selectionBackground = withAlpha(base, alpha)
    return {
      background,
      foreground: text,
      cursor: text,
      selectionBackground,
    }
  }

  const terminalColors = createMemo(getTerminalColors)

  const scheduleFit = () => {
    if (disposed) return
    if (!fitAddon) return
    if (Option.isSome(fitFrame)) return

    fitFrame = Option.some(
      requestAnimationFrame(() => {
        fitFrame = Option.none()
        if (disposed) return
        fitAddon.fit()
      }),
    )
  }

  const scheduleSize = (cols: number, rows: number) => {
    if (disposed) return
    if (lastSize?.cols === cols && lastSize?.rows === rows) {
      pendingSize = Option.none()
      sizeQueued = false
      sizeSync.interrupt()
      return
    }

    const size = { cols, rows }
    pendingSize = Option.some(size)

    if (!lastSize) {
      lastSize = size
      Effect.runFork(pushSize(cols, rows))
      return
    }

    // One sync waits at a time; later sizes only replace pendingSize until it runs.
    if (sizeQueued) return
    sizeQueued = true
    sizeSync.run(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(100))
        sizeQueued = false
        if (Option.isNone(pendingSize)) return
        const next = pendingSize.value
        pendingSize = Option.none()
        if (disposed) return
        if (lastSize?.cols === next.cols && lastSize?.rows === next.rows) return
        lastSize = next
        yield* Effect.forkDetach(pushSize(next.cols, next.rows), { startImmediately: true })
      }),
    )
  }

  createEffect(() => {
    const colors = terminalColors()
    const mode = theme.mode() === "dark" ? "dark" : "light"
    if (!term) return
    setOptionIfSupported(term, "theme", colors)
    setOptionIfSupported(term, "colorScheme", mode)
  })

  createEffect(() => {
    const font = terminalFontFamily(settings.appearance.terminalFont())
    if (!term) return
    setOptionIfSupported(term, "fontFamily", font)
    scheduleFit()
  })

  let zoom = platform.webviewZoom?.()
  createEffect(() => {
    const next = platform.webviewZoom?.()
    if (next === undefined) return
    if (next === zoom) return
    zoom = next
    scheduleFit()
  })

  const focusTerminal = () => {
    const t = term
    if (!t) return
    t.focus()
    t.textarea?.focus()
    // A zero sleep yields to the next task, as setTimeout(0) did.
    textareaFocus.run(Effect.sleep(Duration.zero).pipe(Effect.andThen(Effect.sync(() => t.textarea?.focus()))))
  }
  const handlePointerDown = () => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && activeElement !== container && !container.contains(activeElement)) {
      activeElement.blur()
    }
    focusTerminal()
  }

  const handleLinkClick = (event: MouseEvent) => {
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return
    if (event.altKey) return
    if (event.button !== 0) return

    const t = term
    if (!t) return

    const text = getHoveredLinkText(t)
    if (!text) return

    event.preventDefault()
    event.stopImmediatePropagation()
    if (URL.canParse(text) && new URL(text).protocol === "file:" && platform.openLocalFile) {
      platform.openLocalFile(text)
      return
    }
    platform.openExternal(text)
  }

  onMount(() => {
    const run = Effect.gen(function* () {
      const loaded = yield* loadGhostty
      if (disposed) return

      const mod = loaded.mod
      const g = loaded.ghostty

      const t = new mod.Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        ...Option.getOrElse(restoreSize, () => ({})),
        fontSize: 14,
        fontFamily: terminalFontFamily(settings.appearance.terminalFont()),
        allowTransparency: false,
        convertEol: false,
        theme: terminalColors(),
        scrollback: 10_000,
        ghostty: g,
      })
      addCleanup(() => t.dispose())
      if (disposed) {
        yield* cleanup
        return
      }
      _ghostty = g
      term = t
      setOptionIfSupported(t, "colorScheme", theme.mode() === "dark" ? "dark" : "light")
      output = terminalWriter((data, done) =>
        t.write(data, () => {
          done?.()
        }),
      )

      t.attachCustomKeyEventHandler((event) => {
        const key = event.key.toLowerCase()

        if (event.ctrlKey && event.shiftKey && !event.metaKey && key === "c") {
          document.execCommand("copy")
          return true
        }

        // allow for toggle terminal keybinds in parent
        const config = settings.keybinds.get(TOGGLE_TERMINAL_ID) ?? DEFAULT_TOGGLE_TERMINAL_KEYBIND
        const keybinds = parseKeybind(config)

        return matchKeybind(keybinds, event)
      })

      const fit = new mod.FitAddon()
      const serializer = new SerializeAddon()
      addCleanup(() => disposeIfDisposable(fit))
      t.loadAddon(serializer)
      t.loadAddon(fit)
      fitAddon = fit
      serializeAddon = serializer

      const active = document.activeElement
      t.open(container)
      useTerminalUiBindings({
        container,
        term: t,
        addCleanup,
        handlePointerDown,
        handleLinkClick,
      })

      if (local.autoFocus === true) {
        focusTerminal()
        local.onAutoFocus?.()
      }
      if (local.autoFocus !== true) {
        const restoreFocus = () => {
          const current = document.activeElement
          if (current !== container && !container.contains(current)) return
          t.blur()
          t.textarea?.blur()
          if (active instanceof HTMLElement && active.isConnected) active.focus()
        }
        restoreFocus()
        mountFocus.run(Effect.sleep(Duration.zero).pipe(Effect.andThen(Effect.sync(restoreFocus))))
        addCleanup(() => mountFocus.interrupt())
      }

      if (typeof document !== "undefined" && document.fonts) {
        const fonts = document.fonts
        yield* Effect.forkDetach(Effect.promise(() => fonts.ready).pipe(Effect.andThen(Effect.sync(scheduleFit))))
      }

      const onResize = t.onResize((size) => {
        scheduleSize(size.cols, size.rows)
      })
      addCleanup(() => disposeIfDisposable(onResize))
      const onData = t.onData((data) => {
        if (Option.isSome(ws) && ws.value.readyState === WebSocket.OPEN) ws.value.send(data)
      })
      addCleanup(() => disposeIfDisposable(onData))
      const onKey = t.onKey((key) => {
        if (key.key == "Enter") {
          props.onSubmit?.()
        }
      })
      addCleanup(() => disposeIfDisposable(onKey))

      const startResize = () => {
        fit.observeResize()
        handleResize = scheduleFit
        window.addEventListener("resize", handleResize)
        addCleanup(() => window.removeEventListener("resize", handleResize))
      }

      const write = (data: string) =>
        Effect.callback<void>((resume) => {
          if (!output) {
            resume(Effect.void)
            return
          }
          output.push(data)
          output.flush(() => resume(Effect.void))
        })

      if (restore && Option.isSome(restoreSize)) {
        yield* write(restore)
        fit.fit()
        scheduleSize(t.cols, t.rows)
        if (Option.isSome(scrollY)) t.scrollToLine(scrollY.value)
        startResize()
      } else {
        fit.fit()
        scheduleSize(t.cols, t.rows)
        if (restore) {
          yield* write(restore)
          if (Option.isSome(scrollY)) t.scrollToLine(scrollY.value)
        }
        startResize()
      }

      const once = { value: false }
      const decoder = new TextDecoder()

      const fail = (err: unknown) => {
        if (disposed) return
        if (once.value) return
        once.value = true
        local.onConnectError?.(err)
      }

      const gone = Effect.gen(function* () {
        if ((yield* Effect.promise(() => sdk().protocol)) === "v1") {
          return yield* terminalRequest(() => sdk().client.pty.get({ ptyID: id }, { throwOnError: false })).pipe(
            Effect.map((result) => result.response.status === 404),
            Effect.catchTag("App.TerminalRequestError", (err) =>
              debugTerminal("failed to inspect terminal session", err.cause).pipe(Effect.as(false)),
            ),
          )
        }
        return yield* terminalRequest(() => sdk().api.pty.get({ ptyID: id, location: { directory } })).pipe(
          Effect.map((result) => result.data.status === "exited"),
          Effect.catchTag("App.TerminalRequestError", (err) =>
            Predicate.isTagged(err.cause, "PtyNotFoundError")
              ? Effect.succeed(true)
              : debugTerminal("failed to inspect terminal session", err.cause).pipe(Effect.as(false)),
          ),
        )
      })

      const connectToken = Effect.gen(function* () {
        if ((yield* Effect.promise(() => sdk().protocol)) === "v1") {
          const response = yield* terminalRequest(() =>
            sdk().client.pty.connectToken(
              { ptyID: id, directory },
              {
                throwOnError: false,
                headers: { "x-opencode-ticket": "1" },
              },
            ),
          ).pipe(
            Effect.map(Option.some),
            Effect.catchTag("App.TerminalRequestError", (err) =>
              err.cause instanceof Error && err.cause.message.includes("Request is not supported")
                ? Effect.succeed(Option.none())
                : Effect.fail(err),
            ),
          )
          if (Option.isNone(response)) return Option.none<string>()
          const result = response.value
          if (result.response.status === 200 && result.data?.ticket) return Option.some(result.data.ticket)
          if (result.response.status === 404 || result.response.status === 405) return Option.none<string>()
          if (result.response.status === 403) {
            return yield* new TerminalTicketError({ message: language.t("terminal.connectTicket.csrfError") })
          }
          return yield* new TerminalTicketError({
            message: language.t("terminal.connectTicket.statusError", { status: result.response.status }),
          })
        }
        // return sdk()
        //   .api.pty.connectToken({
        //     ptyID: id,
        //     location: { directory },
        //     "x-opencode-ticket": "1",
        //   })
        //   .then((result) => result.data.ticket)
        return Option.none<string>()
      })

      const retry = (err: unknown): void => {
        if (disposed) return
        if (reconnecting) return
        reconnecting = true

        const ms = Math.min(250 * 2 ** Math.min(tries, 4), 4_000)
        reconnect.run(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(ms))
            reconnecting = false
            if (disposed) return
            if (yield* gone) {
              if (disposed) return
              fail(err)
              return
            }
            if (disposed) return
            tries += 1
            yield* open
          }),
        )
      }

      const open: Effect.Effect<void> = Effect.gen(function* () {
        if (disposed) return
        if (Option.isSome(drop)) drop.value()

        const ticket = yield* connectToken.pipe(
          Effect.catch((err) =>
            Effect.sync(() => {
              fail(err._tag === "App.TerminalRequestError" ? err.cause : err)
              return Option.none<string>()
            }),
          ),
        )
        const protocol = yield* Effect.promise(() => sdk().protocol)
        // if (protocol === "v2" && !ticket) return
        if (once.value) return
        if (disposed) return

        const socket = new WebSocket(
          terminalWebSocketURL({
            protocol,
            url,
            id,
            directory,
            cursor: seek,
            ticket: Option.getOrUndefined(ticket),
            sameOrigin,
            username,
            password,
            authToken,
          }),
        )
        socket.binaryType = "arraybuffer"
        ws = Option.some(socket)

        const handleOpen = () => {
          if (disposed) return
          tries = 0
          local.onConnect?.()
          scheduleSize(t.cols, t.rows)
          if (t.getMode(2031)) t.write("\x1b[?996n")
        }

        const handleMessage = (event: MessageEvent) => {
          if (disposed) return
          if (event.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(event.data)
            if (bytes[0] !== 0) return
            const meta = decodeControlFrame(decoder.decode(bytes.subarray(1)))
            if (Result.isFailure(meta)) {
              Effect.runFork(debugTerminal("invalid websocket control frame", meta.failure))
              return
            }
            if (!Predicate.hasProperty(meta.success, "cursor")) return
            const next = meta.success.cursor
            if (typeof next === "number" && Number.isSafeInteger(next) && next >= 0) {
              cursor = next
              seek = next
            }
            return
          }

          const data = typeof event.data === "string" ? event.data : ""
          if (!data) return
          output?.push(data)
          cursor += data.length
          seek = cursor
        }

        const handleError = (error: Event) => {
          if (disposed) return
          Effect.runFork(debugTerminal("websocket error", error))
        }

        const stop = () => {
          socket.removeEventListener("open", handleOpen)
          socket.removeEventListener("message", handleMessage)
          socket.removeEventListener("error", handleError)
          socket.removeEventListener("close", handleClose)
          if (Option.isSome(ws) && ws.value === socket) ws = Option.none()
          if (Option.isSome(drop) && drop.value === stop) drop = Option.none()
          if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close(1000)
        }

        const handleClose = (event: CloseEvent) => {
          if (Option.isSome(ws) && ws.value === socket) ws = Option.none()
          if (Option.isSome(drop) && drop.value === stop) drop = Option.none()
          socket.removeEventListener("open", handleOpen)
          socket.removeEventListener("message", handleMessage)
          socket.removeEventListener("error", handleError)
          socket.removeEventListener("close", handleClose)
          if (disposed) return
          if (event.code === 1000) return
          retry(
            new TerminalConnectionLostError({
              message: language.t("terminal.connectionLost.abnormalClose", { code: event.code }),
              code: event.code,
            }),
          )
        }

        drop = Option.some(stop)
        socket.addEventListener("open", handleOpen)
        socket.addEventListener("message", handleMessage)
        socket.addEventListener("error", handleError)
        socket.addEventListener("close", handleClose)
      })

      // The first connect runs on its own, so its failures stay out of the mount error path.
      yield* Effect.forkDetach(open, { startImmediately: true })
    })

    Effect.runFork(
      run.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (disposed) return
            const err = Cause.squash(cause)
            showToast({
              variant: "error",
              title: language.t("terminal.connectionLost.title"),
              description: err instanceof Error ? err.message : language.t("terminal.connectionLost.description"),
            })
            local.onConnectError?.(err)
          }),
        ),
      ),
    )
  })

  onCleanup(() => {
    disposed = true
    if (Option.isSome(fitFrame)) cancelAnimationFrame(fitFrame.value)
    sizeSync.interrupt()
    reconnect.interrupt()
    if (Option.isSome(drop)) drop.value()
    if (Option.isSome(ws) && ws.value.readyState !== WebSocket.CLOSED && ws.value.readyState !== WebSocket.CLOSING)
      ws.value.close(1000)

    const finalize = () => {
      Effect.runFork(
        persistTerminal({ term, addon: serializeAddon, cursor, id, onCleanup: props.onCleanup }).pipe(
          Effect.andThen(cleanup),
        ),
      )
    }

    if (!output) {
      finalize()
      return
    }

    output.flush(finalize)
  })

  return (
    <div
      ref={container}
      data-component="terminal"
      dir="ltr"
      data-prevent-autofocus
      tabIndex={-1}
      style={{ "background-color": terminalColors().background }}
      classList={{
        ...local.classList,
        "select-text": true,
        "size-full px-6 py-3 font-mono relative overflow-hidden": true,
        [local.class ?? ""]: !!local.class,
      }}
      {...others}
    />
  )
}
