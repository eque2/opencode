import { Array as Arr, Clock, Data, Effect, MutableHashMap, MutableHashSet, Option, Predicate, Result } from "effect"
import type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslOpencodeCheck,
  WslRuntimeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
} from "../../preload/types"
import { WSL_SERVERS_KEY } from "../store-keys"
import { getStore } from "../store"
import {
  expectOpencodeVersion,
  pendingRestartAfterWslInstall,
  type WslVersionMismatchError,
  wslServerIdsToStartOnInitialize,
} from "./startup"
import { clearWslDistroState, wslServerIdToRestart } from "./policy"
import { nativeT } from "../native-translations"
import {
  installWslDistro,
  installWslOpencode,
  installWslRuntimeElevated,
  listInstalledWslDistros,
  listOnlineWslDistros,
  openWslTerminal,
  probeWslDistro,
  probeWslRuntime,
  readWslCommandVersion,
  resolveWslOpencode,
  summarize,
  type WslCommandResult,
} from "./runtime"

type RunningSidecar = {
  listener: { stop: () => void; onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void }
  url: string
  username: string | null
  password: string
}

type SpawnSidecar = (distro: string) => Promise<RunningSidecar>

type ControllerLogger = {
  log: (message: string, meta?: unknown) => void
  error: (message: string, meta?: unknown) => void
}

type WslServersControllerOptions = {
  logger?: ControllerLogger
  readServers?: () => WslServerConfig[]
  writeServers?: (servers: WslServerConfig[]) => void
  probeDistro?: typeof probeWslDistro
  resolveOpencode?: typeof resolveWslOpencode
  readCommandVersion?: typeof readWslCommandVersion
}

class WslServersError extends Data.TaggedError("WslServersError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

class WslJobAborted extends Data.TaggedError("WslJobAborted")<{ readonly message: string }> {}

type WslJobError = WslServersError | WslJobAborted | WslVersionMismatchError

export type WslServersController = ReturnType<typeof createWslServersController>

export function wslServerIdForDistro(distro: string) {
  return `wsl:${distro}`
}

export function createWslServersController(
  appVersion: string,
  spawnSidecar: SpawnSidecar,
  options?: WslServersControllerOptions,
) {
  let state: WslServersState = initialState()
  const listeners = MutableHashSet.empty<(event: WslServersEvent) => void>()
  const sidecars = MutableHashMap.empty<string, RunningSidecar>()
  const startAttempts = MutableHashMap.empty<string, number>()
  let jobAbort = Option.none<AbortController>()
  const logger = options?.logger
  const readServers = options?.readServers ?? readPersistedServers
  const writeServers = options?.writeServers ?? writePersistedServers
  const probeDistro = options?.probeDistro ?? probeWslDistro
  const resolveOpencode = options?.resolveOpencode ?? resolveWslOpencode
  const readCommandVersion = options?.readCommandVersion ?? readWslCommandVersion

  const emit = () => {
    for (const listener of listeners) listener({ type: "state", state })
  }

  const setState = (next: Partial<WslServersState>) => {
    state = { ...state, ...next }
    emit()
  }

  const persistServers = (servers: WslServerConfig[]) => {
    writeServers(servers)
  }

  const updateServer = (id: string, update: (item: WslServerItem) => WslServerItem) => {
    const next = state.servers.map((item) => (item.config.id === id ? update(item) : item))
    setState({ servers: next })
  }

  const beginJob = (job: WslJob): AbortController => {
    if (Option.isSome(jobAbort)) jobAbort.value.abort()
    const abort = new AbortController()
    jobAbort = Option.some(abort)
    setState({ job })
    return abort
  }

  const endJob = (abort: AbortController) => {
    if (!Option.exists(jobAbort, (current) => current === abort)) return
    jobAbort = Option.none()
    // eslint-disable-next-line effect/no-null-use-option -- (a) WslServersState from @opencode-ai/app/wsl/types is the IPC wire type the renderer reads; it types "no job" as null
    setState({ job: null })
  }

  const refreshFromStore = () => {
    const persisted = readServers()
    const items: WslServerItem[] = persisted.map((config) => {
      const existing = state.servers.find((item) => item.config.id === config.id)
      return {
        config,
        runtime: existing?.runtime ?? { kind: "stopped" },
      }
    })
    setState({ servers: items })
  }

  const setRuntime = (id: string, runtime: WslServerRuntime) => {
    updateServer(id, (item) => ({ ...item, runtime }))
  }

  const setOpencodeCheck = (distro: string, check: WslOpencodeCheck) => {
    setState({
      opencodeChecks: {
        ...state.opencodeChecks,
        [distro]: check,
      },
    })
  }

  const checkOpencode = (distro: string, opts?: { signal?: AbortSignal }) =>
    Effect.gen(function* () {
      const resolved = nonEmpty(yield* fromPromise(() => resolveOpencode(distro, opts)))
      const version = yield* Option.match(resolved, {
        onNone: () => Effect.succeedNone,
        onSome: (command) => fromPromise(() => readCommandVersion(command, distro, opts)).pipe(Effect.map(nonEmpty)),
      })
      return opencodeCheck(distro, resolved, version, appVersion)
    })

  const refreshOpencodeCheck = (distro: string, opts?: { signal?: AbortSignal }) =>
    checkOpencode(distro, opts).pipe(Effect.map((check) => setOpencodeCheck(distro, check)))

  const probeAddableDistros = (distros: string[], opts?: { signal?: AbortSignal }) =>
    Effect.gen(function* () {
      const unique = Arr.dedupe(distros)
      const distroProbes = yield* Effect.all(
        unique
          .filter((distro) => !state.distroProbes[distro])
          .map((distro) =>
            fromPromise(() => probeDistro(distro, opts)).pipe(Effect.map((probe) => [distro, probe] as const)),
          ),
        { concurrency: "unbounded" },
      )
      if (distroProbes.length) {
        setState({ distroProbes: { ...state.distroProbes, ...Object.fromEntries(distroProbes) } })
      }

      const opencodeChecks = yield* Effect.all(
        unique
          .filter((distro) => distroProbeReady(state.distroProbes[distro]))
          .filter((distro) => !state.opencodeChecks[distro])
          .map((distro) => checkOpencode(distro, opts).pipe(Effect.map((check) => [distro, check] as const))),
        { concurrency: "unbounded" },
      )
      if (opencodeChecks.length) {
        setState({ opencodeChecks: { ...state.opencodeChecks, ...Object.fromEntries(opencodeChecks) } })
      }
    })

  const hasServer = (id: string, distro: string) => {
    return state.servers.some((item) => item.config.id === id && item.config.distro === distro)
  }

  // Records a check only while the server still exists; a failure is logged, never raised.
  const refreshServerOpencodeCheck = (id: string, distro: string) =>
    checkOpencode(distro).pipe(
      Effect.map((check) => {
        if (!hasServer(id, distro)) return
        setOpencodeCheck(distro, check)
      }),
      Effect.catch((error) =>
        Effect.sync(() => logger?.error("wsl opencode check failed", { id, distro, message: error.message })),
      ),
    )

  const refreshOpencodeChecks = Effect.suspend(() =>
    Effect.all(
      state.servers.map((item) => refreshServerOpencodeCheck(item.config.id, item.config.distro)),
      { concurrency: "unbounded", discard: true },
    ),
  )

  const refreshDistroLists = (opts: { signal?: AbortSignal }) =>
    Effect.all(
      {
        installed: fromPromise(() => listInstalledWslDistros(opts)),
        online: fromPromise(() => listOnlineWslDistros(opts)),
      },
      { concurrency: "unbounded" },
    )

  const nextStartAttempt = (id: string) => {
    const next = Option.getOrElse(MutableHashMap.get(startAttempts, id), () => 0) + 1
    MutableHashMap.set(startAttempts, id, next)
    return next
  }

  const invalidateStartAttempt = (id: string) => {
    nextStartAttempt(id)
  }

  const isCurrentStartAttempt = (id: string, attempt: number) => {
    return (
      Option.contains(MutableHashMap.get(startAttempts, id), attempt) &&
      state.servers.some((item) => item.config.id === id)
    )
  }

  const startServer = (id: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const found = Arr.findFirst(state.servers, (x) => x.config.id === id)
      if (Option.isNone(found)) return
      const item = found.value
      const attempt = nextStartAttempt(id)
      stopServerInternal(id)
      if (!isCurrentStartAttempt(id, attempt)) return
      setRuntime(id, { kind: "starting" })
      logger?.log("wsl sidecar starting", { id, distro: item.config.distro })
      yield* fromPromise(() => spawnSidecar(item.config.distro)).pipe(
        Effect.matchEffect({
          onSuccess: (sidecar) => {
            if (!isCurrentStartAttempt(id, attempt)) {
              // ignore stop errors for stale sidecars
              stopQuietly(sidecar)
              return Effect.void
            }
            MutableHashMap.set(sidecars, id, sidecar)
            setRuntime(id, {
              kind: "ready",
              url: sidecar.url,
              username: sidecar.username,
              password: sidecar.password,
            })
            sidecar.listener.onExit((code, signal) => {
              if (!Option.exists(MutableHashMap.get(sidecars, id), (current) => current === sidecar)) return
              MutableHashMap.remove(sidecars, id)
              const message = startupFailure(code, signal)
              setRuntime(id, { kind: "failed", message })
              logger?.error("wsl sidecar exited", { id, distro: item.config.distro, code, signal })
            })
            return Effect.forkDetach(refreshServerOpencodeCheck(id, item.config.distro)).pipe(
              Effect.andThen(
                Effect.sync(() =>
                  logger?.log("wsl sidecar ready", { id, distro: item.config.distro, url: sidecar.url }),
                ),
              ),
            )
          },
          onFailure: (error) =>
            Effect.sync(() => {
              if (!isCurrentStartAttempt(id, attempt)) return
              setRuntime(id, { kind: "failed", message: error.message })
              // Without this, an Ubuntu-style silent failure leaves no trace in
              // main.log — the controller captures the message in its state but
              // nothing surfaces unless the user opens the WSL servers dialog.
              logger?.error("wsl sidecar failed to start", { id, distro: item.config.distro, message: error.message })
            }),
        }),
      )
    })

  const stopServerInternal = (id: string) => {
    const existing = MutableHashMap.get(sidecars, id)
    if (Option.isNone(existing)) return
    MutableHashMap.remove(sidecars, id)
    // ignore stop errors
    stopQuietly(existing.value)
  }

  // An aborted job ends quietly; any other failure rejects the caller's Promise.
  const runJob = (
    makeJob: (startedAt: number) => WslJob,
    runner: (signal: AbortSignal) => Effect.Effect<void, WslJobError>,
  ) =>
    Effect.gen(function* () {
      const abort = beginJob(makeJob(yield* Clock.currentTimeMillis))
      yield* runner(abort.signal).pipe(
        Effect.catchTag("WslJobAborted", () => Effect.void),
        Effect.ensuring(Effect.sync(() => endJob(abort))),
      )
    })

  return {
    getState() {
      return state
    },
    subscribe(listener: (event: WslServersEvent) => void) {
      MutableHashSet.add(listeners, listener)
      return () => {
        MutableHashSet.remove(listeners, listener)
      }
    },

    initialize() {
      return Effect.runPromise(
        Effect.gen(function* () {
          refreshFromStore()
          yield* Effect.forkDetach(refreshOpencodeChecks)
          for (const id of wslServerIdsToStartOnInitialize(state.servers.map((item) => item.config)))
            yield* Effect.forkDetach(startServer(id))
        }),
      )
    },

    probeRuntime() {
      return Effect.runPromise(
        runJob(
          (startedAt) => ({ kind: "runtime", startedAt }),
          (signal) =>
            fromPromise(() => probeWslRuntime({ signal })).pipe(
              Effect.map((runtime) =>
                setState({
                  runtime,
                  pendingRestart: state.pendingRestart && !runtime.available ? state.pendingRestart : false,
                }),
              ),
            ),
        ),
      )
    },

    refreshDistros() {
      return Effect.runPromise(
        runJob(
          (startedAt) => ({ kind: "distros", startedAt }),
          (signal) => refreshDistroLists({ signal }).pipe(Effect.map(setState)),
        ),
      )
    },

    installWsl() {
      return Effect.runPromise(
        runJob(
          (startedAt) => ({ kind: "install-wsl", startedAt }),
          (signal) =>
            Effect.gen(function* () {
              yield* fromPromise(() => installWslRuntimeElevated({ signal })).pipe(
                Effect.flatMap((result) =>
                  requireCommandSuccess(result, () => nativeT("desktop.wsl.error.installWsl")),
                ),
              )
              const runtime = yield* fromPromise(() => probeWslRuntime({ signal }))
              setState({ runtime, pendingRestart: pendingRestartAfterWslInstall(runtime) })
            }),
        ),
      )
    },

    installDistro(name: string) {
      return Effect.runPromise(
        runJob(
          (startedAt) => ({ kind: "install-distro", distro: name, startedAt }),
          (signal) =>
            Effect.gen(function* () {
              yield* fromPromise(() => installWslDistro(name, { signal })).pipe(
                Effect.flatMap((result) =>
                  requireCommandSuccess(result, () => nativeT("desktop.wsl.error.installDistro", { distro: name })),
                ),
              )
              const distros = yield* refreshDistroLists({ signal })
              const probe = yield* fromPromise(() => probeDistro(name, { signal }))
              setState({
                ...distros,
                distroProbes: { ...state.distroProbes, [name]: probe },
              })
            }),
        ),
      )
    },

    probeAddable(distros: string[]) {
      if (!distros.length) return Effect.runPromise(Effect.void)
      return Effect.runPromise(
        runJob(
          (startedAt) => ({ kind: "probe-addable", distros, startedAt }),
          (signal) => probeAddableDistros(distros, { signal }),
        ),
      )
    },

    installOpencode(name: string) {
      return Effect.runPromise(
        runJob(
          (startedAt) => ({ kind: "install-opencode", distro: name, startedAt }),
          (signal) =>
            Effect.gen(function* () {
              yield* fromPromise(() => installWslOpencode(appVersion, name, { signal })).pipe(
                Effect.flatMap((result) =>
                  requireCommandSuccess(result, () => nativeT("desktop.wsl.error.installOpencode")),
                ),
              )
              yield* refreshOpencodeCheck(name, { signal })
              yield* expectOpencodeVersion(Option.fromNullishOr(state.opencodeChecks[name]?.version), appVersion, name)
              const id = wslServerIdToRestart(state.servers, name)
              if (id) yield* startServer(id)
            }),
        ),
      )
    },

    openTerminal(name: string) {
      return Effect.runPromise(fromPromise(() => openWslTerminal(name)).pipe(Effect.asVoid))
    },

    addServer(distro: string): Promise<WslServerConfig> {
      return Effect.runPromise(
        Effect.gen(function* () {
          const id = wslServerIdForDistro(distro)
          if (state.servers.some((item) => item.config.id === id)) {
            return yield* Effect.fail(
              new WslServersError({ message: nativeT("desktop.wsl.error.alreadyAdded", { distro }) }),
            )
          }
          const config: WslServerConfig = {
            id,
            distro,
          }
          persistServers([...readServers(), config])
          setState({
            servers: [...state.servers, { config, runtime: { kind: "starting" } }],
          })
          yield* Effect.forkDetach(startServer(id))
          return config
        }),
      )
    },

    removeServer(id: string) {
      return Effect.runPromise(
        Effect.sync(() => {
          const distro = state.servers.find((item) => item.config.id === id)?.config.distro
          invalidateStartAttempt(id)
          stopServerInternal(id)
          const remaining = readServers().filter((item) => item.id !== id)
          persistServers(remaining)
          setState({
            servers: state.servers.filter((item) => item.config.id !== id),
            ...(distro ? clearWslDistroState(state.distroProbes, state.opencodeChecks, distro) : {}),
          })
        }),
      )
    },

    startServer(id: string) {
      return Effect.runPromise(startServer(id))
    },

    stopAll() {
      for (const item of state.servers) invalidateStartAttempt(item.config.id)
      // ignore stop errors
      MutableHashMap.forEach(sidecars, stopQuietly)
      MutableHashMap.clear(sidecars)
    },
  }
}

function initialState(): WslServersState {
  return {
    // eslint-disable-next-line effect/no-null-use-option -- (a) WslServersState from @opencode-ai/app/wsl/types is the IPC wire type the renderer reads; it types "not probed yet" as null
    runtime: null,
    installed: [],
    online: [],
    distroProbes: {},
    opencodeChecks: {},
    pendingRestart: false,
    servers: [],
    // eslint-disable-next-line effect/no-null-use-option -- (a) WslServersState from @opencode-ai/app/wsl/types is the IPC wire type the renderer reads; it types "no job" as null
    job: null,
  }
}

function readPersistedServers(): WslServerConfig[] {
  const existing = getStore().get(WSL_SERVERS_KEY)
  if (!Predicate.isObject(existing) || !Array.isArray(existing.servers)) return []
  return existing.servers.flatMap(normalizePersistedServer)
}

function writePersistedServers(servers: WslServerConfig[]) {
  getStore().set(WSL_SERVERS_KEY, { servers })
}

function normalizePersistedServer(value: unknown): WslServerConfig[] {
  if (!Predicate.isObject(value) || !isNonEmptyString(value.distro)) return []
  const distro = value.distro
  const id = isNonEmptyString(value.id) ? value.id : wslServerIdForDistro(distro)
  return [
    {
      id,
      distro,
    },
  ]
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function nonEmpty(value: string | null | undefined) {
  return Option.filter(Option.fromNullishOr(value), (text) => text.length > 0)
}

function fromPromise<A>(run: () => Promise<A>) {
  return Effect.tryPromise({ try: run, catch: wslError })
}

function wslError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (cause instanceof Error && cause.name === "AbortError") return new WslJobAborted({ message })
  return new WslServersError({ message, cause })
}

// A failed command reports its output summary, or the fallback when the output is empty.
function requireCommandSuccess(result: WslCommandResult, fallback: () => string) {
  if (result.code === 0) return Effect.void
  return Effect.fail(new WslServersError({ message: summarize(result.stderr || result.stdout) || fallback() }))
}

function stopQuietly(sidecar: RunningSidecar) {
  return Result.try(() => sidecar.listener.stop())
}

// The Option fields convert to null only here, because WslOpencodeCheck is the IPC wire type.
function opencodeCheck(
  distro: string,
  resolvedPath: Option.Option<string>,
  version: Option.Option<string>,
  expectedVersion: string,
): WslOpencodeCheck {
  const ran = Option.isSome(resolvedPath) ? version : Option.none<string>()
  const error = Option.isNone(resolvedPath)
    ? Option.some(nativeT("desktop.wsl.error.opencodeMissing"))
    : Option.isNone(ran)
      ? Option.some(nativeT("desktop.wsl.error.opencodeCannotRun"))
      : Option.none<string>()
  return {
    distro,
    resolvedPath: Option.getOrNull(resolvedPath),
    version: Option.getOrNull(ran),
    expectedVersion,
    matchesDesktop: Option.getOrNull(Option.map(ran, (installed) => installed === expectedVersion)),
    error: Option.getOrNull(error),
  }
}

function distroProbeReady(probe: WslDistroProbe | undefined) {
  return !!probe?.canExecute && probe.hasBash && probe.hasCurl
}

function startupFailure(code: number | null, signal: NodeJS.Signals | null) {
  return nativeT("desktop.wsl.error.serverExited", { code: code ?? "null", signal: signal ?? "null" })
}

// Re-export types used by callers
export type {
  WslInstalledDistro,
  WslOnlineDistro,
  WslRuntimeCheck,
  WslDistroProbe,
  WslOpencodeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
}
