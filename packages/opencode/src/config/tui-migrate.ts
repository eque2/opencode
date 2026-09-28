import path from "path"
import { type ParseError as JsoncParseError, applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { unique } from "remeda"
import { Effect, Option, Schema } from "effect"
import { TuiConfig } from "@opencode-ai/tui/config"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as ConfigPaths from "@/config/paths"
import { isRecord } from "@/util/record"

const TUI_SCHEMA_URL = "https://opencode.ai/tui.json"

// The migrated tui.json is written as JSON.stringify(payload, null, 2) wrote it.
const TuiJsonFile = Schema.fromJsonString(Schema.Unknown, { space: 2 })
const decodeTheme = Schema.decodeUnknownOption(Schema.String)
// A plain object (not an array) is the only keybinds or tui shape worth moving.
const decodeRecord = Option.liftPredicate(isRecord)
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
    if (errors.length || !isRecord(data)) continue

    const theme = decodeTheme(data.theme)
    const keybinds = decodeRecord(data.keybinds)
    const tui = Option.flatMap(decodeRecord(data.tui), normalizeTui)
    if (Option.isNone(theme) && Option.isNone(keybinds) && Option.isNone(tui)) continue

    const target = path.join(path.dirname(file), "tui.json")
    if (yield* fs.existsSafe(target)) continue

    const payload = {
      $schema: TUI_SCHEMA_URL,
      ...field("theme", theme),
      ...field("keybinds", keybinds),
      ...Option.getOrElse(tui, () => ({})),
    }

    const text = yield* Schema.encodeEffect(TuiJsonFile)(payload).pipe(Effect.orDie)
    const wrote = yield* fs.writeWithDirs(target, text).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    if (!wrote) continue

    yield* backupAndStripLegacy(file, source)
  }
})

// The recognized legacy tui settings, or None when none of them decodes.
function normalizeTui(data: Record<string, unknown>): Option.Option<Record<string, unknown>> {
  const fields = {
    ...field("scroll_speed", decodeScrollSpeed(data.scroll_speed)),
    ...field("scroll_acceleration", decodeScrollAcceleration(data.scroll_acceleration)),
    ...field("diff_style", decodeDiffStyle(data.diff_style)),
  }
  return Object.keys(fields).length ? Option.some(fields) : Option.none()
}

// A one-key object for a present value, else an empty object, for use in an object spread.
function field<A>(key: string, value: Option.Option<A>): Record<string, A> {
  return Option.match(value, { onNone: () => ({}), onSome: (present) => ({ [key]: present }) })
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
    // eslint-disable-next-line effect/no-undefined-use-option -- (a) external boundary: jsonc-parser modify() removes a key only when given the JavaScript undefined value
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
