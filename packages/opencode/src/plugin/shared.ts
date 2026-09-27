import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import npa from "npm-package-arg"
import semver from "semver"
import { Array as Arr, Effect, Option, Predicate, Result, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { Filesystem } from "@/util/filesystem"
import { isRecord } from "@/util/record"

// Old npm package names for plugins that are now built-in
export const DEPRECATED_PLUGIN_PACKAGES = ["opencode-openai-codex-auth", "opencode-copilot-auth"]

// A path plugin directory has neither a package.json nor an index file to load.
export class PluginTargetError extends Schema.TaggedError<PluginTargetError>()("PluginTargetError", {
  message: Schema.String,
}) {}

// npm could not install the package. The cause is the original Npm.add rejection.
export class PluginInstallError extends Schema.TaggedError<PluginInstallError>()("PluginInstallError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

// The plugin package.json cannot be read, or it is not a JSON object.
export class PluginPackageError extends Schema.TaggedError<PluginPackageError>()("PluginPackageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// A package entry or oc-themes path is invalid, or it leaves the plugin directory.
export class PluginEntryError extends Schema.TaggedError<PluginEntryError>()("PluginEntryError", {
  message: Schema.String,
}) {}

// The package declares an opencode engine range that the running version does not satisfy.
export class PluginCompatibilityError extends Schema.TaggedError<PluginCompatibilityError>()(
  "PluginCompatibilityError",
  { message: Schema.String },
) {}

// The plugin module or package does not export a valid plugin shape or id.
export class PluginExportError extends Schema.TaggedError<PluginExportError>()("PluginExportError", {
  message: Schema.String,
}) {}

const fileSystemLayer = LayerNode.compile(FSUtil.node)

// Each Promise edge builds the filesystem layer for its own run. A module-level ManagedRuntime
// would keep the process alive after a CLI worker finishes.
function runPromise<A, E>(effect: Effect.Effect<A, E, FSUtil.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(fileSystemLayer)))
}

export function isDeprecatedPlugin(spec: string) {
  return DEPRECATED_PLUGIN_PACKAGES.some((pkg) => spec.includes(pkg))
}

// npm-package-arg throws for a spec that it cannot parse. Such a spec has no package name.
const parse = Option.liftThrowable((spec: string) => npa(spec))

// An npm alias spec ("npm:target@range") keeps the target package in subSpec.
function aliasTarget(hit: npa.Result): Option.Option<npa.Result> {
  if (hit.type !== "alias" || !("subSpec" in hit)) return Option.none()
  return hit.subSpec instanceof npa.Result ? Option.some(hit.subSpec) : Option.none()
}

function specifierOf(spec: string, hit: npa.Result) {
  if (!hit.name) {
    const sub = aliasTarget(hit)
    if (Option.isSome(sub) && sub.value.name) {
      const raw = sub.value.rawSpec
      return { pkg: sub.value.name, version: !raw || raw === "*" ? "latest" : raw }
    }
    return { pkg: spec, version: "" }
  }
  if (hit.raw === hit.name) return { pkg: hit.name, version: "latest" }
  return { pkg: hit.name, version: hit.rawSpec }
}

export function parsePluginSpecifier(spec: string) {
  return Option.match(parse(spec), {
    onNone: () => ({ pkg: spec, version: "" }),
    onSome: (hit) => specifierOf(spec, hit),
  })
}

export type PluginSource = "file" | "npm"
export type PluginKind = "server" | "tui"
type PluginMode = "strict" | "detect"

export type PluginPackage = {
  dir: string
  pkg: string
  json: Record<string, unknown>
}

export type PluginEntry = {
  spec: string
  source: PluginSource
  target: string
  pkg: Option.Option<PluginPackage>
  entry: Option.Option<string>
}

const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"]

export function pluginSource(spec: string): PluginSource {
  if (isPathPluginSpec(spec)) return "file"
  return "npm"
}

function resolveExportPath(raw: string, dir: string) {
  if (raw.startsWith("file://")) return fileURLToPath(raw)
  if (path.isAbsolute(raw)) return raw
  return path.resolve(dir, raw)
}

function isAbsolutePath(raw: string) {
  return path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)
}

function extractExportValue(value: unknown): Option.Option<string> {
  if (typeof value === "string") return Option.some(value)
  if (!isRecord(value)) return Option.none()
  return Arr.findFirst(["import", "default"], (key) => Option.liftPredicate(value[key], Predicate.isString))
}

function packageMain(pkg: PluginPackage): Option.Option<string> {
  const value = pkg.json.main
  if (typeof value !== "string") return Option.none()
  const next = value.trim()
  return next ? Option.some(next) : Option.none()
}

function resolvePackageFile(
  spec: string,
  raw: string,
  kind: string,
  pkg: PluginPackage,
): Result.Result<string, PluginEntryError> {
  const root = Filesystem.resolve(pkg.dir)
  const next = Filesystem.resolve(resolveExportPath(raw, pkg.dir))
  if (Filesystem.contains(root, next)) return Result.succeed(next)
  return Result.fail(
    new PluginEntryError({ message: `Plugin ${spec} resolved ${kind} entry outside plugin directory` }),
  )
}

function resolvePackagePath(spec: string, raw: string, kind: PluginKind, pkg: PluginPackage) {
  return resolvePackageFile(spec, raw, kind, pkg).pipe(Result.map((file) => Option.some(pathToFileURL(file).href)))
}

function resolvePackageEntrypoint(
  spec: string,
  kind: PluginKind,
  pkg: PluginPackage,
): Result.Result<Option.Option<string>, PluginEntryError> {
  const exports = pkg.json.exports
  const raw = isRecord(exports) ? extractExportValue(exports[`./${kind}`]) : Option.none<string>()
  if (Option.isSome(raw) && raw.value) return resolvePackagePath(spec, raw.value, kind, pkg)

  if (kind !== "server") return Result.succeedNone
  const main = packageMain(pkg)
  if (Option.isNone(main)) return Result.succeedNone
  return resolvePackagePath(spec, main.value, kind, pkg)
}

function targetPath(target: string): Option.Option<string> {
  if (target.startsWith("file://")) return Option.some(fileURLToPath(target))
  return path.isAbsolute(target) ? Option.some(target) : Option.none()
}

// A missing path is not a directory. Any other stat failure is an error, as with fs.stat.
const isDirectory = Effect.fnUntraced(function* (file: string) {
  const fsu = yield* FSUtil.Service
  const info = yield* fsu.stat(file).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
  )
  return Option.exists(info, (item) => item.type === "Directory")
})

const resolveDirectoryIndex = Effect.fnUntraced(function* (dir: string) {
  const fsu = yield* FSUtil.Service
  return yield* Effect.findFirst(
    INDEX_FILES.map((name) => path.join(dir, name)),
    (file) => fsu.existsSafe(file),
  )
})

const resolveTargetDirectory = Effect.fnUntraced(function* (target: string) {
  const file = targetPath(target)
  if (Option.isNone(file)) return file
  return (yield* isDirectory(file.value)) ? file : Option.none<string>()
})

const resolvePluginEntrypoint = Effect.fnUntraced(function* (
  spec: string,
  target: string,
  kind: PluginKind,
  pkg: Option.Option<PluginPackage>,
) {
  if (Option.isNone(pkg)) return Option.some(target)
  const hit = pkg.value
  const source = pluginSource(spec)

  const entry = yield* Effect.fromResult(resolvePackageEntrypoint(spec, kind, hit))
  if (Option.isSome(entry)) return entry

  const dir = yield* resolveTargetDirectory(target)

  if (kind === "tui") {
    if (source === "file" && Option.isSome(dir)) {
      const index = yield* resolveDirectoryIndex(dir.value)
      if (Option.isSome(index)) return Option.some(pathToFileURL(index.value).href)
    }

    if (source === "npm") return Option.none<string>()
    if (Option.isSome(dir)) return Option.none<string>()

    return Option.some(target)
  }

  if (Option.isSome(dir) && isRecord(hit.json.exports)) {
    if (source === "file") {
      const index = yield* resolveDirectoryIndex(dir.value)
      if (Option.isSome(index)) return Option.some(pathToFileURL(index.value).href)
    }

    return Option.none<string>()
  }

  return Option.some(target)
})

export function isPathPluginSpec(spec: string) {
  return spec.startsWith("file://") || spec.startsWith(".") || isAbsolutePath(spec)
}

// Resolve a path plugin spec to a file URL: a directory with package.json, or its index file.
export const pathPluginTarget = Effect.fn("PluginShared.pathPluginTarget")(function* (spec: string) {
  const raw = spec.startsWith("file://") ? fileURLToPath(spec) : spec
  const file = isAbsolutePath(raw) ? raw : path.resolve(raw)
  if (!(yield* isDirectory(file))) {
    if (spec.startsWith("file://")) return spec
    return pathToFileURL(file).href
  }

  const fsu = yield* FSUtil.Service
  if (yield* fsu.existsSafe(path.join(file, "package.json"))) {
    return pathToFileURL(file).href
  }

  const index = yield* resolveDirectoryIndex(file)
  if (Option.isSome(index)) return pathToFileURL(index.value).href

  return yield* new PluginTargetError({ message: `Plugin directory ${file} is missing package.json or index file` })
})

// Promise form of pathPluginTarget for callers outside Effect.
export function resolvePathPluginTarget(spec: string): Promise<string> {
  return runPromise(pathPluginTarget(spec))
}

export const checkPluginCompatibility = Effect.fn("PluginShared.checkPluginCompatibility")(function* (
  target: string,
  opencodeVersion: string,
  pkg: Option.Option<PluginPackage>,
) {
  if (!semver.valid(opencodeVersion) || semver.major(opencodeVersion) === 0) return
  const hit = Option.isSome(pkg) ? pkg : yield* Effect.option(readPluginPackage(target))
  const range = hit.pipe(
    Option.map((item) => item.json.engines),
    Option.filter(isRecord),
    Option.map((engines) => engines.opencode),
    Option.filter(Predicate.isString),
  )
  if (Option.isSome(range) && !semver.satisfies(opencodeVersion, range.value)) {
    yield* new PluginCompatibilityError({
      message: `Plugin requires opencode ${range.value} but running ${opencodeVersion}`,
    })
  }
})

// Resolve a plugin spec to a local target: a path plugin resolves on disk, an npm plugin installs.
export const pluginTarget = Effect.fn("PluginShared.pluginTarget")(function* (spec: string) {
  if (isPathPluginSpec(spec)) return yield* pathPluginTarget(spec)
  const pkg = Option.match(parse(spec), {
    onNone: () => spec,
    onSome: (hit) => (hit.name && hit.raw === hit.name ? `${hit.name}@latest` : spec),
  })
  // Npm.add is the Promise form of the npm service. Tests replace it with spyOn.
  const result = yield* Effect.tryPromise({
    try: () => Npm.add(pkg),
    catch: (cause) => new PluginInstallError({ message: `Failed to install plugin package ${pkg}`, cause }),
  })
  return result.directory
})

// Promise form of pluginTarget. It rejects with the original Npm.add rejection, as it did before.
export function resolvePluginTarget(spec: string): Promise<string> {
  return runPromise(pluginTarget(spec).pipe(Effect.catchTag("PluginInstallError", (error) => Effect.fail(error.cause))))
}

export const readPluginPackage = Effect.fn("PluginShared.readPluginPackage")(function* (target: string) {
  const fsu = yield* FSUtil.Service
  const file = target.startsWith("file://") ? fileURLToPath(target) : target
  const read = Effect.gen(function* () {
    const dir = (yield* isDirectory(file)) ? file : path.dirname(file)
    const pkg = path.join(dir, "package.json")
    return { dir, pkg, json: yield* fsu.readJson(pkg) }
  })
  const hit = yield* read.pipe(
    Effect.mapError(
      (cause) => new PluginPackageError({ message: `Failed to read plugin package for ${target}`, cause }),
    ),
  )
  if (!isRecord(hit.json)) {
    return yield* new PluginPackageError({ message: `Plugin package ${hit.pkg} is not a JSON object` })
  }
  const pkg: PluginPackage = { dir: hit.dir, pkg: hit.pkg, json: hit.json }
  return pkg
})

export const createPluginEntry = Effect.fn("PluginShared.createPluginEntry")(function* (
  spec: string,
  target: string,
  kind: PluginKind,
) {
  const source = pluginSource(spec)
  const pkg =
    source === "npm" ? Option.some(yield* readPluginPackage(target)) : yield* Effect.option(readPluginPackage(target))
  const entry = yield* resolvePluginEntrypoint(spec, target, kind, pkg)
  const result: PluginEntry = { spec, source, target, pkg, entry }
  return result
})

function packageTheme(spec: string, item: unknown, pkg: PluginPackage): Result.Result<string, PluginEntryError> {
  if (typeof item !== "string") {
    return Result.fail(new PluginEntryError({ message: `Plugin ${spec} has invalid oc-themes entry` }))
  }

  const raw = item.trim()
  if (!raw) {
    return Result.fail(new PluginEntryError({ message: `Plugin ${spec} has empty oc-themes entry` }))
  }
  if (raw.startsWith("file://") || isAbsolutePath(raw)) {
    return Result.fail(new PluginEntryError({ message: `Plugin ${spec} oc-themes entry must be relative: ${item}` }))
  }

  return resolvePackageFile(spec, raw, "oc-themes", pkg)
}

// Resolve the oc-themes files of a package. Each entry must stay inside the plugin directory.
export function packageThemes(spec: string, pkg: PluginPackage): Result.Result<string[], PluginEntryError> {
  const field = pkg.json["oc-themes"]
  if (field === undefined) return Result.succeed([])
  if (!Array.isArray(field)) {
    return Result.fail(new PluginEntryError({ message: `Plugin ${spec} has invalid oc-themes field` }))
  }

  // Stop at the first invalid entry, and keep the first occurrence of each resolved path.
  return Result.all(field.map((item: unknown) => packageTheme(spec, item, pkg))).pipe(Result.map(Arr.dedupe))
}

// Sync form for callers outside Effect. It throws the PluginEntryError, as it threw a TypeError before.
export function readPackageThemes(spec: string, pkg: PluginPackage) {
  return Result.getOrThrow(packageThemes(spec, pkg))
}

function pluginId(id: unknown, spec: string): Result.Result<Option.Option<string>, PluginExportError> {
  if (id === undefined) return Result.succeedNone
  if (typeof id !== "string") {
    return Result.fail(new PluginExportError({ message: `Plugin ${spec} has invalid id type ${typeof id}` }))
  }
  const value = id.trim()
  if (!value) return Result.fail(new PluginExportError({ message: `Plugin ${spec} has an empty id` }))
  return Result.succeedSome(value)
}

// Sync form for callers outside Effect. A missing id reads as undefined, and an invalid id throws.
export function readPluginId(id: unknown, spec: string) {
  return Option.getOrUndefined(Result.getOrThrow(pluginId(id, spec)))
}

function v1Plugin(
  mod: Record<string, unknown>,
  spec: string,
  kind: PluginKind,
  mode: PluginMode,
): Result.Result<Option.Option<Record<string, unknown>>, PluginExportError> {
  const value = mod.default
  if (!isRecord(value)) {
    if (mode === "detect") return Result.succeedNone
    return Result.fail(
      new PluginExportError({ message: `Plugin ${spec} must default export an object with ${kind}()` }),
    )
  }
  if (mode === "detect" && !("id" in value) && !("server" in value) && !("tui" in value)) return Result.succeedNone

  const server = value.server
  const tui = value.tui
  if (server !== undefined && typeof server !== "function") {
    return Result.fail(new PluginExportError({ message: `Plugin ${spec} has invalid server export` }))
  }
  if (tui !== undefined && typeof tui !== "function") {
    return Result.fail(new PluginExportError({ message: `Plugin ${spec} has invalid tui export` }))
  }
  if (server !== undefined && tui !== undefined) {
    return Result.fail(
      new PluginExportError({ message: `Plugin ${spec} must default export either server() or tui(), not both` }),
    )
  }
  if (kind === "server" && server === undefined) {
    return Result.fail(new PluginExportError({ message: `Plugin ${spec} must default export an object with server()` }))
  }
  if (kind === "tui" && tui === undefined) {
    return Result.fail(new PluginExportError({ message: `Plugin ${spec} must default export an object with tui()` }))
  }

  return Result.succeedSome(value)
}

// Sync form for callers outside Effect. A module that detect mode skips reads as undefined.
export function readV1Plugin(
  mod: Record<string, unknown>,
  spec: string,
  kind: PluginKind,
  mode: PluginMode = "strict",
) {
  return Option.getOrUndefined(Result.getOrThrow(v1Plugin(mod, spec, kind, mode)))
}

const pluginIdFor = Effect.fn("PluginShared.pluginIdFor")(function* (
  source: PluginSource,
  spec: string,
  target: string,
  id: Option.Option<string>,
  pkg: Option.Option<PluginPackage>,
) {
  if (Option.isSome(id)) return id.value
  if (source === "file") return yield* new PluginExportError({ message: `Path plugin ${spec} must export id` })
  const hit = Option.isSome(pkg) ? pkg.value : yield* readPluginPackage(target)
  const name = hit.json.name
  if (typeof name !== "string" || !name.trim()) {
    return yield* new PluginExportError({ message: `Plugin package ${hit.pkg} is missing name` })
  }
  return name.trim()
})

// Promise form of pluginIdFor for callers outside Effect.
export function resolvePluginId(
  source: PluginSource,
  spec: string,
  target: string,
  id: string | undefined,
  pkg?: PluginPackage,
): Promise<string> {
  // An empty id counts as missing, as it did with the truthiness check before.
  const given = Option.fromNullishOr(id).pipe(Option.filter((value) => value.length > 0))
  return runPromise(pluginIdFor(source, spec, target, given, Option.fromNullishOr(pkg)))
}
