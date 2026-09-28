import Store from "electron-store"
import electron from "electron"
import { join } from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem, MutableHashMap, Option } from "effect"

import { SETTINGS_STORE } from "./store-keys"
import { deleteEmptyStoreFile } from "./store-cleanup"

const cache = MutableHashMap.empty<string, Store>()

// We cannot instantiate the electron-store at module load time because
// module import hoisting causes this to run before app.setPath("userData", ...)
// in index.ts has executed, which would result in files being written to the default directory
// (e.g. bad: %APPDATA%\@opencode-ai\desktop\opencode.settings vs good: %APPDATA%\ai.opencode.desktop.dev\opencode.settings).
export function getStore(name = SETTINGS_STORE) {
  const cached = MutableHashMap.get(cache, name)
  if (Option.isSome(cached)) return cached.value
  const next = new Store({
    name,
    cwd: electron.app.getPath("userData"),
    fileExtension: "",
    accessPropertiesByDotNotation: false,
  })
  MutableHashMap.set(cache, name, next)
  return next
}

export function removeStoreFileIfEmpty(name: string) {
  return Effect.runPromise(
    deleteEmptyStoreFile(electron.app.getPath("userData"), name).pipe(
      Effect.tap((deleted) =>
        Effect.sync(() => {
          if (deleted) MutableHashMap.remove(cache, name)
        }),
      ),
      Effect.asVoid,
      Effect.provide(NodeFileSystem.layer),
    ),
  )
}

export const removeStoreFile = Effect.fnUntraced(function* (name: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(join(electron.app.getPath("userData"), name), { force: true })
  MutableHashMap.remove(cache, name)
})
