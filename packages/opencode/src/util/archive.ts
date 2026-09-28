import path from "path"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"

// The platform command that extracts a zip archive into a directory.
const unzipCommand = (zipPath: string, destDir: string) => {
  if (process.platform !== "win32")
    return ChildProcess.make("unzip", ["-o", "-q", zipPath, "-d", destDir], { stdin: "ignore" })
  const winZipPath = path.resolve(zipPath)
  const winDestDir = path.resolve(destDir)
  // $global:ProgressPreference suppresses PowerShell's blue progress bar popup
  const cmd = `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -Path '${winZipPath}' -DestinationPath '${winDestDir}' -Force`
  return ChildProcess.make("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { stdin: "ignore" })
}

/** Extracts a zip archive into a directory. A command that cannot start or exits non-zero fails. */
export const extractZip = Effect.fn("Archive.extractZip")(function* (zipPath: string, destDir: string) {
  const appProcess = yield* AppProcess.Service
  yield* appProcess.run(unzipCommand(zipPath, destDir)).pipe(Effect.flatMap(AppProcess.requireSuccess))
})

export * as Archive from "./archive"
