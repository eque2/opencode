import path from "path"
import {
  type ParseError as JsoncParseError,
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
} from "jsonc-parser"

import { Array as Arr, Effect, Option, Result, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as ConfigPaths from "@/config/paths"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { Flock } from "@opencode-ai/core/util/flock"
import { isRecord } from "@/util/record"

import {
  packageThemes,
  parsePluginSpecifier,
  readPluginPackage,
  resolvePluginTarget,
  type PluginPackage,
} from "./shared"

type Mode = "noop" | "add" | "replace"
type Kind = "server" | "tui"

export type Target = {
  kind: Kind
  opts?: Record<string, unknown>
}

export type InstallDeps = {
  resolve: (spec: string) => Promise<string>
}

export type PatchDeps = {
  readText: (file: string) => Promise<string>
  write: (file: string, text: string) => Promise<void>
  exists: (file: string) => Promise<boolean>
  files: (dir: string, name: "opencode" | "tui") => string[]
}

export type PatchInput = {
  spec: string
  targets: Target[]
  force?: boolean
  global?: boolean
  vcs?: string
  worktree: string
  directory: string
  config?: string
}

type Ok<T> = {
  ok: true
} & T

type Err<C extends string, T> = {
  ok: false
  code: C
} & T

export type InstallResult = Ok<{ target: string }> | Err<"install_failed", { error: unknown }>

export type ManifestResult =
  | Ok<{ targets: Target[] }>
  | Err<"manifest_read_failed", { file: string; error: unknown }>
  | Err<"manifest_no_targets", { file: string }>

export type PatchItem = {
  kind: Kind
  mode: Mode
  file: string
}

type PatchErr =
  | Err<"invalid_json", { kind: Kind; file: string; line: number; col: number; parse: string }>
  | Err<"patch_failed", { kind: Kind; error: unknown }>

type PatchOne = Ok<{ item: PatchItem }> | PatchErr

export type PatchResult = Ok<{ dir: string; items: PatchItem[] }> | (PatchErr & { dir: string })

// A dependency callback rejected. The cause is the original rejection value.
class DependencyError extends Schema.TaggedError<DependencyError>()("PluginInstallDependencyError", {
  cause: Schema.Defect(),
}) {}

// The dependency callbacks are a Promise-based public contract that the CLI and tests implement.
function call<A>(fn: () => Promise<A>) {
  return Effect.tryPromise({ try: fn, catch: (cause) => new DependencyError({ cause }) })
}

const fileSystemLayer = LayerNode.compile(FSUtil.node)

// Each Promise edge builds the filesystem layer for its own run. A module-level ManagedRuntime
// would keep the process alive after a CLI worker finishes.
function runPromise<A, E>(effect: Effect.Effect<A, E, FSUtil.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(fileSystemLayer)))
}

const defaultInstallDeps: InstallDeps = {
  resolve: (spec) => resolvePluginTarget(spec),
}

const defaultPatchDeps: PatchDeps = {
  readText: (file) => Filesystem.readText(file),
  write: (file, text) => Filesystem.write(file, text),
  exists: (file) => Filesystem.exists(file),
  files: (dir, name) => ConfigPaths.fileInDirectory(dir, name),
}

function pluginSpec(item: unknown): Option.Option<string> {
  if (typeof item === "string") return Option.some(item)
  if (!Array.isArray(item)) return Option.none()
  const head: unknown = item[0]
  return typeof head === "string" ? Option.some(head) : Option.none()
}

function pluginList(data: unknown): Option.Option<unknown[]> {
  if (!isRecord(data)) return Option.none()
  const list: unknown = data.plugin
  return Array.isArray(list) ? Option.some(list) : Option.none()
}

function trimmed(value: unknown): Option.Option<string> {
  if (typeof value !== "string") return Option.none()
  const next = value.trim()
  return next ? Option.some(next) : Option.none()
}

function exportValue(value: unknown): Option.Option<string> {
  if (typeof value === "string") return trimmed(value)
  if (!isRecord(value)) return Option.none()
  return Arr.findFirst(["import", "default"], (key) => trimmed(value[key]))
}

function exportOptions(value: unknown): Option.Option<Record<string, unknown>> {
  if (!isRecord(value)) return Option.none()
  const config = value.config
  return isRecord(config) ? Option.some(config) : Option.none()
}

function exportTarget(pkg: Record<string, unknown>, kind: Kind): Option.Option<Target> {
  const exports = pkg.exports
  if (!isRecord(exports)) return Option.none()
  const value = exports[`./${kind}`]
  if (Option.isNone(exportValue(value))) return Option.none()
  return Option.some({ kind, opts: Option.getOrUndefined(exportOptions(value)) })
}

function hasMainTarget(pkg: Record<string, unknown>) {
  const main = pkg.main
  if (typeof main !== "string") return false
  return Boolean(main.trim())
}

function packageTargets(pkg: PluginPackage): Result.Result<Target[], unknown> {
  const spec =
    typeof pkg.json.name === "string" && pkg.json.name.trim().length > 0 ? pkg.json.name.trim() : path.basename(pkg.dir)
  const server = exportTarget(pkg.json, "server")
  const serverTargets: Target[] = Option.isSome(server)
    ? [server.value]
    : hasMainTarget(pkg.json)
      ? [{ kind: "server" }]
      : []

  const tui = exportTarget(pkg.json, "tui")
  if (Option.isSome(tui)) return Result.succeed(Arr.append(serverTargets, tui.value))

  // A package without a tui entry still installs as a tui plugin when it ships oc-themes.
  return packageThemes(spec, pkg).pipe(
    Result.map((themes): Target[] => (themes.length ? Arr.append(serverTargets, { kind: "tui" }) : serverTargets)),
  )
}

function patch(text: string, path: Array<string | number>, value: unknown, insert = false) {
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: {
        tabSize: 2,
        insertSpaces: true,
      },
      isArrayInsertion: insert,
    }),
  )
}

function patchPluginList(
  text: string,
  list: Option.Option<unknown[]>,
  spec: string,
  next: unknown,
  force = false,
): { mode: Mode; text: string } {
  const pkg = parsePluginSpecifier(spec).pkg
  const rows = Option.getOrElse(list, (): unknown[] => []).map((item, i) => ({
    item,
    i,
    spec: pluginSpec(item),
  }))
  const dup = rows.filter((item) => {
    if (Option.isNone(item.spec) || !item.spec.value) return false
    if (item.spec.value === spec) return true
    if (item.spec.value.startsWith("file://")) return false
    return parsePluginSpecifier(item.spec.value).pkg === pkg
  })

  if (!dup.length) {
    if (Option.isNone(list)) {
      return {
        mode: "add",
        text: patch(text, ["plugin"], [next]),
      }
    }
    return {
      mode: "add",
      text: patch(text, ["plugin", list.value.length], next, true),
    }
  }

  if (!force) {
    return {
      mode: "noop",
      text,
    }
  }

  const keep = dup[0]
  if (!keep) {
    return {
      mode: "noop",
      text,
    }
  }

  if (dup.length === 1 && Option.contains(keep.spec, spec)) {
    return {
      mode: "noop",
      text,
    }
  }

  const replaced =
    typeof keep.item === "string"
      ? patch(text, ["plugin", keep.i], next)
      : Array.isArray(keep.item) && typeof keep.item[0] === "string"
        ? patch(text, ["plugin", keep.i, 0], spec)
        : text

  // Remove the other duplicates from the last index down, so earlier indexes stay valid.
  const out = dup
    .map((item) => item.i)
    .filter((i) => i !== keep.i)
    .sort((a, b) => b - a)
    // eslint-disable-next-line effect/no-undefined-use-option -- (a) jsonc-parser modify() removes the item only when the value is the JavaScript undefined value
    .reduce((acc, i) => patch(acc, ["plugin", i], undefined), replaced)

  return {
    mode: "replace",
    text: out,
  }
}

export function installPlugin(spec: string, dep: InstallDeps = defaultInstallDeps): Promise<InstallResult> {
  return runPromise(
    call(() => dep.resolve(spec)).pipe(
      Effect.match({
        onFailure: (error): InstallResult => ({ ok: false, code: "install_failed", error: error.cause }),
        onSuccess: (target): InstallResult => ({ ok: true, target }),
      }),
    ),
  )
}

const pluginManifest = Effect.fn("PluginInstall.pluginManifest")(function* (target: string) {
  const pkg = yield* Effect.result(readPluginPackage(target))
  if (Result.isFailure(pkg)) {
    const failed: ManifestResult = { ok: false, code: "manifest_read_failed", file: target, error: pkg.failure }
    return failed
  }

  const targets = packageTargets(pkg.success)
  if (Result.isFailure(targets)) {
    const failed: ManifestResult = {
      ok: false,
      code: "manifest_read_failed",
      file: pkg.success.pkg,
      error: targets.failure,
    }
    return failed
  }

  if (!targets.success.length) {
    const empty: ManifestResult = { ok: false, code: "manifest_no_targets", file: pkg.success.pkg }
    return empty
  }

  const found: ManifestResult = { ok: true, targets: targets.success }
  return found
})

export function readPluginManifest(target: string): Promise<ManifestResult> {
  return runPromise(pluginManifest(target))
}

function patchDir(input: PatchInput) {
  if (input.global) return input.config ?? Global.Path.config
  const git = input.vcs === "git" && input.worktree !== "/"
  const root = git ? input.worktree : input.directory
  return path.join(root, ".opencode")
}

function patchName(kind: Kind): "opencode" | "tui" {
  if (kind === "server") return "opencode"
  return "tui"
}

function isMissingFile(cause: unknown) {
  return isRecord(cause) && cause.code === "ENOENT"
}

const patchOne = Effect.fn("PluginInstall.patchOne")(function* (
  dir: string,
  target: Target,
  spec: string,
  force: boolean,
  dep: PatchDeps,
) {
  const name = patchName(target.kind)
  yield* Flock.effect(`plug-config:${Filesystem.resolve(path.join(dir, name))}`)

  const files = dep.files(dir, name)
  // A rejected exists() check fails the whole patch, as it did before.
  const found = yield* Effect.findFirst(files, (file) => call(() => dep.exists(file)).pipe(Effect.orDie))
  const cfg = Option.getOrElse(found, () => files[0])

  const read = yield* Effect.result(
    call(() => dep.readText(cfg)).pipe(
      Effect.catchIf(
        (error) => isMissingFile(error.cause),
        () => Effect.succeed("{}"),
      ),
    ),
  )
  if (Result.isFailure(read)) {
    const failed: PatchOne = { ok: false, code: "patch_failed", kind: target.kind, error: read.failure.cause }
    return failed
  }
  const src = read.success
  const text = src.trim() ? src : "{}"

  // jsonc-parser reports parse errors by appending them to the array that the caller passes.
  const errs: JsoncParseError[] = []
  const data = parseJsonc(text, errs, { allowTrailingComma: true })
  if (errs.length) {
    const err = errs[0]
    const lines = text.substring(0, err.offset).split("\n")
    const invalid: PatchOne = {
      ok: false,
      code: "invalid_json",
      kind: target.kind,
      file: cfg,
      line: lines.length,
      col: lines[lines.length - 1].length + 1,
      parse: printParseErrorCode(err.error),
    }
    return invalid
  }

  const item = target.opts ? ([spec, target.opts] as const) : spec
  const out = patchPluginList(text, pluginList(data), spec, item, force)
  const done: PatchOne = {
    ok: true,
    item: {
      kind: target.kind,
      mode: out.mode,
      file: cfg,
    },
  }
  if (out.mode === "noop") return done

  const write = yield* Effect.result(call(() => dep.write(cfg, out.text)))
  // Only an Error rejection counts as a failed write, as it did before.
  if (Result.isFailure(write) && write.failure.cause instanceof Error) {
    const failed: PatchOne = { ok: false, code: "patch_failed", kind: target.kind, error: write.failure.cause }
    return failed
  }

  return done
}, Effect.scoped)

const pluginConfigPatch = Effect.fn("PluginInstall.pluginConfigPatch")(function* (input: PatchInput, dep: PatchDeps) {
  const dir = patchDir(input)
  let items: PatchItem[] = []
  for (const target of input.targets) {
    const hit = yield* patchOne(dir, target, input.spec, Boolean(input.force), dep)
    if (!hit.ok) {
      const failed: PatchResult = { ...hit, dir }
      return failed
    }
    items = Arr.append(items, hit.item)
  }
  const done: PatchResult = { ok: true, dir, items }
  return done
})

export function patchPluginConfig(input: PatchInput, dep: PatchDeps = defaultPatchDeps): Promise<PatchResult> {
  return runPromise(pluginConfigPatch(input, dep))
}
