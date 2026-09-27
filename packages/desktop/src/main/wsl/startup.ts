import { Effect } from "effect"
import { nativeT } from "../native-translations"

export function wslServerIdsToStartOnInitialize(servers: { id: string }[]) {
  return servers.map((server) => server.id)
}

export function expectOpencodeVersion(installed: string | null, expected: string, distro = "Debian") {
  if (installed === expected) return
  throw new Error(
    nativeT("desktop.wsl.error.updateVersion", {
      distro,
      installed: installed ?? nativeT("desktop.wsl.error.noVersion"),
      expected,
    }),
  )
}

export const pendingRestartAfterWslInstall = (runtime: { available: boolean }) => !runtime.available

export function pollWslHealth(check: () => Promise<boolean>, signal: AbortSignal, interval = 100): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      while (!signal.aborted) {
        if (yield* Effect.promise(check)) return
        yield* Effect.raceFirst(Effect.sleep(interval), aborted(signal))
      }
    }),
  )
}

function aborted(signal: AbortSignal) {
  return Effect.callback<void>((resume) => {
    const done = () => resume(Effect.void)
    signal.addEventListener("abort", done, { once: true })
    if (signal.aborted) done()
    return Effect.sync(() => signal.removeEventListener("abort", done))
  })
}
