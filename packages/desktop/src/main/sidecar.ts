import * as http from "node:http"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import { Array as Arr, Config, ConfigProvider, Data, Effect, Option, Predicate, Schema } from "effect"

const StartCommand = Schema.Struct({
  type: Schema.Literal("start"),
  hostname: Schema.String,
  port: Schema.Number,
  password: Schema.String,
  userDataPath: Schema.String,
}).annotate({ identifier: "SidecarStartCommand" })
type StartCommand = typeof StartCommand.Type

// Decoding drops unknown keys, so a command carries only these fields.
const decodeCommand = Schema.decodeUnknownOption(
  Schema.Union([StartCommand, Schema.Struct({ type: Schema.Literal("stop") })]).annotate({
    identifier: "SidecarCommand",
  }),
)

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
}

class SidecarStepError extends Data.TaggedError("SidecarStepError")<{ readonly cause: unknown }> {}

let listener = Option.none<Listener>()

const main = Effect.gen(function* () {
  const parentPort = yield* getParentPort
  parentPort.on("message", (event) => {
    const command = decodeCommand(event.data)
    if (Option.isNone(command)) return
    Effect.runFork(command.value.type === "stop" ? stop(parentPort) : start(parentPort, command.value))
  })
}).pipe(
  // A missing parent port means this file ran outside an Electron utility process. Nothing
  // else keeps the process alive, so it ends with exit code 1.
  Effect.catchCause((cause) =>
    Effect.logError("sidecar failed to start", cause).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1
        }),
      ),
    ),
  ),
)

function start(parentPort: ParentPort, command: StartCommand) {
  return Effect.gen(function* () {
    yield* prepareSidecarEnv(command.password, command.userDataPath)
    yield* ensureLoopbackNoProxy
    yield* useSystemCertificates
    yield* useEnvProxy
    const { Server } = yield* Effect.tryPromise({
      try: () => import("virtual:opencode-server"),
      catch: (cause) => new SidecarStepError({ cause }),
    })

    listener = Option.some(
      yield* Effect.tryPromise({
        try: (): Promise<Listener> =>
          Server.listen({
            port: command.port,
            hostname: command.hostname,
            username: "opencode",
            password: command.password,
            cors: ["oc://renderer"],
          }),
        catch: (cause) => new SidecarStepError({ cause }),
      }),
    )
    parentPort.postMessage({ type: "ready" })
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        parentPort.postMessage({ type: "error", error: serializeError(error.cause) })
        setImmediate(() => process.exit(1))
      }),
    ),
  )
}

function stop(parentPort: ParentPort) {
  return Effect.suspend(() =>
    Option.match(listener, {
      onNone: () => Effect.void,
      onSome: (current) =>
        Effect.try({ try: () => current.stop(), catch: (cause) => new SidecarStepError({ cause }) }).pipe(
          Effect.flatMap((result) =>
            Predicate.isPromiseLike(result)
              ? Effect.tryPromise({ try: () => result, catch: (cause) => new SidecarStepError({ cause }) })
              : Effect.void,
          ),
        ),
    }),
  ).pipe(
    Effect.catch((error) => Effect.logError("failed to stop sidecar listener", error.cause)),
    Effect.ensuring(
      Effect.sync(() => {
        listener = Option.none()
        parentPort.postMessage({ type: "stopped" })
        setImmediate(() => process.exit(0))
      }),
    ),
  )
}

// Reads one variable from the live process.env. The default ConfigProvider keeps a
// copy, but this process writes process.env before the later reads. Empty strings
// stay values, as the old ?? fallback kept them.
function readEnv(name: string) {
  return Config.option(Config.String(name))
    .parse(ConfigProvider.fromEnvRecord(process.env, { preserveEmptyStrings: true }))
    .pipe(Effect.orDie)
}

function prepareSidecarEnv(password: string, userDataPath: string) {
  return readEnv("XDG_STATE_HOME").pipe(
    Effect.map((stateHome) => {
      Object.assign(process.env, {
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_SERVER_PASSWORD: password,
        XDG_STATE_HOME: Option.getOrElse(stateHome, () => userDataPath),
      })
    }),
  )
}

// NO_PROXY and no_proxy run in order: on Windows they name one variable, and the
// second pass must read the value that the first pass wrote.
const ensureLoopbackNoProxy = Effect.forEach(
  ["NO_PROXY", "no_proxy"],
  (key) =>
    readEnv(key).pipe(
      Effect.map((value) => {
        const loopback = ["127.0.0.1", "localhost", "::1"]
        const items = Option.getOrElse(value, () => "")
          .split(",")
          .map((value: string) => value.trim())
          .filter((value: string) => Boolean(value))
        const missing = loopback.filter((host) => !items.some((value: string) => value.toLowerCase() === host))

        Object.assign(process.env, { [key]: [...items, ...missing].join(",") })
      }),
    ),
  { discard: true },
)

const useSystemCertificates = Effect.try({
  try: () => setDefaultCACertificates(Arr.dedupe([...getCACertificates("default"), ...getCACertificates("system")])),
  catch: (cause) => new SidecarStepError({ cause }),
}).pipe(Effect.catch((error) => Effect.logWarning("failed to load system certificates", error.cause)))

// Electron 41.2 runs Node 24.14.1, which has http.setGlobalProxyFromEnv; latest @types/node@24
// is 24.12.2 and does not declare it.
const hasEnvProxy = (module: typeof http): module is typeof http & { setGlobalProxyFromEnv: () => void } =>
  "setGlobalProxyFromEnv" in module && typeof module.setGlobalProxyFromEnv === "function"

const useEnvProxy = Effect.suspend(() => {
  // A namespace import does not narrow, so the guard checks a local binding.
  const module = http
  return hasEnvProxy(module)
    ? Effect.try({ try: () => module.setGlobalProxyFromEnv(), catch: (cause) => new SidecarStepError({ cause }) })
    : Effect.fail(new SidecarStepError({ cause: "http.setGlobalProxyFromEnv is not available" }))
}).pipe(Effect.catch((error) => Effect.logWarning("failed to load proxy environment", error.cause)))

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

// Electron types parentPort as always present, but it exists only in a utility process.
const getParentPort = Effect.suspend(() => {
  const port: ParentPort | undefined = process.parentPort
  return port ? Effect.succeed(port) : Effect.die(new Error("Sidecar parent port unavailable"))
})

// Runs last so every module-level Effect above is initialised.
Effect.runFork(main)
