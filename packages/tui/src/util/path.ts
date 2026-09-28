import { Effect, FileSystem } from "effect"
import { win32 } from "node:path"

// On Windows, diagnostics are keyed by the real path of the file. A path that does not resolve keeps its
// normalized form.
export function normalizePath(input: string, platform: string): Effect.Effect<string, never, FileSystem.FileSystem> {
  if (platform !== "win32") return Effect.succeed(input)
  const resolved = win32.normalize(win32.resolve(input.replaceAll("/", "\\")))
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.realPath(resolved)
  }).pipe(Effect.orElseSucceed(() => resolved))
}
