import { app } from "electron"
import log from "electron-log/main.js"
import { homedir } from "node:os"
import { join } from "node:path"
import { Config, Data, Effect, FileSystem, Option, Schema } from "effect"
import { CHANNEL } from "./constants"
import { getStore } from "./store"

const TAURI_MIGRATED_KEY = "tauriMigrated"

class TauriMigrationError extends Data.TaggedError("TauriMigrationError")<{ readonly cause: unknown }> {}

const decodeTauriData = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))

// Resolve the directory where Tauri stored its .dat files for the given app identifier.
// Mirrors Tauri's AppLocalData / AppData resolution per OS.
const tauriDir = Effect.fnUntraced(function* (id: string) {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", id)
    case "win32":
      return join(yield* Config.String("APPDATA").pipe(Config.withDefault(join(homedir(), "AppData", "Roaming"))), id)
    default:
      return join(
        yield* Config.String("XDG_DATA_HOME").pipe(Config.withDefault(join(homedir(), ".local", "share"))),
        id,
      )
  }
})

// The Tauri app identifier changes between dev/beta/prod builds.
const TAURI_APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}
function tauriAppId() {
  return app.isPackaged ? TAURI_APP_IDS[CHANNEL] : "ai.opencode.desktop.dev"
}

// Migrate a single Tauri .dat file into the corresponding electron-store.
// `opencode.settings.dat` is special: it maps to the `opencode.settings` store
// (the electron-store name without the `.dat` extension). All other .dat files
// keep their full filename as the electron-store name so they match what the
// renderer already passes via IPC (e.g. `"default.dat"`, `"opencode.global.dat"`).
const migrateFile = Effect.fnUntraced(function* (datPath: string, filename: string) {
  const fs = yield* FileSystem.FileSystem
  // The log keeps the Node.js error, which PlatformError keeps as its cause.
  const parsed = yield* fs.readFileString(datPath, "utf-8").pipe(
    Effect.mapError((error) => new TauriMigrationError({ cause: error.cause ?? error })),
    Effect.flatMap(decodeTauriData),
    Effect.map(Option.some),
    Effect.catch((error) =>
      Effect.sync(() => {
        log.warn(
          "tauri migration: failed to parse",
          filename,
          error._tag === "TauriMigrationError" ? error.cause : error,
        )
      }).pipe(Effect.as(Option.none())),
    ),
  )
  if (Option.isNone(parsed)) return

  // opencode.settings.dat → the electron settings store ("opencode.settings").
  // All other .dat files keep their full filename as the store name so they match
  // what the renderer passes via IPC (e.g. "default.dat", "opencode.global.dat").
  const storeName = filename === "opencode.settings.dat" ? "opencode.settings" : filename
  const target = getStore(storeName)
  const entries = Object.entries(parsed.value)
  // Don't overwrite values the user has already set in the Electron app.
  const skipped = entries.filter(([key]) => target.has(key)).map(([key]) => key)
  const pending = entries.filter(([key]) => !target.has(key))
  pending.forEach(([key, value]) => target.set(key, value))
  const migrated = pending.map(([key]) => key)

  log.log("tauri migration: migrated", filename, "→", storeName, { migrated, skipped })
})

export const runTauriMigration = Effect.fnUntraced(function* () {
  if (getStore().get(TAURI_MIGRATED_KEY)) {
    log.log("tauri migration: already done, skipping")
    return
  }

  const dir = yield* tauriDir(tauriAppId())
  log.log("tauri migration: starting", { dir })

  const fs = yield* FileSystem.FileSystem
  // existsSync reported an unreadable path as absent, so an error also counts as absent.
  if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) {
    log.log("tauri migration: no tauri data directory found, nothing to migrate")
    getStore().set(TAURI_MIGRATED_KEY, true)
    return
  }

  const files = yield* fs
    .readDirectory(dir)
    .pipe(Effect.mapError((error) => new TauriMigrationError({ cause: error.cause ?? error })))
  yield* Effect.forEach(
    files.filter((filename) => filename.endsWith(".dat")),
    (filename) => migrateFile(join(dir, filename), filename),
    { discard: true },
  )

  log.log("tauri migration: complete")
  getStore().set(TAURI_MIGRATED_KEY, true)
})
