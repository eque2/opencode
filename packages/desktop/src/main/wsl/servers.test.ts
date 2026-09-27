import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, MutableHashMap, Option } from "effect"
import {
  clearWslDistroState,
  requireWslIpcString,
  requireWslIpcStrings,
  wslServerIdToRestart,
  wslTerminalArgs,
} from "./policy"
import {
  expectOpencodeVersion,
  pendingRestartAfterWslInstall,
  pollWslHealth,
  wslServerIdsToStartOnInitialize,
} from "./startup"
import { createWslServersController, type WslServerConfig } from "./servers"

let persistedServers: WslServerConfig[] = []
let releaseOpencodeResolve = Option.none<Deferred.Deferred<void>>()

test("starts every configured WSL server on initialization", () => {
  expect(
    wslServerIdsToStartOnInitialize([
      { id: "wsl:Debian", distro: "Debian" },
      { id: "wsl:Ubuntu-24.04", distro: "Ubuntu-24.04" },
    ]),
  ).toEqual(["wsl:Debian", "wsl:Ubuntu-24.04"])
})

test("rejects an update that did not install the desktop version", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(Exit.isSuccess(yield* Effect.exit(expectOpencodeVersion(Option.some("1.16.2"), "1.16.2")))).toBe(true)
      const error = yield* Effect.flip(expectOpencodeVersion(Option.some("1.14.35"), "1.16.2"))
      expect(error.message).toBe("OpenCode update finished but Debian still reports 1.14.35; expected 1.16.2")
    }),
  ))

test("restarts an existing distro server after updating OpenCode", () => {
  expect(
    wslServerIdToRestart(
      [
        {
          config: { id: "wsl:Debian", distro: "Debian" },
          // eslint-disable-next-line effect/no-null-use-option -- (a) WslServerRuntime from @opencode-ai/app/wsl/types is the IPC wire type; it types "no credentials" as null
          runtime: { kind: "ready", url: "", username: null, password: null },
        },
      ],
      "Debian",
    ),
  ).toBe("wsl:Debian")
  expect(wslServerIdToRestart([], "Debian")).toBeUndefined()
})

test("clears cached distro probes when removing a WSL server", () => {
  expect(
    clearWslDistroState(
      // eslint-disable-next-line effect/no-null-use-option -- (a) WslDistroProbe from @opencode-ai/app/wsl/types is the IPC wire type; it types "no error" as null
      { Debian: { name: "Debian", canExecute: true, hasBash: true, hasCurl: true, error: null } },
      {
        Debian: {
          distro: "Debian",
          resolvedPath: "/home/luke/.opencode/bin/opencode",
          version: "1.16.2",
          expectedVersion: "1.16.2",
          matchesDesktop: true,
          // eslint-disable-next-line effect/no-null-use-option -- (a) WslOpencodeCheck from @opencode-ai/app/wsl/types is the IPC wire type; it types "no error" as null
          error: null,
        },
      },
      "Debian",
    ),
  ).toEqual({ distroProbes: {}, opencodeChecks: {} })
})

test("opens terminals for distro names containing spaces", () => {
  expect(wslTerminalArgs("Ubuntu Preview")).toEqual(["/c", "start", "", "wsl", "-d", "Ubuntu Preview"])
})

test("stops health polling when sidecar startup settles", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const abort = new AbortController()
      let checks = 0
      const polling = pollWslHealth(
        () =>
          Effect.runPromise(
            Effect.sync(() => {
              checks++
              return false
            }),
          ),
        abort.signal,
        1,
      )

      yield* Effect.sleep("5 millis")
      abort.abort()
      yield* Effect.promise(() => polling)
      const settled = checks
      yield* Effect.sleep("5 millis")
      expect(checks).toBe(settled)
    }),
  ))

test("validates WSL IPC identifiers at the module boundary", () => {
  expect(requireWslIpcString("distro", "Debian")).toBe("Debian")
  expect(requireWslIpcStrings("distro", ["Debian", "Ubuntu"])).toEqual(["Debian", "Ubuntu"])
  expect(() => requireWslIpcString("distro", "")).toThrow("Invalid distro")
  // eslint-disable-next-line effect/no-undefined-use-option -- (b) the test feeds the JavaScript undefined value that a missing IPC argument arrives as
  expect(() => requireWslIpcString("server id", undefined)).toThrow("Invalid server id")
  expect(() => requireWslIpcStrings("distro", [])).toThrow("Invalid distro")
})

test("derives a required Windows restart from the post-install runtime probe", () => {
  // eslint-disable-next-line effect/no-null-use-option -- (a) WslRuntimeCheck from @opencode-ai/app/wsl/types is the IPC wire type; it types "no version" as null
  expect(pendingRestartAfterWslInstall({ available: false, version: null, error: "WSL unavailable" })).toBe(true)
  // eslint-disable-next-line effect/no-null-use-option -- (a) WslRuntimeCheck from @opencode-ai/app/wsl/types is the IPC wire type; it types "no error" as null
  expect(pendingRestartAfterWslInstall({ available: true, version: "WSL version: 2.6.1", error: null })).toBe(false)
})

test("ignores stale background OpenCode checks after removing a WSL server", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      persistedServers = []
      releaseOpencodeResolve = Option.none()
      const controller = createWslServersController(
        "1.16.2",
        () =>
          Effect.runPromise(
            Effect.succeed({
              listener: {
                stop: () => {},
                onExit: () => {},
              },
              url: "http://127.0.0.1:4096",
              username: "opencode",
              password: "secret",
            }),
          ),
        testControllerOptions(),
      )

      yield* Effect.promise(() => controller.addServer("Debian"))
      yield* waitFor(() => Option.isSome(releaseOpencodeResolve))
      yield* Effect.promise(() => controller.removeServer("wsl:Debian"))
      yield* releaseOpencode()
      yield* Effect.sleep("0 millis")

      expect(controller.getState().servers).toEqual([])
      expect(controller.getState().opencodeChecks).toEqual({})
    }),
  ))

test("ignores stale startup OpenCode checks after removing a WSL server", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      persistedServers = [{ id: "wsl:Debian", distro: "Debian" }]
      releaseOpencodeResolve = Option.none()
      const controller = createWslServersController("1.16.2", neverSpawn, testControllerOptions())

      yield* Effect.promise(() => controller.initialize())
      yield* waitFor(() => Option.isSome(releaseOpencodeResolve))
      yield* Effect.promise(() => controller.removeServer("wsl:Debian"))
      yield* releaseOpencode()
      yield* Effect.sleep("0 millis")

      expect(controller.getState().servers).toEqual([])
      expect(controller.getState().opencodeChecks).toEqual({})
    }),
  ))

test("probes addable distros in parallel before checking OpenCode", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      persistedServers = []
      const started: string[] = []
      const release = MutableHashMap.empty<string, Deferred.Deferred<void>>()
      const opencode: string[] = []
      const controller = createWslServersController("1.16.2", neverSpawn, {
        ...testControllerOptions(),
        probeDistro: (distro) =>
          Effect.runPromise(
            Effect.gen(function* () {
              started.push(distro)
              const gate = yield* Deferred.make<void>()
              MutableHashMap.set(release, distro, gate)
              yield* Deferred.await(gate)
              // eslint-disable-next-line effect/no-null-use-option -- (a) WslDistroProbe from @opencode-ai/app/wsl/types is the IPC wire type; it types "no error" as null
              return { name: distro, canExecute: true, hasBash: true, hasCurl: true, error: null }
            }),
          ),
        resolveOpencode: (distro) =>
          Effect.runPromise(
            Effect.sync(() => {
              opencode.push(distro)
              return "/home/me/.opencode/bin/opencode"
            }),
          ),
      })

      const task = controller.probeAddable(["Debian", "Ubuntu"])
      yield* waitFor(() => started.length === 2)
      expect(started).toEqual(["Debian", "Ubuntu"])
      expect(opencode).toEqual([])
      yield* releaseGate(MutableHashMap.get(release, "Debian"))
      yield* releaseGate(MutableHashMap.get(release, "Ubuntu"))
      yield* Effect.promise(() => task)

      expect(Object.keys(controller.getState().distroProbes)).toEqual(["Debian", "Ubuntu"])
      expect(opencode).toEqual(["Debian", "Ubuntu"])
      expect(Object.keys(controller.getState().opencodeChecks)).toEqual(["Debian", "Ubuntu"])
    }),
  ))

test("does not check OpenCode in addable distros that cannot execute commands", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      persistedServers = []
      const opencode: string[] = []
      const controller = createWslServersController("1.16.2", neverSpawn, {
        ...testControllerOptions(),
        probeDistro: (distro) =>
          Effect.runPromise(
            Effect.succeed({
              name: distro,
              canExecute: distro === "Debian",
              hasBash: distro === "Debian",
              hasCurl: distro === "Debian",
              // eslint-disable-next-line effect/no-null-use-option -- (a) WslDistroProbe from @opencode-ai/app/wsl/types is the IPC wire type; it types "no error" as null
              error: distro === "Debian" ? null : "Open Ubuntu once to finish setup",
            }),
          ),
        resolveOpencode: (distro) =>
          Effect.runPromise(
            Effect.sync(() => {
              opencode.push(distro)
              return "/home/me/.opencode/bin/opencode"
            }),
          ),
      })

      yield* Effect.promise(() => controller.probeAddable(["Debian", "Ubuntu"]))

      expect(Object.keys(controller.getState().distroProbes)).toEqual(["Debian", "Ubuntu"])
      expect(opencode).toEqual(["Debian"])
      expect(Object.keys(controller.getState().opencodeChecks)).toEqual(["Debian"])
    }),
  ))

function waitFor(check: () => boolean, attempts = 20): Effect.Effect<void> {
  if (attempts === 0) return Effect.die(new Error("Timed out waiting for condition"))
  if (check()) return Effect.void
  return Effect.sleep("0 millis").pipe(Effect.flatMap(() => waitFor(check, attempts - 1)))
}

function releaseGate(gate: Option.Option<Deferred.Deferred<void>>) {
  return Option.match(gate, {
    onNone: () => Effect.void,
    onSome: (deferred) => Deferred.done(deferred, Exit.void).pipe(Effect.asVoid),
  })
}

function releaseOpencode() {
  return releaseGate(releaseOpencodeResolve)
}

function neverSpawn() {
  return Effect.runPromise(Effect.never)
}

function testControllerOptions() {
  return {
    readServers: () => persistedServers,
    writeServers: (servers: WslServerConfig[]) => {
      persistedServers = servers
    },
    readCommandVersion: () => Effect.runPromise(Effect.succeed("1.16.2")),
    resolveOpencode: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          releaseOpencodeResolve = Option.some(gate)
          yield* Deferred.await(gate)
          return "/home/me/.opencode/bin/opencode"
        }),
      ),
  }
}
