import path from "path"
import { type ParseError as JsoncParseError, applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { unique } from "remeda"
import { Effect, Option, Schema } from "effect"
import { TuiConfig } from "@opencode-ai/tui/config"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as ConfigPaths from "@/config/paths"

const TUI_SCHEMA_URL = "https://opencode.ai/tui.json"

const decodeTheme = Schema.decodeUnknownOption(Schema.String)
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeScrollSpeed = Schema.decodeUnknownOption(TuiConfig.ScrollSpeed)
const decodeScrollAcceleration = Schema.decodeUnknownOption(TuiConfig.ScrollAcceleration)
const decodeDiffStyle = Schema.decodeUnknownOption(TuiConfig.DiffStyle)

interface MigrateInput {
  cwd: string
  directories: string[]
  // The OPENCODE_CONFIG file, when the flag is set.
  customConfig: Option.Option<string>
}

/**
 * Migrates tui-specific keys (theme, keybinds, tui) from opencode.json files
 * into dedicated tui.json files. Migration is performed per-directory and
 * skips only locations where a tui.json already exists.
 */
export const migrateTuiConfig = Effect.fn("TuiConfig.migrate")(function* (input: MigrateInput) {
  const fs = yield* FSUtil.Service
  const opencode = yield* opencodeFiles(input)
  for (const file of opencode) {
    // A file that does not read, or is empty, is skipped.
    const read = yield* fs.readFileString(file).pipe(Effect.option)
    if (Option.isNone(read) || !read.value) continue
    const source = read.value
    const errors: JsoncParseError[] = []
    const data = parseJsonc(source, errors, { allowTrailingComma: true })
    if (errors.length || !data || typeof data !== "object" || Array.isArray(data)) continue

    const theme = decodeTheme("theme" in data ? data.theme : undefined)
    const keybinds = decodeRecord("keybinds" in data ? data.keybinds : undefined)
    const legacyTui = decodeRecord("tui" in data ? data.tui : undefined)
    const extracted = {
      theme: Option.getOrUndefined(theme),
      keybinds: Option.getOrUndefined(keybinds),
      tui: Option.getOrUndefined(legacyTui),
    }
    const tui = extracted.tui ? normalizeTui(extracted.tui) : undefined
    if (extracted.theme === undefined && extracted.keybinds === undefined && !tui) continue

    const target = path.join(path.dirname(file), "tui.json")
    if (yield* fs.existsSafe(target)) continue

    const payload: Record<string, unknown> = {
      $schema: TUI_SCHEMA_URL,
    }
    if (extracted.theme !== undefined) payload.theme = extracted.theme
    if (extracted.keybinds !== undefined) payload.keybinds = extracted.keybinds
    if (tui) Object.assign(payload, tui)

    const wrote = yield* fs.writeWithDirs(target, JSON.stringify(payload, null, 2)).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    if (!wrote) continue

    yield* backupAndStripLegacy(file, source)
  }
})

function normalizeTui(data: Record<string, unknown>):
  | {
      scroll_speed: number | undefined
      scroll_acceleration: { enabled: boolean } | undefined
      diff_style: "auto" | "stacked" | undefined
    }
  | undefined {
  const parsed = {
    scroll_speed: Option.getOrUndefined(decodeScrollSpeed(data.scroll_speed)),
    scroll_acceleration: Option.getOrUndefined(decodeScrollAcceleration(data.scroll_acceleration)),
    diff_style: Option.getOrUndefined(decodeDiffStyle(data.diff_style)),
  }
  return parsed.scroll_speed === undefined &&
    parsed.diff_style === undefined &&
    parsed.scroll_acceleration === undefined
    ? undefined
    : parsed
}

const backupAndStripLegacy = Effect.fnUntraced(function* (file: string, source: string) {
  const fs = yield* FSUtil.Service
  const backup = file + ".tui-migration.bak"
  const backed =
    (yield* fs.existsSafe(backup)) ||
    (yield* fs.writeWithDirs(backup, source).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ))
  if (!backed) return false

  const text = ["theme", "keybinds", "tui"].reduce((acc, key) => {
    const edits = modify(acc, [key], undefined, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    if (!edits.length) return acc
    return applyEdits(acc, edits)
  }, source)

  return yield* fs.writeWithDirs(file, text).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )
})

const opencodeFiles = Effect.fnUntraced(function* (input: MigrateInput) {
  const fs = yield* FSUtil.Service
  // The project files, root first, as Filesystem.findUp with rootFirst listed them.
  const projectFiles = ancestors(input.cwd)
    .toReversed()
    .flatMap((dir) => ["opencode.json", "opencode.jsonc"].map((name) => path.join(dir, name)))
  const candidates = unique([
    ...ConfigPaths.fileInDirectory(Global.Path.config, "opencode"),
    ...projectFiles,
    ...unique(input.directories).flatMap((dir) => ConfigPaths.fileInDirectory(dir, "opencode")),
    ...Option.toArray(input.customConfig),
  ])
  return yield* Effect.filter(candidates, (file) => fs.existsSafe(file), { concurrency: "unbounded" })
})

/** The directory and each of its parents, closest first. */
function ancestors(dir: string): string[] {
  const parent = path.dirname(dir)
  return parent === dir ? [dir] : [dir, ...ancestors(parent)]
}
