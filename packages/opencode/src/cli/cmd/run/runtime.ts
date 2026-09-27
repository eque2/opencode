// Top-level orchestrator for `opencode --mini`.
//
// Wires the boot sequence, lifecycle (renderer + footer), stream transport,
// and prompt queue together into a single session loop. Two entry points:
//
//   runInteractiveMode     -- used when an SDK client already exists (attach mode)
//   runInteractiveLocalMode -- used for local in-process mode (no server)
//
// Both delegate to runInteractiveRuntime, which:
//   1. resolves TUI config, model info, and session history,
//   2. creates the split-footer lifecycle (renderer + RunFooter),
//   3. starts the stream transport (SDK event subscription), lazily for fresh
//      local sessions,
//   4. runs the prompt queue until the footer closes.
import { Cause, Duration, Effect, Fiber, Option, Schema } from "effect"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { FlagConfig } from "@opencode-ai/core/flag/flag"
import { MessageID } from "@/session/schema"
import { createRunDemo } from "./demo"
import {
  resolveModelInfo,
  resolveRunTuiConfig,
  resolveSessionInfo,
  type ModelInfo,
  type SessionInfo,
} from "./runtime.boot"
import { createRuntimeLifecycle, RuntimeClosedError } from "./runtime.lifecycle"
import { trace } from "./trace"
import { cycleVariant, formatModelLabel, resolveSavedVariant, resolveVariant, saveVariant } from "./variant.shared"
import type {
  LocalReplayAnchor,
  LocalReplayRow,
  PermissionReply,
  QuestionReject,
  QuestionReply,
  RunInput,
  RunPrompt,
  RunProvider,
  StreamCommit,
} from "./types"

/** @internal Exported for testing */
export { pickVariant, resolveVariant } from "./variant.shared"

/** @internal Exported for testing */
export { runPromptQueue } from "./runtime.queue"

// A session could not be created or found.
export class RunSessionError extends Schema.TaggedError<RunSessionError>()("RunSessionError", {
  message: Schema.String,
}) {}

type BootContext = Pick<
  RunInput,
  "sdk" | "directory" | "sessionID" | "sessionTitle" | "resume" | "agent" | "model" | "variant"
>

type CreateSessionInput = {
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
}

type CreateSession = (sdk: RunInput["sdk"], input: CreateSessionInput) => Promise<{ id: string; title?: string }>

type ResolvedSession = {
  sessionID: string
  sessionTitle?: string
  agent?: string | undefined
}

type RunRuntimeInput = {
  boot: BootContext
  resolveSession?: (ctx: BootContext) => Effect.Effect<ResolvedSession, RunSessionError>
  createSession?: (ctx: BootContext, input: CreateSessionInput) => Effect.Effect<ResolvedSession, RunSessionError>
  files: RunInput["files"]
  initialInput?: string
  thinking: boolean
  backgroundSubagents: boolean
  replay?: boolean
  replayLimit?: number
  demo?: RunInput["demo"]
}

type RunLocalInput = {
  directory: string
  fetch: typeof globalThis.fetch
  resolveAgent: () => Promise<string | undefined>
  session: (sdk: RunInput["sdk"]) => Promise<{ id: string; title?: string } | undefined>
  share: (sdk: RunInput["sdk"], sessionID: string) => Promise<void>
  createSession?: CreateSession
  agent: RunInput["agent"]
  model: RunInput["model"]
  variant: RunInput["variant"]
  files: RunInput["files"]
  initialInput?: string
  thinking: boolean
  backgroundSubagents: boolean
  replay?: boolean
  replayLimit?: number
  demo?: RunInput["demo"]
}

type StreamTransportModule = Pick<
  Awaited<typeof import("./stream.transport")>,
  "createSessionTransport" | "formatUnknownError"
>

export type RunRuntimeDeps = {
  createRuntimeLifecycle?: typeof createRuntimeLifecycle
  streamTransport?: Promise<StreamTransportModule>
}

type StreamState = {
  mod: StreamTransportModule
  handle: Awaited<ReturnType<StreamTransportModule["createSessionTransport"]>>
}

type RunDemo = ReturnType<typeof createRunDemo>

function createSessionResolver(fn?: CreateSession) {
  if (!fn) {
    return undefined
  }

  return (ctx: BootContext, input: CreateSessionInput) =>
    Effect.promise(() => fn(ctx.sdk, input)).pipe(
      Effect.flatMap((created) =>
        created.id
          ? Effect.succeed<ResolvedSession>({
              sessionID: created.id,
              sessionTitle: created.title,
              agent: input.agent,
            })
          : Effect.fail(new RunSessionError({ message: "Failed to create session" })),
      ),
    )
}

type RuntimeState = {
  shown: boolean
  aborting: boolean
  model: RunInput["model"]
  providers: RunProvider[]
  variants: string[]
  limits: Record<string, number>
  activeVariant: Option.Option<string>
  sessionID: string
  history: RunPrompt[]
  localRows: LocalReplayRow[]
  sessionTitle?: string
  agent: string | undefined
  switching: Option.Option<Fiber.Fiber<void>>
  demo: Option.Option<RunDemo>
  selectSubagent: Option.Option<(sessionID: string | undefined) => void>
  session: Option.Option<Effect.Effect<void, RunSessionError>>
  stream: Option.Option<Effect.Effect<StreamState, RunSessionError | RuntimeClosedError>>
}

function hasSession(input: RunRuntimeInput, state: RuntimeState) {
  return !input.resolveSession || !!state.sessionID
}

function eagerStream(input: RunRuntimeInput, ctx: BootContext) {
  return ctx.resume === true || !input.resolveSession || !!input.demo
}

function variantsFor(providers: RunProvider[], model: RunInput["model"]) {
  if (!model) {
    return []
  }

  return Object.keys(providers.find((item) => item.id === model.providerID)?.models?.[model.modelID]?.variants ?? {})
}

function sameModel(current: RunInput["model"], model: NonNullable<RunInput["model"]>) {
  return !!current && current.providerID === model.providerID && current.modelID === model.modelID
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// Waits for a Promise and ignores its failure.
function settle(run: () => Promise<unknown>) {
  return Effect.tryPromise(run).pipe(Effect.ignore)
}

// Runs an SDK request and uses the fallback when it rejects.
function request<A, B>(run: () => Promise<A>, map: (value: A) => B, fallback: B) {
  return Effect.tryPromise(run).pipe(
    Effect.map(map),
    Effect.orElseSucceed(() => fallback),
  )
}

const RESIZE_DELAY = Duration.millis(250)
const LOCAL_REPLAY_ROW_LIMIT = 100

function resolveExitTitle(ctx: BootContext, input: RunRuntimeInput, state: RuntimeState) {
  if (!state.shown || !hasSession(input, state)) {
    return Effect.succeed(Option.none<string>())
  }

  return request(
    () => ctx.sdk.session.get({ sessionID: state.sessionID }),
    (x) => Option.fromNullishOr(x.data?.title),
    Option.none<string>(),
  )
}

// Core runtime loop. Boot resolves the SDK context, then we set up the
// lifecycle (renderer + footer), wire the stream transport for SDK events,
// and feed prompts through the queue until the user exits.
//
// Files only attach on the first prompt turn -- after that, includeFiles
// flips to false so subsequent turns don't re-send attachments.
const runInteractiveRuntime = Effect.fnUntraced(function* (input: RunRuntimeInput, deps: RunRuntimeDeps) {
  const start = performance.now()
  const log = trace()
  const tuiConfigFiber = yield* Effect.forkChild(
    Effect.promise(() => resolveRunTuiConfig()),
    { startImmediately: true },
  )
  const ctx = input.boot
  const modelFiber = yield* Effect.forkChild(
    Effect.promise(() => resolveModelInfo(ctx.sdk, ctx.directory, ctx.model)),
    { startImmediately: true },
  )
  const sessionInfo =
    ctx.resume === true
      ? Effect.promise(() => resolveSessionInfo(ctx.sdk, ctx.sessionID, ctx.model))
      : Effect.succeed<SessionInfo>({
          first: true,
          history: [],
        })
  const [tuiConfig, session, savedVariant] = yield* Effect.all(
    [Fiber.join(tuiConfigFiber), sessionInfo, Effect.promise(() => resolveSavedVariant(ctx.model))],
    { concurrency: "unbounded" },
  )
  const saved = Option.fromNullishOr(savedVariant)
  const sessionVariant = Option.fromNullishOr(session.variant)
  // resolveVariant takes the plain optional strings of the variant helpers.
  const pickVariant = (current: Option.Option<string>, preference: Option.Option<string>, variants: string[]) =>
    Option.fromNullishOr(
      resolveVariant(ctx.variant, Option.getOrUndefined(current), Option.getOrUndefined(preference), variants),
    )
  const state: RuntimeState = {
    shown: !session.first,
    aborting: false,
    model: ctx.model,
    providers: [],
    variants: [],
    limits: {},
    activeVariant: pickVariant(sessionVariant, saved, []),
    sessionID: ctx.sessionID,
    history: [...session.history],
    localRows: [],
    sessionTitle: ctx.sessionTitle,
    agent: ctx.agent,
    switching: Option.none(),
    demo: Option.none(),
    selectSubagent: Option.none(),
    session: Option.none(),
    stream: Option.none(),
  }
  const currentVariant = () => Option.getOrUndefined(state.activeVariant)
  const variantStatus = () =>
    Option.match(state.activeVariant, {
      onNone: () => "variant default",
      onSome: (variant) => `variant ${variant}`,
    })

  const ensureSession = Effect.suspend(() => {
    const resolve = input.resolveSession
    if (!resolve || state.sessionID) {
      return Effect.void
    }

    if (Option.isSome(state.session)) {
      return state.session.value
    }

    return Effect.cached(
      resolve(ctx).pipe(
        Effect.map((next) => {
          state.sessionID = next.sessionID
          state.sessionTitle = next.sessionTitle ?? state.sessionTitle
          state.agent = next.agent
        }),
      ),
    ).pipe(
      Effect.tap((memo) =>
        Effect.sync(() => {
          state.session = Option.some(memo)
        }),
      ),
      Effect.flatten,
    )
  })

  // Waits for an in-flight model switch. A failed switch does not block the caller.
  const awaitSwitching = Effect.suspend(() =>
    Option.match(state.switching, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
    }),
  )

  const modelSelect = Effect.fnUntraced(function* (model: NonNullable<RunInput["model"]>) {
    if (sameModel(state.model, model)) {
      return Option.none()
    }

    state.model = model
    state.activeVariant = Option.none()
    state.variants = variantsFor(state.providers, model)
    const switching = yield* Effect.forkChild(
      Effect.promise(() => resolveSavedVariant(model)).pipe(
        Effect.map((next) => {
          if (!sameModel(state.model, model)) {
            return
          }

          state.activeVariant = pickVariant(Option.none(), Option.fromNullishOr(next), state.variants)
        }),
      ),
      { startImmediately: true },
    )
    state.switching = Option.some(switching)
    yield* Fiber.join(switching)
    if (Option.exists(state.switching, (item) => item === switching)) {
      state.switching = Option.none()
    }

    if (!sameModel(state.model, model)) {
      return Option.none()
    }

    return Option.some({
      modelLabel: formatModelLabel(model, currentVariant(), state.providers),
      status: `model ${model.modelID}`,
      variant: currentVariant(),
      variants: state.variants,
    })
  })

  const demoHandles = (check: (demo: RunDemo) => boolean) => Option.exists(state.demo, check)

  const shell = yield* Effect.promise(() =>
    (deps.createRuntimeLifecycle ?? createRuntimeLifecycle)({
      directory: ctx.directory,
      findFiles: (query) =>
        Effect.runPromise(
          request(
            () => ctx.sdk.find.files({ query, directory: ctx.directory }),
            (x) => x.data ?? [],
            [],
          ),
        ),
      agents: [],
      resources: [],
      sessionID: state.sessionID,
      sessionTitle: state.sessionTitle,
      getSessionID: () => state.sessionID,
      first: session.first,
      history: session.history,
      agent: state.agent,
      model: state.model,
      variant: currentVariant(),
      tuiConfig,
      backgroundSubagents: input.backgroundSubagents,
      onPermissionReply: (next: PermissionReply) =>
        Effect.runPromise(
          Effect.gen(function* () {
            if (demoHandles((demo) => demo.permission(next))) {
              return
            }

            log?.write("send.permission.reply", next)
            yield* Effect.promise(() => ctx.sdk.permission.reply(next))
          }),
        ),
      onQuestionReply: (next: QuestionReply) =>
        Effect.runPromise(
          Effect.gen(function* () {
            if (demoHandles((demo) => demo.questionReply(next))) {
              return
            }

            yield* Effect.promise(() => ctx.sdk.question.reply(next))
          }),
        ),
      onQuestionReject: (next: QuestionReject) =>
        Effect.runPromise(
          Effect.gen(function* () {
            if (demoHandles((demo) => demo.questionReject(next))) {
              return
            }

            yield* Effect.promise(() => ctx.sdk.question.reject(next))
          }),
        ),
      onCycleVariant: () => {
        if (!state.model || state.variants.length === 0) {
          return {
            status: "no variants available",
          }
        }

        state.activeVariant = Option.fromNullishOr(cycleVariant(currentVariant(), state.variants))
        saveVariant(state.model, currentVariant())
        return {
          status: variantStatus(),
          modelLabel: formatModelLabel(state.model, currentVariant(), state.providers),
          variant: currentVariant(),
        }
      },
      onModelSelect: (model) => Effect.runPromise(modelSelect(model).pipe(Effect.map(Option.getOrUndefined))),
      onVariantSelect: (variant) => {
        if (!state.model || state.variants.length === 0) {
          return {
            status: "no variants available",
          }
        }

        if (variant && !state.variants.includes(variant)) {
          return {
            status: `variant ${variant} unavailable`,
          }
        }

        state.activeVariant = Option.fromNullishOr(variant)
        saveVariant(state.model, currentVariant())
        return {
          status: variantStatus(),
          modelLabel: formatModelLabel(state.model, currentVariant(), state.providers),
          variant: currentVariant(),
          variants: state.variants,
        }
      },
      onInterrupt: () => {
        if (!hasSession(input, state) || state.aborting) {
          return
        }

        state.aborting = true
        Effect.runFork(
          settle(() => ctx.sdk.session.abort({ sessionID: state.sessionID })).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                state.aborting = false
              }),
            ),
          ),
        )
      },
      onBackground: () => {
        if (!hasSession(input, state)) return
        Effect.runFork(settle(() => ctx.sdk.experimental.session.background({ sessionID: state.sessionID })))
      },
      onSubagentSelect: (sessionID) => {
        if (Option.isSome(state.selectSubagent)) {
          state.selectSubagent.value(sessionID)
        }
        log?.write("subagent.select", {
          sessionID,
        })
      },
    }),
  )
  const footer = shell.footer
  const rememberLocal = (commit: StreamCommit, after: Option.Option<LocalReplayAnchor>) => {
    // LocalReplayRow keeps the anchor as a plain optional field.
    state.localRows = [...state.localRows, { commit, after: Option.getOrUndefined(after) }].slice(
      -LOCAL_REPLAY_ROW_LIMIT,
    )
  }

  const loadCatalog = Effect.gen(function* () {
    if (footer.isClosed) {
      return
    }

    const [agents, resources, commands] = yield* Effect.all(
      [
        request(
          () => ctx.sdk.app.agents({ directory: ctx.directory }),
          (x) => x.data ?? [],
          [],
        ),
        request(
          () => ctx.sdk.experimental.resource.list({ directory: ctx.directory }),
          (x) => Object.values(x.data ?? {}),
          [],
        ),
        request(
          () => ctx.sdk.command.list({ directory: ctx.directory }),
          (x) => x.data ?? [],
          [],
        ),
      ],
      { concurrency: "unbounded" },
    )
    if (footer.isClosed) {
      return
    }

    footer.event({
      type: "catalog",
      agents,
      resources,
      commands,
    })
  })

  yield* Effect.forkChild(settle(() => footer.idle()).pipe(Effect.andThen(loadCatalog)), { startImmediately: true })

  if (yield* FlagConfig.OPENCODE_SHOW_TTFD.pipe(Effect.orDie)) {
    footer.append({
      kind: "system",
      text: `startup ${Math.max(0, Math.round(performance.now() - start))}ms`,
      phase: "final",
      source: "system",
    })
  }

  const makeDemo = () =>
    createRunDemo({
      footer,
      sessionID: state.sessionID,
      thinking: input.thinking,
      limits: () => state.limits,
    })

  if (input.demo) {
    yield* ensureSession
    state.demo = Option.some(makeDemo())
  }

  const applyModelInfo = (info: ModelInfo) => {
    state.providers = info.providers
    state.variants = variantsFor(state.providers, state.model)
    state.limits = info.limits
    state.activeVariant = pickVariant(sessionVariant, saved, state.variants)

    if (footer.isClosed) {
      return
    }

    footer.event({ type: "models", providers: info.providers })
    footer.event({ type: "variants", variants: state.variants, current: currentVariant() })
    if (!state.model) {
      return
    }

    footer.event({
      type: "model",
      model: formatModelLabel(state.model, currentVariant(), state.providers),
    })
  }
  const modelApplied = yield* Effect.forkChild(Fiber.join(modelFiber).pipe(Effect.map(applyModelInfo)), {
    startImmediately: true,
  })

  const streamTask = deps.streamTransport ?? import("./stream.transport")
  const runtimeClosed = () => new RuntimeClosedError({ message: "runtime closed" })
  const openStream = Effect.gen(function* () {
    yield* ensureSession
    if (footer.isClosed) {
      return yield* runtimeClosed()
    }

    const mod = yield* Effect.promise(() => streamTask)
    if (footer.isClosed) {
      return yield* runtimeClosed()
    }

    const handle = yield* Effect.promise(() =>
      mod.createSessionTransport({
        sdk: ctx.sdk,
        directory: ctx.directory,
        sessionID: state.sessionID,
        thinking: input.thinking,
        replay: input.replay,
        replayLimit: input.replayLimit,
        limits: () => state.limits,
        providers: () => state.providers,
        footer,
        trace: log,
      }),
    )
    if (footer.isClosed) {
      yield* Effect.promise(() => handle.close())
      return yield* runtimeClosed()
    }

    state.selectSubagent = Option.some((sessionID: string | undefined) => handle.selectSubagent(sessionID))
    const next: StreamState = { mod, handle }
    return next
  })

  // Shares eager prewarm and first-turn boot through one in-flight open, but
  // clears it when transport creation fails so a later prompt can retry.
  const ensureStream = Effect.suspend(() => {
    if (Option.isSome(state.stream)) {
      return state.stream.value
    }

    return Effect.gen(function* () {
      const memo = yield* Effect.cached(openStream)
      state.stream = Option.some(memo)
      return yield* memo.pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            if (Option.exists(state.stream, (item) => item === memo)) {
              state.stream = Option.none()
            }
          }),
        ),
      )
    })
  })

  const closeStream = Effect.suspend(() =>
    Option.match(state.stream, {
      onNone: () => Effect.void,
      onSome: (memo) =>
        memo.pipe(
          Effect.flatMap((item) => Effect.promise(() => item.handle.close())),
          Effect.ignoreCause,
        ),
    }),
  )

  const streamModule = Effect.suspend(() =>
    Option.match(state.stream, {
      onNone: () => Effect.succeed(Option.none<StreamTransportModule>()),
      onSome: (memo) =>
        memo.pipe(
          Effect.map((item) => Option.some(item.mod)),
          Effect.catchCause(() => Effect.succeed(Option.none<StreamTransportModule>())),
        ),
    }),
  )

  const replayOnResize = Effect.gen(function* () {
    if (footer.isClosed) {
      return
    }

    shell.refreshTheme()
    if (!input.replay || Option.isNone(state.stream)) {
      return
    }

    yield* state.stream.value.pipe(
      Effect.flatMap((item) =>
        Effect.promise(() =>
          item.handle.replayOnResize({
            localRows: () => state.localRows,
            reset: () =>
              shell.resetForReplay({
                sessionTitle: state.sessionTitle,
                sessionID: state.sessionID,
                history: state.history,
              }),
          }),
        ),
      ),
      Effect.ignoreCause,
    )
  })

  // Debounces resize: each resize interrupts the pending refresh and waits again.
  let resizeFiber = Option.none<Fiber.Fiber<void>>()
  const offResize = shell.onResize(() => {
    const pending = resizeFiber
    if (Option.isSome(pending)) {
      Effect.runFork(Fiber.interrupt(pending.value))
    }

    resizeFiber = Option.some(Effect.runFork(Effect.sleep(RESIZE_DELAY).pipe(Effect.andThen(replayOnResize))))
  })

  const runQueue = Effect.gen(function* () {
    let includeFiles = true
    const demo = state.demo
    if (Option.isSome(demo)) {
      yield* Effect.promise(() => demo.value.start())
    }

    const newSession = (createSession: NonNullable<RunRuntimeInput["createSession"]>) =>
      Effect.gen(function* () {
        yield* awaitSwitching
        const created = yield* createSession(ctx, {
          agent: state.agent,
          model: state.model,
          variant: currentVariant(),
        })
        yield* settle(() => footer.idle())
        yield* closeStream
        state.stream = Option.none()
        state.session = Option.none()
        state.selectSubagent = Option.none()
        state.shown = false
        state.sessionID = created.sessionID
        state.sessionTitle = created.sessionTitle
        state.agent = created.agent ?? state.agent
        state.history = []
        state.localRows = []
        includeFiles = true
        const nextDemo = input.demo ? Option.some(makeDemo()) : Option.none<RunDemo>()
        state.demo = nextDemo
        log?.write("session.new", {
          sessionID: state.sessionID,
        })
        footer.event({
          type: "stream.subagent",
          state: {
            tabs: [],
            details: {},
            permissions: [],
            questions: [],
          },
        })
        footer.event({ type: "stream.view", view: { type: "prompt" } })
        footer.event({
          type: "stream.patch",
          patch: {
            phase: "idle",
            duration: "",
            usage: "",
            first: true,
          },
        })
        footer.append({
          kind: "system",
          text: `new session ${state.sessionID}`,
          phase: "final",
          source: "system",
        })
        if (Option.isSome(nextDemo)) {
          yield* Effect.promise(() => nextDemo.value.start())
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            footer.event({
              type: "stream.patch",
              patch: {
                phase: "idle",
                status: "failed to start new session",
              },
            })
            const commit = {
              kind: "error",
              text: errorText(Cause.squash(cause)),
              phase: "start",
              source: "system",
              messageID: MessageID.ascending(),
            } as const
            rememberLocal(commit, Option.none())
            footer.append(commit)
          }),
        ),
      )

    const runTurn = (prompt: RunPrompt, signal: AbortSignal) =>
      Effect.gen(function* () {
        const turnDemo = state.demo
        if (Option.isSome(turnDemo) && (yield* Effect.promise(() => turnDemo.value.prompt(prompt, signal)))) {
          return
        }

        yield* awaitSwitching

        let outputAnchor = Option.none<LocalReplayAnchor>()
        yield* Effect.gen(function* () {
          const next = yield* ensureStream
          yield* Effect.promise(() =>
            next.handle.runPromptTurn({
              agent: state.agent,
              model: state.model,
              variant: currentVariant(),
              prompt,
              files: input.files,
              includeFiles,
              onVisibleOutput: (anchor) => {
                outputAnchor = Option.some(anchor)
              },
              signal,
            }),
          )
          if (prompt.messageID) {
            state.localRows = state.localRows.filter(
              (row) => row.commit.kind !== "user" || row.commit.messageID !== prompt.messageID,
            )
          }
          includeFiles = false
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (signal.aborted || footer.isClosed) {
                return
              }

              const error = Cause.squash(cause)
              const mod = yield* streamModule
              const text = Option.match(mod, {
                onNone: () => errorText(error),
                onSome: (item) => item.formatUnknownError(error),
              })
              const commit = {
                kind: "error",
                text,
                phase: "start",
                source: "system",
                messageID: prompt.messageID,
              } as const
              rememberLocal(commit, outputAnchor)
              footer.append(commit)
            }),
          ),
        )
      })

    const mod = yield* Effect.promise(() => import("./runtime.queue"))
    const createSession = input.createSession
    yield* Effect.promise(() =>
      mod.runPromptQueue({
        footer,
        initialInput: input.initialInput,
        trace: log,
        onSend: (prompt) => {
          state.shown = true
          state.history.push(prompt)
          if (prompt.mode !== "shell") {
            rememberLocal(
              {
                kind: "user",
                text: prompt.text,
                phase: "start",
                source: "system",
                messageID: prompt.messageID,
              },
              Option.none(),
            )
          }
        },
        ...(createSession ? { onNewSession: () => Effect.runPromise(newSession(createSession)) } : {}),
        run: (prompt, signal) => Effect.runPromise(runTurn(prompt, signal)),
      }),
    )
  })

  const main = Effect.gen(function* () {
    const eager = eagerStream(input, ctx)
    if (eager) {
      if (input.replay && state.shown) {
        // Replay commits immutable scrollback rows, so wait for provider names
        // before bootstrapping existing session history.
        yield* Fiber.join(modelApplied)
      }

      yield* ensureStream
    }

    if (!eager && input.resolveSession) {
      queueMicrotask(() => {
        if (footer.isClosed) {
          return
        }

        Effect.runFork(ensureStream.pipe(Effect.ignoreCause))
      })
    }

    yield* runQueue.pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const pending = resizeFiber
          if (Option.isSome(pending)) {
            yield* Fiber.interrupt(pending.value)
          }
          offResize()
          yield* closeStream
        }),
      ),
    )
  })

  yield* main.pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const title = yield* resolveExitTitle(ctx, input, state)

        yield* Effect.promise(() =>
          shell.close({
            showExit: state.shown && hasSession(input, state),
            sessionTitle: Option.getOrUndefined(title),
            sessionID: state.sessionID,
            history: state.history,
          }),
        )
      }),
    ),
  )
})

// Local in-process mode. Creates an SDK client backed by a direct fetch to
// the in-process server, so no external HTTP server is needed.
export function runInteractiveLocalMode(input: RunLocalInput): Promise<void> {
  return Effect.runPromise(runLocal(input))
}

const runLocal = Effect.fnUntraced(function* (input: RunLocalInput) {
  const sdk = createOpencodeClient({
    baseUrl: "http://opencode.internal",
    fetch: input.fetch,
    directory: input.directory,
  })
  // The first caller resolves the session; later callers share the result.
  const session = yield* Effect.cached(
    Effect.gen(function* () {
      const [agent, next] = yield* Effect.all(
        [Effect.promise(() => input.resolveAgent()), Effect.promise(() => input.session(sdk))],
        { concurrency: "unbounded" },
      )
      if (!next?.id) {
        return yield* new RunSessionError({ message: "Session not found" })
      }

      yield* Effect.forkDetach(
        settle(() => input.share(sdk, next.id)),
        { startImmediately: true },
      )
      const resolved: ResolvedSession = {
        sessionID: next.id,
        sessionTitle: next.title,
        agent,
      }
      return resolved
    }),
  )

  yield* runInteractiveRuntime(
    {
      files: input.files,
      initialInput: input.initialInput,
      thinking: input.thinking,
      backgroundSubagents: input.backgroundSubagents,
      replay: input.replay,
      replayLimit: input.replayLimit,
      demo: input.demo,
      resolveSession: () => session,
      createSession: createSessionResolver(input.createSession),
      boot: {
        sdk,
        directory: input.directory,
        sessionID: "",
        resume: false,
        agent: input.agent,
        model: input.model,
        variant: input.variant,
      },
    },
    {},
  )
})

// Attach mode. Uses the caller-provided SDK client directly.
export function runInteractiveMode(
  input: RunInput & { createSession?: CreateSession },
  deps: RunRuntimeDeps = {},
): Promise<void> {
  return Effect.runPromise(
    runInteractiveRuntime(
      {
        files: input.files,
        initialInput: input.initialInput,
        thinking: input.thinking,
        backgroundSubagents: input.backgroundSubagents,
        replay: input.replay,
        replayLimit: input.replayLimit,
        demo: input.demo,
        boot: {
          sdk: input.sdk,
          directory: input.directory,
          sessionID: input.sessionID,
          sessionTitle: input.sessionTitle,
          resume: input.resume,
          agent: input.agent,
          model: input.model,
          variant: input.variant,
        },
        createSession: createSessionResolver(input.createSession),
      },
      deps,
    ),
  )
}
