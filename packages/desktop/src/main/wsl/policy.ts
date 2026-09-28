import { Array as Arr, Data, Result } from "effect"
import type { WslDistroProbe, WslOpencodeCheck, WslServerItem } from "../../preload/types"

export class WslIpcArgumentError extends Data.TaggedError("WslIpcArgumentError")<{ readonly message: string }> {}

export function wslServerIdToRestart(servers: WslServerItem[], distro: string) {
  return servers.find((item) => item.config.distro === distro)?.config.id
}

export function clearWslDistroState(
  distroProbes: Record<string, WslDistroProbe>,
  opencodeChecks: Record<string, WslOpencodeCheck>,
  distro: string,
) {
  const nextDistroProbes = { ...distroProbes }
  const nextOpencodeChecks = { ...opencodeChecks }
  delete nextDistroProbes[distro]
  delete nextOpencodeChecks[distro]
  return { distroProbes: nextDistroProbes, opencodeChecks: nextOpencodeChecks }
}

export function wslTerminalArgs(distro?: string | null) {
  return ["/c", "start", "", "wsl", ...(distro ? ["-d", distro] : [])]
}

export function wslIpcString(name: string, value: unknown): Result.Result<string, WslIpcArgumentError> {
  if (typeof value === "string" && value.length > 0) return Result.succeed(value)
  return Result.fail(invalidWslIpcArgument(name))
}

export function wslIpcStrings(name: string, value: unknown): Result.Result<string[], WslIpcArgumentError> {
  if (!Array.isArray(value)) return Result.fail(invalidWslIpcArgument(name))
  return Result.flatMap(Result.all(value.map((item) => wslIpcString(name, item))), (values) =>
    Arr.isArrayNonEmpty(values) ? Result.succeed(values) : Result.fail(invalidWslIpcArgument(name)),
  )
}

// ipcMain.handle callers rely on these validators throwing synchronously; the
// thrown WslIpcArgumentError rejects the invoke with the same message.
export function requireWslIpcString(name: string, value: unknown) {
  return Result.getOrThrow(wslIpcString(name, value))
}

export function requireWslIpcStrings(name: string, value: unknown) {
  return Result.getOrThrow(wslIpcStrings(name, value))
}

function invalidWslIpcArgument(name: string) {
  return new WslIpcArgumentError({ message: `Invalid ${name}` })
}
