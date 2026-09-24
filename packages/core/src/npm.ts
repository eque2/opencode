export * as Npm from "./npm"

import path from "path"
import { createRequire } from "module"
import { pathToFileURL } from "url"
import npa from "npm-package-arg"
import { Effect, Schema, Context, Layer, Option, FileSystem, HashSet } from "effect"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { EffectFlock } from "./util/effect-flock"
import { makeGlobalNode } from "./effect/app-node"
import { filesystem } from "./effect/app-node-platform"
import { LayerNode } from "./effect/layer-node"
import { makeRuntime } from "./effect/runtime"
import { NpmConfig } from "./npm-config"

export class InstallFailedError extends Schema.TaggedError<InstallFailedError>()("NpmInstallFailedError", {
  add: Schema.Array(Schema.String).pipe(Schema.optional),
  dir: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface EntryPoint {
  readonly directory: string
  readonly entrypoint?: string
}

export interface Interface {
  readonly add: (pkg: string) => Effect.Effect<EntryPoint, InstallFailedError | EffectFlock.LockError>
  readonly install: (
    dir: string,
    input?: {
      add: {
        name: string
        version?: string
      }[]
    },
  ) => Effect.Effect<void, EffectFlock.LockError | InstallFailedError>
  readonly which: (pkg: string, bin?: string) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Npm") {}

// Characters that Windows does not allow in a file name.
const illegal = HashSet.make("<", ">", ":", '"', "|", "?", "*")

export function sanitize(pkg: string) {
  if (process.platform !== "win32") return pkg
  return Array.from(pkg, (char) => (HashSet.has(illegal, char) || char.charCodeAt(0) < 32 ? "_" : char)).join("")
}

// Node only honors the parent argument behind --experimental-import-meta-resolve, and
// import() of the bare package directory fails with ERR_UNSUPPORTED_DIR_IMPORT. require
// resolution picks the "require"/"default" export target, which import() loads fine.
// Both resolvers throw when the package cannot be resolved, which gives None.
const resolveEntrypoint = Option.liftThrowable((name: string, dir: string) =>
  typeof Bun !== "undefined"
    ? import.meta.resolve(name, dir)
    : pathToFileURL(createRequire(path.join(dir, "package.json")).resolve(name)).href,
)

const resolveEntryPoint = (name: string, dir: string): EntryPoint => ({
  directory: dir,
  entrypoint: Option.getOrUndefined(resolveEntrypoint(name, dir)),
})

// npm-package-arg throws for a spec it cannot parse, which gives None.
const parsePackageSpec = Option.liftThrowable(npa)

// The dependency fields that package.json and the root package-lock.json entry share. Only the names matter.
const DependencyFields = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
}).annotate({ identifier: "Npm.DependencyFields" })

const PackageLock = Schema.Struct({
  packages: Schema.optional(Schema.Struct({ "": Schema.optional(DependencyFields) })),
}).annotate({ identifier: "Npm.PackageLock" })

// The package.json `bin` field: one executable path, or a map from command name to path.
const PackageBin = Schema.Struct({
  bin: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
}).annotate({ identifier: "Npm.PackageBin" })

const decodePackageBin = Schema.decodeUnknownOption(PackageBin)
const decodeDependencyFields = Schema.decodeUnknownOption(DependencyFields)
const decodePackageLock = Schema.decodeUnknownOption(PackageLock)

const dependencyNames = (fields: typeof DependencyFields.Type) => [
  ...Object.keys(fields.dependencies ?? {}),
  ...Object.keys(fields.devDependencies ?? {}),
  ...Object.keys(fields.peerDependencies ?? {}),
  ...Object.keys(fields.optionalDependencies ?? {}),
]

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const afs = yield* FSUtil.Service
    const global = yield* Global.Service
    const fs = yield* FileSystem.FileSystem
    const flock = yield* EffectFlock.Service
    const directory = (pkg: string) => path.join(global.cache, "packages", sanitize(pkg))
    const reify = (input: { dir: string; add?: string[] }) =>
      Effect.gen(function* () {
        yield* flock.acquire(`npm-install:${input.dir}`)
        const { Arborist } = yield* Effect.promise(() => import("@npmcli/arborist"))
        const add = input.add ?? []
        const npmOptions = yield* NpmConfig.load(input.dir)
        const arborist = new Arborist({
          ...npmOptions,
          path: input.dir,
          binLinks: true,
          progress: false,
          savePrefix: "",
          ignoreScripts: true,
        })
        return yield* Effect.tryPromise({
          try: () =>
            arborist.reify({
              ...npmOptions,
              add,
              save: true,
              saveType: "prod",
            }),
          catch: (cause) =>
            new InstallFailedError({
              cause,
              add,
              dir: input.dir,
            }),
        })
      }).pipe(
        Effect.withSpan("Npm.reify", {
          attributes: input,
        }),
      )

    const add = Effect.fn("Npm.add")(function* (pkg: string) {
      const dir = directory(pkg)
      const name = parsePackageSpec(pkg).pipe(
        Option.flatMapNullishOr((spec) => spec.name),
        Option.getOrElse(() => pkg),
      )

      if (yield* afs.existsSafe(path.join(dir, "node_modules", name))) {
        return resolveEntryPoint(name, path.join(dir, "node_modules", name))
      }

      const tree = yield* reify({ dir, add: [pkg] })
      const first = tree.edgesOut.values().next().value?.to
      if (!first) {
        const result = resolveEntryPoint(name, path.join(dir, "node_modules", name))
        if (result.entrypoint) return result
        return yield* new InstallFailedError({ add: [pkg], dir })
      }
      return resolveEntryPoint(first.name, first.path)
    }, Effect.scoped)

    const install: Interface["install"] = Effect.fn("Npm.install")(function* (dir, input) {
      const canWrite = yield* afs.access(dir, { writable: true }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (!canWrite) return

      const add = input?.add.map((pkg) => [pkg.name, pkg.version].filter(Boolean).join("@")) ?? []
      if (
        yield* Effect.gen(function* () {
          const nodeModulesExists = yield* afs.existsSafe(path.join(dir, "node_modules"))
          if (!nodeModulesExists) {
            yield* reify({ add, dir })
            return true
          }
          return false
        }).pipe(Effect.withSpan("Npm.checkNodeModules"))
      )
        return

      yield* Effect.gen(function* () {
        const pkg = Option.flatMap(
          yield* afs.readJson(path.join(dir, "package.json")).pipe(Effect.option),
          decodeDependencyFields,
        )
        const lock = Option.flatMap(
          yield* afs.readJson(path.join(dir, "package-lock.json")).pipe(Effect.option),
          decodePackageLock,
        )

        const declared = [
          ...Option.match(pkg, { onNone: () => [], onSome: dependencyNames }),
          ...(input?.add ?? []).map((item) => item.name),
        ]
        const locked = HashSet.fromIterable(
          lock.pipe(
            Option.flatMapNullishOr((file) => file.packages?.[""]),
            Option.match({ onNone: () => [], onSome: dependencyNames }),
          ),
        )

        if (declared.some((name) => !HashSet.has(locked, name))) yield* reify({ dir, add })
      }).pipe(Effect.withSpan("Npm.checkDirty"))

      return
    }, Effect.scoped)

    const which = Effect.fn("Npm.which")(function* (pkg: string, bin?: string) {
      const dir = directory(pkg)
      const binDir = path.join(dir, "node_modules", ".bin")

      const pick = Effect.fnUntraced(function* () {
        const files = yield* fs.readDirectory(binDir).pipe(Effect.catch(() => Effect.succeed([] as string[])))

        if (files.length === 0) return Option.none<string>()
        // Caller picked a specific bin (e.g. pyright exposes both `pyright` and
        // `pyright-langserver`); trust the hint if the package provides it.
        if (bin) return files.includes(bin) ? Option.some(bin) : Option.none<string>()
        if (files.length === 1) return Option.some(files[0])

        const pkgJson = Option.flatMap(
          yield* afs.readJson(path.join(dir, "node_modules", pkg, "package.json")).pipe(Effect.option),
          decodePackageBin,
        )

        if (Option.isSome(pkgJson) && pkgJson.value.bin) {
          const unscoped = pkg.startsWith("@") ? pkg.split("/")[1] : pkg
          const parsedBin = pkgJson.value.bin
          if (typeof parsedBin === "string") return Option.some(unscoped)
          const keys = Object.keys(parsedBin)
          if (keys.length === 1) return Option.some(keys[0])
          return parsedBin[unscoped] ? Option.some(unscoped) : Option.some(keys[0])
        }

        return Option.some(files[0])
      })

      return Option.getOrUndefined(
        yield* Effect.gen(function* () {
          const bin = yield* pick()
          if (Option.isSome(bin)) {
            return Option.some(path.join(binDir, bin.value))
          }

          yield* fs.remove(path.join(dir, "package-lock.json")).pipe(Effect.orElseSucceed(() => {}))

          yield* add(pkg)

          const resolved = yield* pick()
          if (Option.isNone(resolved)) return Option.none<string>()
          return Option.some(path.join(binDir, resolved.value))
        }).pipe(
          Effect.scoped,
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
      )
    })

    return Service.of({
      add,
      install,
      which,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Global.node, filesystem, EffectFlock.node],
})

const { runPromise } = makeRuntime(Service, LayerNode.compile(node))

export async function install(...args: Parameters<Interface["install"]>) {
  return runPromise((svc) => svc.install(...args))
}

export async function add(...args: Parameters<Interface["add"]>) {
  return runPromise((svc) => svc.add(...args))
}

export async function which(...args: Parameters<Interface["which"]>) {
  return runPromise((svc) => svc.which(...args))
}
