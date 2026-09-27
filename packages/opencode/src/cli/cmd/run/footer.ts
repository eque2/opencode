// RunFooter -- the mutable control surface for direct interactive mode.
//
// In the split-footer architecture, scrollback is immutable (append-only)
// and the footer is the only region that can repaint. RunFooter owns both
// sides of that boundary:
//
//   Scrollback: append() queues StreamCommit entries and flush() drains them
//   through retained scrollback surfaces. Commits coalesce in a microtask
//   queue so direct-mode transcript updates still preserve ordering without
//   rebuilding the session model.
//
//   Footer: event() updates the SolidJS signal-backed FooterState, which
//   drives the reactive footer view (prompt, status, permission, question).
//   present() swaps the active footer view and resizes the footer region.
//
// Lifecycle:
//   - close() flushes pending commits and notifies listeners (the prompt
//     queue uses this to know when to stop).
//   - destroy() does the same plus tears down event listeners and clears
//     internal state.
//   - The renderer's DESTROY event triggers destroy() so the footer
//     doesn't outlive the renderer.
//
// Ctrl-c clears a live prompt draft first; otherwise interrupt and exit use a
// two-press pattern where the first press shows a hint and the second press
// within 5 seconds actually fires the action.
import { CliRenderEvents, type CliRenderer, type KeyEvent, type Renderable, type TreeSitterClient } from "@opentui/core"
import type { Keymap } from "@opentui/keymap"
import { render } from "@opentui/solid"
import { createComponent, createSignal, type Accessor, type Setter } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Duration, Effect, Fiber, Option } from "effect"
import { OpencodeKeymapProvider } from "@opencode-ai/tui/keymap"
import { RUN_COMMAND_PANEL_ROWS, RUN_SUBAGENT_PANEL_ROWS } from "./footer.command"
import { SUBAGENT_INSPECTOR_ROWS } from "./footer.subagent"
import { PROMPT_MAX_ROWS, TEXTAREA_MIN_ROWS } from "./footer.prompt"
import { RunFooterView } from "./footer.view"
import { FooterCallbackError, fromCallback, makeFiberSlot } from "./footer.effect"
import { RunScrollbackStream } from "./scrollback.surface"
import { RUN_THEME_FALLBACK, resolveRunTheme, type RunTheme } from "./theme"
import { modelInfo } from "./variant.shared"
import type {
  FooterApi,
  FooterEvent,
  FooterPatch,
  FooterPromptRoute,
  FooterQueuedPrompt,
  FooterState,
  FooterSubagentState,
  FooterView,
  PermissionReply,
  QuestionReject,
  QuestionReply,
  RunAgent,
  RunCommand,
  RunDiffStyle,
  RunInput,
  RunPrompt,
  RunProvider,
  RunResource,
  RunTuiConfig,
  StreamCommit,
} from "./types"

type CycleResult = {
  modelLabel?: string
  status?: string
  variant?: string | undefined
  variants?: string[]
}

type RunFooterOptions = {
  directory: string
  findFiles: (query: string) => Promise<string[]>
  agents: RunAgent[]
  resources: RunResource[]
  commands?: RunCommand[]
  wrote?: boolean
  sessionID: () => string | undefined
  agentLabel: string
  modelLabel: string
  model: RunInput["model"]
  variant: string | undefined
  first: boolean
  history?: RunPrompt[]
  theme: RunTheme
  keymap: Keymap<Renderable, KeyEvent>
  tuiConfig: RunTuiConfig
  backgroundSubagents: boolean
  diffStyle: RunDiffStyle
  onPermissionReply: (input: PermissionReply) => void | Promise<void>
  onQuestionReply: (input: QuestionReply) => void | Promise<void>
  onQuestionReject: (input: QuestionReject) => void | Promise<void>
  onCycleVariant?: () => CycleResult | void
  onModelSelect?: (model: NonNullable<RunInput["model"]>) => CycleResult | void | Promise<CycleResult | void>
  onVariantSelect?: (variant: string | undefined) => CycleResult | void | Promise<CycleResult | void>
  onInterrupt?: () => void
  onBackground?: () => void
  onEditorOpen: (input: { value: string }) => Promise<string | undefined>
  onExit?: () => void
  onSubagentSelect?: (sessionID: string | undefined) => void
  treeSitterClient?: TreeSitterClient
}

const PERMISSION_ROWS = 12
const QUESTION_ROWS = 14
const COMMAND_ROWS = RUN_COMMAND_PANEL_ROWS
const SKILL_ROWS = RUN_COMMAND_PANEL_ROWS
const SUBAGENT_ROWS = RUN_SUBAGENT_PANEL_ROWS
const MODEL_ROWS = RUN_COMMAND_PANEL_ROWS
const VARIANT_ROWS = RUN_COMMAND_PANEL_ROWS
const NOTICE_DURATION = Duration.seconds(3)
const TWO_PRESS_WINDOW = Duration.seconds(5)
const THEME_REFRESH_DELAYS = [Duration.seconds(1), Duration.seconds(1)] as const

// Waits for the renderer to settle. A failed wait counts as settled.
function rendererIdle(renderer: CliRenderer) {
  return Effect.tryPromise({
    try: () => renderer.idle(),
    catch: (cause) => new FooterCallbackError({ action: "renderer.idle", cause }),
  }).pipe(Effect.ignore)
}

function createEmptySubagentState(): FooterSubagentState {
  return {
    tabs: [],
    details: {},
    permissions: [],
    questions: [],
  }
}

function eventPatch(next: FooterEvent): FooterPatch | undefined {
  if (next.type === "queue") {
    return { queue: next.queue }
  }

  if (next.type === "first") {
    return { first: next.first }
  }

  if (next.type === "model") {
    return { model: next.model }
  }

  if (next.type === "turn.send") {
    return {
      phase: "running",
      status: "sending prompt",
      queue: next.queue,
      interrupt: 0,
      exit: 0,
    }
  }

  if (next.type === "turn.wait") {
    return {
      phase: "running",
      status: "waiting for assistant",
    }
  }

  if (next.type === "turn.idle") {
    return {
      phase: "idle",
      status: "",
      queue: next.queue,
    }
  }

  if (next.type === "stream.patch") {
    return next.patch
  }

  return undefined
}

export class RunFooter implements FooterApi {
  private closed = false
  private destroyed = false
  private prompts = new Set<(input: RunPrompt) => void>()
  private queuedRemoves = new Set<(messageID: string) => boolean | Promise<boolean>>()
  private closes = new Set<() => void>()
  // Microtask-coalesced commit queue. Flushed on next microtask or on close/destroy.
  private queue: StreamCommit[] = []
  private pending = false
  // Scrollback work runs in order: each task joins the fiber of the task
  // before it. The chain never fails; a failed task records flushError.
  private flushing: Fiber.Fiber<void> = Effect.runFork(Effect.void)
  private flushError: Option.Option<unknown> = Option.none()
  // Fixed portion of footer height above the textarea.
  private base: number
  private rows = TEXTAREA_MIN_ROWS
  private agents: Accessor<RunAgent[]>
  private setAgents: Setter<RunAgent[]>
  private resources: Accessor<RunResource[]>
  private setResources: Setter<RunResource[]>
  private commands: Accessor<RunCommand[] | undefined>
  private setCommands: Setter<RunCommand[] | undefined>
  private providers: Accessor<RunProvider[] | undefined>
  private setProviders: Setter<RunProvider[] | undefined>
  private currentModel: Accessor<RunInput["model"]>
  private setCurrentModel: Setter<RunInput["model"]>
  private variants: Accessor<string[]>
  private setVariants: Setter<string[]>
  private currentVariant: Accessor<string | undefined>
  private setCurrentVariant: Setter<string | undefined>
  private theme: Accessor<RunTheme>
  private setTheme: Setter<RunTheme>
  private state: Accessor<FooterState>
  private setState: Setter<FooterState>
  private view: Accessor<FooterView>
  private setView: Setter<FooterView>
  private subagent: Accessor<FooterSubagentState>
  private setSubagent: (next: FooterSubagentState) => void
  private queuedPrompts: Accessor<FooterQueuedPrompt[]>
  private setQueuedPrompts: Setter<FooterQueuedPrompt[]>
  private promptRoute: FooterPromptRoute = { type: "composer" }
  private subagentMenuRows = SUBAGENT_ROWS
  private autocomplete = false
  private interruptTimer = makeFiberSlot()
  private exitTimer = makeFiberSlot()
  private noticeTimer = makeFiberSlot()
  // The status to restore when the pending notice expires. Some only while a
  // notice timer is pending.
  private noticeRestore: Option.Option<string> = Option.none()
  private statusVersion = 0
  private requestExitHandler: (() => boolean) | undefined
  private scrollback: RunScrollbackStream
  private themes: RunTheme[]
  private paletteRefreshRunning = false
  private paletteRefreshQueued = false
  private themeRefreshTimer = makeFiberSlot()

  private createScrollback(wrote: boolean): RunScrollbackStream {
    return new RunScrollbackStream(this.renderer, this.theme(), {
      diffStyle: this.options.diffStyle,
      wrote,
      sessionID: this.options.sessionID,
      treeSitterClient: this.options.treeSitterClient,
      onThemeRelease: (theme) => {
        Effect.runFork(rendererIdle(this.renderer).pipe(Effect.andThen(Effect.sync(() => this.destroyTheme(theme)))))
      },
    })
  }

  constructor(
    private renderer: CliRenderer,
    private options: RunFooterOptions,
  ) {
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: options.modelLabel,
      duration: "",
      usage: "",
      first: options.first,
      interrupt: 0,
      exit: 0,
    })
    this.state = state
    this.setState = setState
    const [view, setView] = createSignal<FooterView>({ type: "prompt" })
    this.view = view
    this.setView = setView
    const [agents, setAgents] = createSignal(options.agents)
    this.agents = agents
    this.setAgents = setAgents
    const [resources, setResources] = createSignal(options.resources)
    this.resources = resources
    this.setResources = setResources
    const [commands, setCommands] = createSignal(options.commands)
    this.commands = commands
    this.setCommands = setCommands
    const [providers, setProviders] = createSignal<RunProvider[] | undefined>()
    this.providers = providers
    this.setProviders = setProviders
    const [currentModel, setCurrentModel] = createSignal(options.model)
    this.currentModel = currentModel
    this.setCurrentModel = setCurrentModel
    const [variants, setVariants] = createSignal<string[]>([])
    this.variants = variants
    this.setVariants = setVariants
    const [currentVariant, setCurrentVariant] = createSignal(options.variant)
    this.currentVariant = currentVariant
    this.setCurrentVariant = setCurrentVariant
    const [theme, setTheme] = createSignal(options.theme)
    this.theme = theme
    this.setTheme = setTheme
    this.themes = [options.theme]
    const [subagent, setSubagent] = createStore<FooterSubagentState>(createEmptySubagentState())
    this.subagent = () => subagent
    this.setSubagent = (next) => {
      setSubagent("tabs", reconcile(next.tabs, { key: "sessionID" }))
      setSubagent("details", reconcile(next.details))
      setSubagent("permissions", reconcile(next.permissions, { key: "id" }))
      setSubagent("questions", reconcile(next.questions, { key: "id" }))
    }
    const [queuedPrompts, setQueuedPrompts] = createSignal<FooterQueuedPrompt[]>([])
    this.queuedPrompts = queuedPrompts
    this.setQueuedPrompts = setQueuedPrompts
    this.base = Math.max(1, renderer.footerHeight - TEXTAREA_MIN_ROWS)
    this.scrollback = this.createScrollback(options.wrote ?? false)

    this.renderer.on(CliRenderEvents.DESTROY, this.handleDestroy)
    this.renderer.on(CliRenderEvents.PALETTE, this.handlePalette)
    this.renderer.on(CliRenderEvents.THEME_MODE, this.handleThemeRefresh)
    this.renderer.prependInputHandler(this.handleThemeNotification)
    process.on("SIGUSR2", this.handleThemeSignal)

    // An arrow keeps `this` bound to the footer inside the provider's
    // children getter, which Solid reads with the props object as `this`.
    const footerView = () =>
      createComponent(RunFooterView, {
        directory: options.directory,
        state: this.state,
        view: this.view,
        subagent: this.subagent,
        queuedPrompts: this.queuedPrompts,
        findFiles: options.findFiles,
        agents: this.agents,
        resources: this.resources,
        commands: this.commands,
        providers: this.providers,
        currentModel: this.currentModel,
        variants: this.variants,
        currentVariant: this.currentVariant,
        theme: this.theme,
        diffStyle: options.diffStyle,
        tuiConfig: options.tuiConfig,
        backgroundSubagents: options.backgroundSubagents,
        history: options.history,
        agent: options.agentLabel,
        onSubmit: this.handlePrompt,
        onPermissionReply: this.handlePermissionReply,
        onQuestionReply: this.handleQuestionReply,
        onQuestionReject: this.handleQuestionReject,
        onCycle: this.handleCycle,
        onInterrupt: this.handleInterrupt,
        onBackground: options.onBackground,
        onEditorOpen: options.onEditorOpen,
        onInputClear: this.handleInputClear,
        onExitRequest: this.handleExit,
        onRequestExit: this.setRequestExitHandler,
        onExit: () => this.close(),
        onModelSelect: this.handleModelSelect,
        onVariantSelect: this.handleVariantSelect,
        onRows: this.syncRows,
        onLayout: this.syncLayout,
        onStatus: this.setStatus,
        onSubagentSelect: options.onSubagentSelect,
        onQueuedRemove: this.handleQueuedRemove,
      })
    Effect.runFork(
      Effect.tryPromise({
        try: () =>
          render(
            () =>
              createComponent(OpencodeKeymapProvider, {
                keymap: options.keymap,
                get children() {
                  return footerView()
                },
              }),
            this.renderer,
          ),
        catch: (cause) => new FooterCallbackError({ action: "render", cause }),
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            if (!this.isGone) {
              this.close()
            }
          }),
        ),
      ),
    )
  }

  public get isClosed(): boolean {
    return this.closed || this.isGone
  }

  private get isGone(): boolean {
    return this.destroyed || this.renderer.isDestroyed
  }

  public onPrompt(fn: (input: RunPrompt) => void): () => void {
    this.prompts.add(fn)
    return () => {
      this.prompts.delete(fn)
    }
  }

  public onQueuedRemove(fn: (messageID: string) => boolean | Promise<boolean>): () => void {
    this.queuedRemoves.add(fn)
    return () => {
      this.queuedRemoves.delete(fn)
    }
  }

  public onClose(fn: () => void): () => void {
    if (this.isClosed) {
      fn()
      return () => {}
    }

    this.closes.add(fn)
    return () => {
      this.closes.delete(fn)
    }
  }

  public event(next: FooterEvent): void {
    if (next.type === "turn.duration") {
      const current = this.currentModel()
      this.flush()
      this.enqueue(
        fromCallback("scrollback.writeTurnSummary", () =>
          this.scrollback.writeTurnSummary({
            agent: this.options.agentLabel,
            model: current ? modelInfo(this.providers(), current).model : this.state().model,
            duration: next.duration,
          }),
        ),
      )
      return
    }

    if (next.type === "catalog") {
      if (this.isGone) {
        return
      }

      this.setAgents(next.agents)
      this.setResources(next.resources)
      if (next.commands !== undefined) {
        this.setCommands(next.commands)
      }
      return
    }

    if (next.type === "models") {
      if (this.isGone) {
        return
      }

      this.setProviders(next.providers)
      return
    }

    if (next.type === "variants") {
      if (this.isGone) {
        return
      }

      this.setVariants(next.variants)
      this.setCurrentVariant(next.current)
      return
    }

    if (next.type === "queued.prompts") {
      if (this.isGone) {
        return
      }

      this.setQueuedPrompts(next.prompts)
      return
    }

    const patch = eventPatch(next)
    if (patch) {
      if (typeof patch.status === "string") {
        this.clearNoticeTimer()
      }
      if (next.type === "turn.send") {
        this.clearInterruptTimer()
        this.clearExitTimer()
      }
      this.patch(patch)
      return
    }

    if (next.type === "stream.subagent") {
      if (this.isGone) {
        return
      }

      this.setSubagent(next.state)
      this.applyHeight()
      return
    }

    if (next.type === "stream.view") {
      this.present(next.view)
    }
  }

  private patch(next: FooterPatch): void {
    if (this.isGone) {
      return
    }

    const prev = this.state()
    if (typeof next.status === "string") {
      this.statusVersion++
    }
    const state = {
      phase: next.phase ?? prev.phase,
      status: typeof next.status === "string" ? next.status : prev.status,
      queue: typeof next.queue === "number" ? Math.max(0, next.queue) : prev.queue,
      model: typeof next.model === "string" ? next.model : prev.model,
      duration: typeof next.duration === "string" ? next.duration : prev.duration,
      usage: typeof next.usage === "string" ? next.usage : prev.usage,
      first: typeof next.first === "boolean" ? next.first : prev.first,
      interrupt:
        typeof next.interrupt === "number" && Number.isFinite(next.interrupt)
          ? Math.max(0, Math.floor(next.interrupt))
          : prev.interrupt,
      exit:
        typeof next.exit === "number" && Number.isFinite(next.exit) ? Math.max(0, Math.floor(next.exit)) : prev.exit,
    }

    if (state.phase === "idle") {
      state.interrupt = 0
    }

    this.setState(state)

    if (prev.phase === "running" && state.phase === "idle") {
      this.flush()
      this.completeScrollback()
    }
  }

  private completeScrollback(): void {
    this.enqueue(fromCallback("scrollback.complete", () => this.scrollback.complete()))
  }

  // Runs a scrollback task after every task queued before it.
  private enqueue(task: Effect.Effect<void, FooterCallbackError>): void {
    const previous = this.flushing
    this.flushing = Effect.runFork(
      Fiber.join(previous).pipe(
        Effect.andThen(task),
        Effect.catch((error) =>
          Effect.sync(() => {
            this.flushError = Option.some(error.cause)
          }),
        ),
      ),
    )
  }

  private present(view: FooterView): void {
    if (this.isGone) {
      return
    }

    this.setView(view)
    this.applyHeight()
  }

  // Queues a scrollback commit. Consecutive progress chunks for the same
  // part coalesce by appending text, reducing the number of retained-surface
  // updates. Actual flush happens on the next microtask, so a burst of events
  // from one reducer pass becomes a single ordered drain.
  public append(commit: StreamCommit): void {
    if (this.isGone) {
      return
    }

    const last = this.queue.at(-1)
    if (
      last &&
      last.phase === "progress" &&
      commit.phase === "progress" &&
      last.kind === commit.kind &&
      last.source === commit.source &&
      last.partID === commit.partID &&
      last.tool === commit.tool
    ) {
      last.text += commit.text
    } else {
      this.queue.push(commit)
    }

    if (this.pending) {
      return
    }

    this.pending = true
    queueMicrotask(() => {
      this.pending = false
      this.flush()
    })
  }

  // FooterApi keeps idle() Promise-based for the runtime; the Effect runs here.
  public idle(): Promise<void> {
    return Effect.runPromise(this.settle())
  }

  // Drains queued commits, then waits for the renderer. It fails with the
  // first scrollback error recorded since the last settle.
  private settle(): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      if (this.isGone) {
        return Effect.void
      }

      this.flush()
      if (this.state().phase === "idle") {
        this.completeScrollback()
      }

      return Fiber.join(this.flushing).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const error = this.flushError
            if (Option.isSome(error)) {
              this.flushError = Option.none()
              return Effect.fail(error.value)
            }

            if (this.isGone) {
              return Effect.void
            }

            if (this.queue.length > 0) {
              return this.settle()
            }

            return rendererIdle(this.renderer)
          }),
        ),
      )
    })
  }

  public resetForReplay(wrote: boolean): void {
    if (this.isGone) {
      return
    }

    this.scrollback.destroy()
    this.scrollback = this.createScrollback(wrote)
  }

  public currentTheme(): RunTheme {
    return this.theme()
  }

  private destroyTheme(theme: RunTheme): void {
    const index = this.themes.indexOf(theme)
    if (index === -1) {
      return
    }

    this.themes.splice(index, 1)
    theme.block.syntax?.destroy()
    theme.block.subtleSyntax?.destroy()
  }

  public close(): void {
    if (this.closed) {
      return
    }

    this.flush()
    this.notifyClose()
  }

  public requestExit(): boolean {
    return this.requestExitHandler?.() ?? this.handleExit()
  }

  public destroy(): void {
    this.handleDestroy()
  }

  private notifyClose(): void {
    if (this.closed) {
      return
    }

    this.closed = true
    for (const fn of [...this.closes]) {
      fn()
    }
  }

  private setStatus = (status: string): void => {
    this.setNotice(status)
  }

  private setNotice(status: string): void {
    const restore = Option.getOrElse(this.noticeRestore, () => this.state().status)
    this.clearNoticeTimer()
    this.patch({ status })
    if (!status) {
      return
    }

    this.noticeRestore = Option.some(restore)
    const version = this.statusVersion
    this.noticeTimer.run(
      Effect.sleep(NOTICE_DURATION).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const next = this.noticeRestore
            this.noticeRestore = Option.none()
            if (this.isGone || version !== this.statusVersion || Option.isNone(next)) {
              return
            }

            this.patch({ status: next.value })
          }),
        ),
      ),
    )
  }

  private setRequestExitHandler = (fn?: () => boolean): void => {
    this.requestExitHandler = fn
  }

  private handleQueuedRemove = (messageID: string): Effect.Effect<boolean, FooterCallbackError> => {
    const fn = [...this.queuedRemoves][0]
    return fn ? fromCallback("queued.remove", () => fn(messageID)) : Effect.succeed(false)
  }

  private handleInputClear = (): void => {
    this.clearInterruptTimer()
    this.clearExitTimer()
    if (this.state().interrupt === 0 && this.state().exit === 0) {
      return
    }

    this.patch({ interrupt: 0, exit: 0 })
  }

  // Resizes the footer to fit the current view. Permission and question views
  // get fixed extra rows; the prompt view scales with textarea line count.
  private applyHeight(): void {
    const type = this.view().type
    const height =
      type === "permission"
        ? this.base + PERMISSION_ROWS
        : type === "question"
          ? this.base + QUESTION_ROWS
          : this.promptRoute.type === "command"
            ? 1 + COMMAND_ROWS
            : this.promptRoute.type === "skill"
              ? 1 + SKILL_ROWS
              : this.promptRoute.type === "model"
                ? 1 + MODEL_ROWS
                : this.promptRoute.type === "variant"
                  ? 1 + VARIANT_ROWS
                  : this.promptRoute.type === "queued-menu"
                    ? 1 + this.subagentMenuRows
                    : this.promptRoute.type === "subagent-menu"
                      ? 1 + this.subagentMenuRows
                      : this.promptRoute.type === "subagent"
                        ? this.base + SUBAGENT_INSPECTOR_ROWS
                        : this.base + Math.max(TEXTAREA_MIN_ROWS, Math.min(PROMPT_MAX_ROWS, this.rows))

    if (height !== this.renderer.footerHeight) {
      this.renderer.footerHeight = height
    }
  }

  private syncRows = (value: number): void => {
    if (this.isGone) {
      return
    }

    const rows = Math.max(TEXTAREA_MIN_ROWS, Math.min(PROMPT_MAX_ROWS, value))
    if (rows === this.rows) {
      return
    }

    this.rows = rows
    if (this.view().type === "prompt") {
      this.applyHeight()
    }
  }

  private syncLayout = (next: { route: FooterPromptRoute; autocomplete: boolean; subagentRows: number }): void => {
    this.promptRoute = next.route
    this.autocomplete = next.autocomplete
    this.subagentMenuRows = next.subagentRows
    if (this.view().type === "prompt") {
      this.applyHeight()
    }
  }

  private handlePrompt = (input: RunPrompt): boolean => {
    if (this.isClosed) {
      return false
    }

    if (this.state().first) {
      this.patch({ first: false })
    }

    if (this.prompts.size === 0) {
      this.setNotice("input queue unavailable")
      return false
    }

    for (const fn of [...this.prompts]) {
      fn(input)
    }

    return true
  }

  private handlePermissionReply = (input: PermissionReply): Effect.Effect<void, FooterCallbackError> =>
    Effect.suspend(() =>
      this.isClosed ? Effect.void : fromCallback("permission.reply", () => this.options.onPermissionReply(input)),
    )

  private handleQuestionReply = (input: QuestionReply): Effect.Effect<void, FooterCallbackError> =>
    Effect.suspend(() =>
      this.isClosed ? Effect.void : fromCallback("question.reply", () => this.options.onQuestionReply(input)),
    )

  private handleQuestionReject = (input: QuestionReject): Effect.Effect<void, FooterCallbackError> =>
    Effect.suspend(() =>
      this.isClosed ? Effect.void : fromCallback("question.reject", () => this.options.onQuestionReject(input)),
    )

  private handleCycle = (): void => {
    const result = this.options.onCycleVariant?.()
    if (!result) {
      this.setNotice("no variants available")
      return
    }

    const patch: FooterPatch = {}

    if ("variants" in result) {
      this.setVariants(result.variants ?? [])
    }

    if ("variant" in result) {
      this.setCurrentVariant(result.variant)
    }

    if (result.modelLabel) {
      patch.model = result.modelLabel
    }

    this.patch(patch)
    this.setNotice(result.status ?? "variant updated")
  }

  private handleModelSelect = (model: NonNullable<RunInput["model"]>): void => {
    if (this.isClosed) {
      return
    }

    const previous = this.currentModel()
    this.setCurrentModel(model)
    if (!previous || previous.providerID !== model.providerID || previous.modelID !== model.modelID) {
      this.setCurrentVariant(undefined)
    }
    Effect.runFork(
      fromCallback("model.select", () => this.options.onModelSelect?.(model)).pipe(
        Effect.andThen((result) =>
          Effect.sync(() => {
            const current = this.currentModel()
            if (
              !result ||
              this.isClosed ||
              !current ||
              current.providerID !== model.providerID ||
              current.modelID !== model.modelID
            ) {
              return
            }

            this.applySelection(result)
          }),
        ),
        Effect.ignore,
      ),
    )
  }

  private handleVariantSelect = (variant: string | undefined): void => {
    if (this.isClosed) {
      return
    }

    const model = this.currentModel()
    Effect.runFork(
      fromCallback("variant.select", () => this.options.onVariantSelect?.(variant)).pipe(
        Effect.andThen((result) =>
          Effect.sync(() => {
            const current = this.currentModel()
            if (
              !result ||
              this.isClosed ||
              (model && (!current || current.providerID !== model.providerID || current.modelID !== model.modelID))
            ) {
              return
            }

            this.applySelection(result)
          }),
        ),
        Effect.ignore,
      ),
    )
  }

  // Applies the variants, model label and status that a model or variant
  // selection returned.
  private applySelection(result: CycleResult): void {
    if ("variants" in result) {
      this.setVariants(result.variants ?? [])
    }

    if ("variant" in result) {
      this.setCurrentVariant(result.variant)
    }

    const patch: FooterPatch = {}
    if (result.modelLabel) {
      patch.model = result.modelLabel
    }

    if (patch.model) {
      this.patch(patch)
    }
    if (result.status) {
      this.setNotice(result.status)
    }
  }

  private clearInterruptTimer(): void {
    this.interruptTimer.interrupt()
  }

  private clearNoticeTimer(): void {
    this.noticeTimer.interrupt()
    this.noticeRestore = Option.none()
  }

  private armInterruptTimer(): void {
    this.interruptTimer.run(
      Effect.sleep(TWO_PRESS_WINDOW).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (this.isGone || this.state().phase !== "running") {
              return
            }

            this.patch({ interrupt: 0 })
          }),
        ),
      ),
    )
  }

  private clearExitTimer(): void {
    this.exitTimer.interrupt()
  }

  private armExitTimer(): void {
    this.exitTimer.run(
      Effect.sleep(TWO_PRESS_WINDOW).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (this.isGone || this.isClosed) {
              return
            }

            this.patch({ exit: 0 })
          }),
        ),
      ),
    )
  }

  // Two-press interrupt: first press shows a hint ("esc again to interrupt"),
  // second press within 5 seconds fires onInterrupt. The timer resets the
  // counter if the user doesn't follow through.
  private handleInterrupt = (): boolean => {
    if (this.isClosed || this.state().phase !== "running") {
      return false
    }

    const next = this.state().interrupt + 1
    this.patch({ interrupt: next })

    if (next < 2) {
      this.armInterruptTimer()
      return true
    }

    this.clearInterruptTimer()
    this.patch({ interrupt: 0 })
    this.setNotice("interrupting")
    this.options.onInterrupt?.()
    return true
  }

  private handleExit = (): boolean => {
    if (this.isClosed) {
      return true
    }

    this.clearInterruptTimer()
    const next = this.state().exit + 1
    this.patch({ exit: next, interrupt: 0 })

    if (next < 2) {
      this.armExitTimer()
      return true
    }

    this.clearExitTimer()
    this.patch({ exit: 0, status: "exiting" })
    this.close()
    this.options.onExit?.()
    return true
  }

  private handlePalette = (): void => {
    Effect.runFork(
      Effect.tryPromise({
        try: () => resolveRunTheme(this.renderer),
        catch: (cause) => new FooterCallbackError({ action: "theme.resolve", cause }),
      }).pipe(
        Effect.andThen((theme) =>
          Effect.sync(() => {
            if (this.isGone) {
              theme.block.syntax?.destroy()
              theme.block.subtleSyntax?.destroy()
              return
            }

            // Keep the last known good theme when a runtime OSC probe times out.
            if (theme === RUN_THEME_FALLBACK) {
              return
            }

            this.themes.push(theme)
            this.setTheme(theme)
            this.renderer.setBackgroundColor(theme.background)
            this.enqueue(fromCallback("scrollback.setTheme", () => this.scrollback.setTheme(theme)))
          }),
        ),
        // A failed palette probe keeps the current theme, like the fallback.
        Effect.ignore,
      ),
    )
  }

  private handleThemeNotification = (sequence: string): boolean => {
    if (sequence !== "\x1b[?997;1n" && sequence !== "\x1b[?997;2n") {
      return false
    }

    // OpenTUI clears its palette cache only when dark/light mode changes.
    // Refresh for same-mode terminal theme swaps too.
    queueMicrotask(this.handleThemeRefresh)
    return false
  }

  private handleThemeRefresh = (): void => {
    if (this.isGone) {
      return
    }

    if (this.paletteRefreshRunning) {
      this.paletteRefreshQueued = true
      return
    }

    this.paletteRefreshRunning = true
    const retry = this.renderer.paletteDetectionStatus === "detecting"
    this.renderer.clearPaletteCache()
    Effect.runFork(
      Effect.tryPromise({
        try: () => this.renderer.getPalette({ size: 256 }),
        catch: (cause) => new FooterCallbackError({ action: "renderer.getPalette", cause }),
      }).pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.sync(() => {
            this.paletteRefreshRunning = false
            if (!retry && !this.paletteRefreshQueued) {
              return
            }

            this.paletteRefreshQueued = false
            this.handleThemeRefresh()
          }),
        ),
      ),
    )
  }

  public refreshTheme(): void {
    this.handleThemeRefresh()
  }

  private handleThemeSignal = (): void => {
    // Omarchy signals immediately after requesting a terminal config reload.
    // Each delay counts from the signal, so the refreshes run side by side.
    this.themeRefreshTimer.run(
      Effect.forEach(
        THEME_REFRESH_DELAYS,
        (delay) => Effect.sleep(delay).pipe(Effect.andThen(Effect.sync(this.handleThemeRefresh))),
        { concurrency: "unbounded", discard: true },
      ),
    )
  }

  private handleDestroy = (): void => {
    if (this.destroyed) {
      return
    }

    this.flush()
    this.destroyed = true
    this.notifyClose()
    this.clearInterruptTimer()
    this.clearExitTimer()
    this.clearNoticeTimer()
    this.renderer.off(CliRenderEvents.DESTROY, this.handleDestroy)
    this.renderer.off(CliRenderEvents.PALETTE, this.handlePalette)
    this.renderer.off(CliRenderEvents.THEME_MODE, this.handleThemeRefresh)
    this.renderer.removeInputHandler(this.handleThemeNotification)
    process.off("SIGUSR2", this.handleThemeSignal)
    this.themeRefreshTimer.interrupt()
    this.prompts.clear()
    this.queuedRemoves.clear()
    this.closes.clear()
    this.scrollback.destroy()
    for (const theme of [...this.themes]) this.destroyTheme(theme)
  }

  // Drains the commit queue to scrollback. The surface manager owns grouping,
  // spacing, and progressive markdown/code settling so direct mode can append
  // immutable transcript rows without rewriting history.
  private flush(): void {
    if (this.isGone || this.queue.length === 0) {
      this.queue.length = 0
      return
    }

    const batch = this.queue.splice(0)
    this.enqueue(
      Effect.forEach(batch, (item) => fromCallback("scrollback.append", () => this.scrollback.append(item)), {
        discard: true,
      }),
    )
  }
}
