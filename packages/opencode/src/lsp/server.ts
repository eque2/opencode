import type { ChildProcessWithoutNullStreams } from "child_process"
import path from "path"
import os from "os"
import { text } from "node:stream/consumers"
import { Array, Config, Effect, Option, Schema, Semaphore } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { Filesystem } from "@/util/filesystem"
import type { InstanceContext } from "../project/instance-context"
import { Archive } from "@/util/archive"
import { Process } from "@/util/process"
import { which } from "@opencode-ai/core/util/which"
import { Module } from "@opencode-ai/core/util/module"
import { spawn, type LaunchError } from "./launch"
import { Npm } from "@opencode-ai/core/npm"
import type { RuntimeFlags } from "@/effect/runtime-flags"

// Not exported: the LSP service reads every export of this module as a server definition.
class InstallError extends Schema.TaggedError<InstallError>()("LSPServer.InstallError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Handle {
  process: ChildProcessWithoutNullStreams
  initialization?: Record<string, any>
}

type RootFunction = (file: string, ctx: InstanceContext) => Effect.Effect<Option.Option<string>, never, FSUtil.Service>

export interface Info {
  id: string
  extensions: string[]
  global?: boolean
  root: RootFunction
  /** None when the server is not available; the LSP service then marks it broken, as it does on a failure. */
  spawn: (
    root: string,
    ctx: InstanceContext,
    flags: RuntimeFlags.Info,
  ) => Effect.Effect<Option.Option<Handle>, InstallError | LaunchError | FSUtil.Error, FSUtil.Service>
}

const ReleaseAsset = Schema.Struct({
  name: Schema.optional(Schema.String),
  browser_download_url: Schema.optional(Schema.String),
}).annotate({ identifier: "LSPServer.ReleaseAsset" })

// The GitHub API sends a null name for a release without a title.
const GithubRelease = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  tag_name: Schema.optional(Schema.String),
  assets: Schema.optional(Schema.Array(ReleaseAsset)),
}).annotate({ identifier: "LSPServer.GithubRelease" })

const TerraformBuild = Schema.Struct({
  arch: Schema.optional(Schema.String),
  os: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
}).annotate({ identifier: "LSPServer.TerraformBuild" })

const TerraformRelease = Schema.Struct({
  version: Schema.optional(Schema.String),
  builds: Schema.optional(Schema.Array(TerraformBuild)),
}).annotate({ identifier: "LSPServer.TerraformRelease" })

const decodeGithubRelease = Schema.decodeUnknownEffect(GithubRelease)
const decodeTerraformRelease = Schema.decodeUnknownEffect(TerraformRelease)

// Calls into the Promise-based helpers; a rejection fails the install.
const attempt = <A>(message: string, evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => new InstallError({ message, cause }) })

const run = (cmd: string[], opts: Process.RunOptions = {}) =>
  attempt(`Could not run ${cmd[0]}`, () => Process.run(cmd, { ...opts, nothrow: true }))

const output = (cmd: string[], opts: Process.RunOptions = {}) =>
  attempt(`Could not run ${cmd[0]}`, () => Process.text(cmd, { ...opts, nothrow: true }))

// Runs an installer and returns its exit code.
const install = (cmd: string[], opts: Process.Options = {}) =>
  attempt(
    `Could not run ${cmd[0]}`,
    () => Process.spawn(cmd, { ...opts, stdout: "pipe", stderr: "pipe", stdin: "pipe" }).exited,
  )

const npmWhich = (pkg: string, bin?: string) =>
  attempt(`Could not resolve the npm package ${pkg}`, () => Npm.which(pkg, bin)).pipe(Effect.map(Option.fromNullishOr))

// The command on PATH, else the binary of an npm package unless downloads are disabled.
const findBinary = Effect.fnUntraced(function* (
  command: string,
  flags: RuntimeFlags.Info,
  pkg: string,
  bin?: string,
) {
  const found = yield* which(command)
  if (Option.isSome(found) || flags.disableLspDownload) return found
  return yield* npmWhich(pkg, bin)
})

// Fetches a URL; a response that is not ok is None.
const fetchOk = (url: string) =>
  attempt(`Could not fetch ${url}`, () => fetch(url)).pipe(
    Effect.map((response) => (response.ok ? Option.some(response) : Option.none())),
  )

// Fetches a JSON document and checks its shape; a response that is not ok is None.
const fetchJson = Effect.fnUntraced(function* <A>(
  url: string,
  decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
) {
  const response = yield* fetchOk(url)
  if (Option.isNone(response)) return Option.none<A>()
  const body = yield* attempt(`Could not read ${url}`, () => response.value.json())
  const decoded = yield* decode(body).pipe(
    Effect.mapError((cause) => new InstallError({ message: `Unexpected response from ${url}`, cause })),
  )
  return Option.some(decoded)
})

// Downloads a URL into a file; a response that is not ok is false.
const download = Effect.fnUntraced(function* (url: string, target: string) {
  const response = yield* fetchOk(url)
  if (Option.isNone(response)) return false
  const body = response.value.body
  if (body) yield* attempt(`Could not write ${target}`, () => Filesystem.writeStream(target, body))
  return true
})

// Extracts a zip archive; a failed extraction is false.
const unzip = (archive: string, target: string) =>
  attempt(`Could not extract ${archive}`, () => Archive.extractZip(archive, target)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

// Marks a downloaded binary executable. Windows has no execute bit.
const makeExecutable = Effect.fnUntraced(function* (bin: string) {
  if (process.platform === "win32") return
  const fsu = yield* FSUtil.Service
  yield* fsu.chmod(bin, 0o755).pipe(Effect.ignore)
})

const firstExisting = Effect.fnUntraced(function* (candidates: ReadonlyArray<string>) {
  const fsu = yield* FSUtil.Service
  return yield* Effect.findFirst(candidates, (candidate) => fsu.existsSafe(candidate))
})

// Starts the server process and wraps it in a handle.
const start = (
  command: string,
  args: ReadonlyArray<string>,
  options: Process.Options,
  initialization?: Record<string, unknown>,
) =>
  spawn(command, args, options).pipe(
    Effect.map(
      (proc): Option.Option<Handle> => Option.some(initialization ? { process: proc, initialization } : { process: proc }),
    ),
  )

// Walks up from `dir` to `stop` and returns the first target path that exists.
const nearest = (
  targets: ReadonlyArray<string>,
  dir: string,
  stop: string,
): Effect.Effect<Option.Option<string>, never, FSUtil.Service> =>
  Effect.gen(function* () {
    const found = yield* firstExisting(targets.map((target) => path.join(dir, target)))
    const parent = path.dirname(dir)
    if (Option.isSome(found) || dir === stop || parent === dir) return found
    return yield* nearest(targets, parent, stop)
  })

// Every `target` path that exists from `dir` up to `stop`, nearest first.
const everyUp = (target: string, dir: string, stop: string): Effect.Effect<string[], never, FSUtil.Service> =>
  Effect.gen(function* () {
    const fsu = yield* FSUtil.Service
    const candidate = path.join(dir, target)
    const here = (yield* fsu.existsSafe(candidate)) ? [candidate] : []
    const parent = path.dirname(dir)
    if (dir === stop || parent === dir) return here
    return [...here, ...(yield* everyUp(target, parent, stop))]
  })

// The folder of the nearest include match, or the instance folder when nothing matches.
const NearestRoot =
  (includePatterns: ReadonlyArray<string>, excludePatterns?: ReadonlyArray<string>): RootFunction =>
  (file, ctx) =>
    Effect.gen(function* () {
      if (excludePatterns) {
        const excluded = yield* nearest(excludePatterns, path.dirname(file), ctx.directory)
        if (Option.isSome(excluded)) return Option.none()
      }
      const first = yield* nearest(includePatterns, path.dirname(file), ctx.directory)
      return Option.some(Option.match(first, { onNone: () => ctx.directory, onSome: (found) => path.dirname(found) }))
    })

// The folder of the nearest include match, or None when nothing matches.
const StrictNearestRoot =
  (includePatterns: ReadonlyArray<string>, excludePatterns?: ReadonlyArray<string>): RootFunction =>
  (file, ctx) =>
    Effect.gen(function* () {
      if (excludePatterns) {
        const excluded = yield* nearest(excludePatterns, path.dirname(file), ctx.directory)
        if (Option.isSome(excluded)) return Option.none()
      }
      const first = yield* nearest(includePatterns, path.dirname(file), ctx.directory)
      return Option.map(first, (found) => path.dirname(found))
    })

const instanceRoot: RootFunction = (_file, ctx) => Effect.succeed(Option.some(ctx.directory))

export const Deno: Info = {
  id: "deno",
  root: StrictNearestRoot(["deno.json", "deno.jsonc"]),
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
  spawn: Effect.fnUntraced(function* (root) {
    const deno = yield* which("deno")
    if (Option.isNone(deno)) return Option.none()
    return yield* start(deno.value, ["lsp"], { cwd: root })
  }),
}

export const Typescript: Info = {
  id: "typescript",
  root: NearestRoot(
    ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"],
    ["deno.json", "deno.jsonc"],
  ),
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  spawn: Effect.fnUntraced(function* (root, ctx) {
    const tsserver = Module.resolve("typescript/lib/tsserver.js", ctx.directory)
    if (!tsserver) return Option.none()
    const bin = yield* npmWhich("typescript-language-server")
    if (Option.isNone(bin)) return Option.none()
    return yield* start(
      bin.value,
      ["--stdio"],
      { cwd: root, env: { ...process.env } },
      { tsserver: { path: tsserver } },
    )
  }),
}

export const Vue: Info = {
  id: "vue",
  extensions: [".vue"],
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const binary = yield* findBinary("vue-language-server", flags, "@vue/language-server")
    if (Option.isNone(binary)) return Option.none()
    // Leave the initialization empty; the server will auto-detect workspace TypeScript.
    return yield* start(binary.value, ["--stdio"], { cwd: root, env: { ...process.env } }, {})
  }),
}

export const ESLint: Info = {
  id: "eslint",
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"],
  spawn: Effect.fnUntraced(function* (root, ctx, flags) {
    const eslint = Module.resolve("eslint", ctx.directory)
    if (!eslint) return Option.none()
    const fsu = yield* FSUtil.Service
    const serverPath = path.join(Global.Path.bin, "vscode-eslint", "server", "out", "eslintServer.js")
    if (!(yield* fsu.existsSafe(serverPath))) {
      if (flags.disableLspDownload) return Option.none()
      const zipPath = path.join(Global.Path.bin, "vscode-eslint.zip")
      if (!(yield* download("https://github.com/microsoft/vscode-eslint/archive/refs/heads/main.zip", zipPath)))
        return Option.none()
      if (!(yield* unzip(zipPath, Global.Path.bin))) return Option.none()
      yield* fsu.remove(zipPath, { force: true })

      const extractedPath = path.join(Global.Path.bin, "vscode-eslint-main")
      const finalPath = path.join(Global.Path.bin, "vscode-eslint")
      if (Option.isSome(yield* Effect.option(fsu.stat(finalPath)))) {
        yield* fsu.remove(finalPath, { force: true, recursive: true })
      }
      yield* fsu.rename(extractedPath, finalPath)

      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
      yield* attempt("Could not install vscode-eslint", () => Process.run([npmCmd, "install"], { cwd: finalPath }))
      yield* attempt("Could not compile vscode-eslint", () =>
        Process.run([npmCmd, "run", "compile"], { cwd: finalPath }),
      )
    }

    return yield* start("node", [serverPath, "--stdio"], { cwd: root, env: { ...process.env } })
  }),
}

export const Oxlint: Info = {
  id: "oxlint",
  root: NearestRoot([
    ".oxlintrc.json",
    "package-lock.json",
    "bun.lockb",
    "bun.lock",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package.json",
  ]),
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".astro", ".svelte"],
  spawn: Effect.fnUntraced(function* (root, ctx) {
    const ext = process.platform === "win32" ? ".cmd" : ""

    // A project binary at or above the root, else the command on PATH.
    const resolveBin = Effect.fnUntraced(function* (target: string, command: string) {
      const local = yield* nearest([target], root, ctx.worktree)
      if (Option.isSome(local)) return local
      return yield* which(command)
    })

    const lintBin = yield* resolveBin(path.join("node_modules", ".bin", "oxlint" + ext), "oxlint")
    if (Option.isSome(lintBin)) {
      const proc = yield* spawn(lintBin.value, ["--help"])
      yield* attempt("Could not run oxlint --help", () => proc.exited)
      const help = yield* attempt("Could not read oxlint --help", () => text(proc.stdout))
      if (help.includes("--lsp")) return yield* start(lintBin.value, ["--lsp"], { cwd: root })
    }

    const serverBin = yield* resolveBin(
      path.join("node_modules", ".bin", "oxc_language_server" + ext),
      "oxc_language_server",
    )
    if (Option.isNone(serverBin)) return Option.none()
    return yield* start(serverBin.value, [], { cwd: root })
  }),
}

export const Biome: Info = {
  id: "biome",
  root: NearestRoot([
    "biome.json",
    "biome.jsonc",
    "package-lock.json",
    "bun.lockb",
    "bun.lock",
    "pnpm-lock.yaml",
    "yarn.lock",
  ]),
  extensions: [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".json",
    ".jsonc",
    ".vue",
    ".astro",
    ".svelte",
    ".css",
    ".graphql",
    ".gql",
    ".html",
  ],
  spawn: Effect.fnUntraced(function* (root) {
    const fsu = yield* FSUtil.Service
    const args = ["lsp-proxy", "--stdio"]
    const options = { cwd: root, env: { ...process.env } }

    const localBin = path.join(root, "node_modules", ".bin", "biome")
    if (yield* fsu.existsSafe(localBin)) return yield* start(localBin, args, options)
    const found = yield* which("biome")
    if (Option.isSome(found)) return yield* start(found.value, args, options)

    if (!Module.resolve("biome", root)) return Option.none()
    const bin = yield* npmWhich("biome")
    if (Option.isNone(bin)) return Option.none()
    return yield* start(bin.value, args, options)
  }),
}

export const Gopls: Info = {
  id: "gopls",
  root: (file, ctx) =>
    Effect.gen(function* () {
      const work = yield* NearestRoot(["go.work"])(file, ctx)
      if (Option.isSome(work)) return work
      return yield* NearestRoot(["go.mod", "go.sum"])(file, ctx)
    }),
  extensions: [".go"],
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const found = yield* which("gopls")
    if (Option.isSome(found)) return yield* start(found.value, [], { cwd: root })
    if (Option.isNone(yield* which("go"))) return Option.none()
    if (flags.disableLspDownload) return Option.none()

    const exit = yield* install(["go", "install", "golang.org/x/tools/gopls@latest"], {
      env: { ...process.env, GOBIN: Global.Path.bin },
    })
    if (exit !== 0) return Option.none()
    const bin = path.join(Global.Path.bin, "gopls" + (process.platform === "win32" ? ".exe" : ""))
    return yield* start(bin, [], { cwd: root })
  }),
}

export const Rubocop: Info = {
  id: "ruby-lsp",
  root: NearestRoot(["Gemfile"]),
  extensions: [".rb", ".rake", ".gemspec", ".ru"],
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const found = yield* which("rubocop")
    if (Option.isSome(found)) return yield* start(found.value, ["--lsp"], { cwd: root })
    const ruby = yield* which("ruby")
    const gem = yield* which("gem")
    if (Option.isNone(ruby) || Option.isNone(gem)) return Option.none()
    if (flags.disableLspDownload) return Option.none()

    const exit = yield* install(["gem", "install", "rubocop", "--bindir", Global.Path.bin])
    if (exit !== 0) return Option.none()
    const bin = path.join(Global.Path.bin, "rubocop" + (process.platform === "win32" ? ".exe" : ""))
    return yield* start(bin, ["--lsp"], { cwd: root })
  }),
}

// The virtual environments to search: the active one first, then the project ones.
const venvPaths = (root: string) =>
  readEnvSnapshot(Config.option(Config.String("VIRTUAL_ENV"))).pipe(
    Effect.map((active) => [...Option.toArray(active), path.join(root, ".venv"), path.join(root, "venv")]),
  )

const venvExecutable = (venv: string, name: string) =>
  process.platform === "win32" ? path.join(venv, "Scripts", `${name}.exe`) : path.join(venv, "bin", name)

// Points the server at the Python of the first virtual environment that has one.
const pythonInitialization = Effect.fnUntraced(function* (venvs: ReadonlyArray<string>) {
  const python = yield* firstExisting(venvs.map((venv) => venvExecutable(venv, "python")))
  return Option.match(python, {
    onNone: (): Record<string, string> => ({}),
    onSome: (pythonPath): Record<string, string> => ({ pythonPath }),
  })
})

export const Ty: Info = {
  id: "ty",
  extensions: [".py", ".pyi"],
  root: NearestRoot([
    "pyproject.toml",
    "ty.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "Pipfile",
    "pyrightconfig.json",
  ]),
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    if (!flags.experimentalLspTy) return Option.none()

    const onPath = yield* which("ty")
    const venvs = yield* venvPaths(root)
    const initialization = yield* pythonInitialization(venvs)
    const binary = Option.isSome(onPath)
      ? onPath
      : yield* firstExisting(venvs.map((venv) => venvExecutable(venv, "ty")))
    if (Option.isNone(binary)) return Option.none()

    return yield* start(binary.value, ["server"], { cwd: root }, initialization)
  }),
}

export const Pyright: Info = {
  id: "pyright",
  extensions: [".py", ".pyi"],
  root: NearestRoot(["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"]),
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const binary = yield* findBinary("pyright-langserver", flags, "pyright", "pyright-langserver")
    if (Option.isNone(binary)) return Option.none()
    const initialization = yield* pythonInitialization(yield* venvPaths(root))
    return yield* start(binary.value, ["--stdio"], { cwd: root, env: { ...process.env } }, initialization)
  }),
}

export const ElixirLS: Info = {
  id: "elixir-ls",
  extensions: [".ex", ".exs"],
  root: NearestRoot(["mix.exs", "mix.lock"]),
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const found = yield* which("elixir-ls")
    if (Option.isSome(found)) return yield* start(found.value, [], { cwd: root })

    const fsu = yield* FSUtil.Service
    const binary = path.join(
      Global.Path.bin,
      "elixir-ls-master",
      "release",
      process.platform === "win32" ? "language_server.bat" : "language_server.sh",
    )
    if (!(yield* fsu.existsSafe(binary))) {
      if (Option.isNone(yield* which("elixir"))) return Option.none()
      if (flags.disableLspDownload) return Option.none()

      const zipPath = path.join(Global.Path.bin, "elixir-ls.zip")
      if (!(yield* download("https://github.com/elixir-lsp/elixir-ls/archive/refs/heads/master.zip", zipPath)))
        return Option.none()
      if (!(yield* unzip(zipPath, Global.Path.bin))) return Option.none()
      yield* fsu.remove(zipPath, { force: true, recursive: true })

      const cwd = path.join(Global.Path.bin, "elixir-ls-master")
      const env = { MIX_ENV: "prod", ...process.env }
      yield* attempt("Could not fetch the elixir-ls dependencies", () => Process.run(["mix", "deps.get"], { cwd, env }))
      yield* attempt("Could not compile elixir-ls", () => Process.run(["mix", "compile"], { cwd, env }))
      yield* attempt("Could not release elixir-ls", () =>
        Process.run(["mix", "elixir_ls.release2", "-o", "release"], { cwd, env }),
      )
    }

    return yield* start(binary, [], { cwd: root })
  }),
}

export const Zls: Info = {
  id: "zls",
  extensions: [".zig", ".zon"],
  root: NearestRoot(["build.zig"]),
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const found = yield* which("zls")
    if (Option.isSome(found)) return yield* start(found.value, [], { cwd: root })
    if (Option.isNone(yield* which("zig"))) return Option.none()
    if (flags.disableLspDownload) return Option.none()

    const release = yield* fetchJson("https://api.github.com/repos/zigtools/zls/releases/latest", decodeGithubRelease)
    if (Option.isNone(release)) return Option.none()

    const platform = process.platform
    const arch = process.arch
    const zlsArch = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch === "ia32" ? "x86" : arch
    const zlsPlatform = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform
    const ext = platform === "win32" ? "zip" : "tar.xz"
    const assetName = `zls-${zlsArch}-${zlsPlatform}.${ext}`

    const supportedCombos = [
      "zls-x86_64-linux.tar.xz",
      "zls-x86_64-macos.tar.xz",
      "zls-x86_64-windows.zip",
      "zls-aarch64-linux.tar.xz",
      "zls-aarch64-macos.tar.xz",
      "zls-aarch64-windows.zip",
      "zls-x86-linux.tar.xz",
      "zls-x86-windows.zip",
    ]
    if (!supportedCombos.includes(assetName)) return Option.none()

    const asset = release.value.assets?.find((a) => a.name === assetName)
    if (!asset?.browser_download_url) return Option.none()

    const fsu = yield* FSUtil.Service
    const tempPath = path.join(Global.Path.bin, assetName)
    if (!(yield* download(asset.browser_download_url, tempPath))) return Option.none()
    if (ext === "zip" && !(yield* unzip(tempPath, Global.Path.bin))) return Option.none()
    if (ext !== "zip") yield* run(["tar", "-xf", tempPath], { cwd: Global.Path.bin })
    yield* fsu.remove(tempPath, { force: true })

    const bin = path.join(Global.Path.bin, "zls" + (platform === "win32" ? ".exe" : ""))
    if (!(yield* fsu.existsSafe(bin))) return Option.none()
    yield* makeExecutable(bin)
    return yield* start(bin, [], { cwd: root })
  }),
}

export const CSharp: Info = {
  id: "csharp",
  root: NearestRoot([".slnx", ".sln", ".csproj", "global.json"]),
  extensions: [".cs", ".csx"],
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const bin = yield* getRoslynLanguageServer(flags.disableLspDownload)
    if (Option.isNone(bin)) return Option.none()
    return yield* start(bin.value, ["--stdio", "--autoLoadProjects"], { cwd: root })
  }),
}

export const Razor: Info = {
  id: "razor",
  root: NearestRoot([".slnx", ".sln", ".csproj", "global.json"]),
  extensions: [".razor", ".cshtml"],
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const bin = yield* getRoslynLanguageServer(flags.disableLspDownload)
    if (Option.isNone(bin)) return Option.none()

    const razor = yield* findVscodeRazorExtension
    if (Option.isNone(razor)) return Option.none()

    return yield* start(
      bin.value,
      [
        "--stdio",
        "--autoLoadProjects",
        `--razorSourceGenerator=${razor.value.compiler}`,
        `--razorDesignTimePath=${razor.value.targets}`,
        "--extension",
        razor.value.extension,
      ],
      { cwd: root },
    )
  }),
}

// One lookup or install at a time, so concurrent C# and Razor spawns share one dotnet tool install.
// A caller that waited finds the finished install on PATH.
const roslynInstall = Semaphore.makeUnsafe(1)

const getRoslynLanguageServer = (disableLspDownload: boolean) =>
  Semaphore.withPermit(
    roslynInstall,
    Effect.gen(function* () {
      const existing = yield* which("roslyn-language-server")
      if (Option.isSome(existing)) return existing

      const global = yield* roslynLanguageServerGlobalPath
      if (Option.isSome(global)) return global

      return yield* installRoslynLanguageServer(disableLspDownload)
    }),
  )

const installRoslynLanguageServer = Effect.fnUntraced(function* (disableLspDownload: boolean) {
  if (Option.isNone(yield* which("dotnet"))) return Option.none<string>()
  if (disableLspDownload) return Option.none<string>()

  const exit = yield* install(["dotnet", "tool", "install", "--global", "roslyn-language-server", "--prerelease"])
  if (exit !== 0) return Option.none<string>()

  const resolved = yield* which("roslyn-language-server")
  if (Option.isSome(resolved)) return resolved
  return yield* roslynLanguageServerGlobalPath
})

const roslynLanguageServerGlobalPath = Effect.gen(function* () {
  const home = yield* readEnvSnapshot(Config.option(Config.String("DOTNET_CLI_HOME")))
  const bin = path.join(
    Option.getOrElse(home, () => os.homedir()),
    ".dotnet",
    "tools",
    "roslyn-language-server" + (process.platform === "win32" ? ".cmd" : ""),
  )
  const fsu = yield* FSUtil.Service
  return (yield* fsu.existsSafe(bin)) ? Option.some(bin) : Option.none<string>()
})

const razorFiles = (extensionPath: string) => ({
  compiler: path.join(extensionPath, "Microsoft.CodeAnalysis.Razor.Compiler.dll"),
  targets: path.join(extensionPath, "Targets", "Microsoft.NET.Sdk.Razor.DesignTime.targets"),
  extension: path.join(extensionPath, "Microsoft.VisualStudioCode.RazorExtension.dll"),
})

// The newest C# extension in one extensions folder whose Razor files all exist.
const razorExtensionIn = Effect.fnUntraced(function* (root: string) {
  const fsu = yield* FSUtil.Service
  const entries = yield* fsu.readDirectoryEntries(root).pipe(Effect.orElseSucceed(() => []))
  const candidates = yield* Effect.forEach(
    entries.filter((entry) => entry.type === "directory" && entry.name.startsWith("ms-dotnettools.csharp-")),
    (entry) =>
      fsu.stat(path.join(root, entry.name)).pipe(
        Effect.map((info) => Option.getOrElse(Option.map(info.mtime, (date) => date.getTime()), () => 0)),
        Effect.orElseSucceed(() => 0),
        Effect.map((modified) => ({ files: razorFiles(path.join(root, entry.name, ".razorExtension")), modified })),
      ),
    { concurrency: "unbounded" },
  )
  const newestFirst = candidates.toSorted((a, b) => b.modified - a.modified).map((candidate) => candidate.files)
  return yield* Effect.findFirst(newestFirst, (files) =>
    firstMissing([files.compiler, files.targets, files.extension]).pipe(Effect.map(Option.isNone)),
  )
})

const firstMissing = Effect.fnUntraced(function* (files: ReadonlyArray<string>) {
  const fsu = yield* FSUtil.Service
  return yield* Effect.findFirst(files, (file) => fsu.existsSafe(file).pipe(Effect.map((exists) => !exists)))
})

const findVscodeRazorExtension = Effect.gen(function* () {
  const custom = yield* readEnvSnapshot(Config.option(Config.String("VSCODE_EXTENSIONS")))
  const roots = Array.dedupe([
    ...Option.toArray(custom),
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".vscode-insiders", "extensions"),
    path.join(os.homedir(), ".vscode-server", "extensions"),
    path.join(os.homedir(), ".vscode-server-insiders", "extensions"),
  ])

  for (const root of roots) {
    const found = yield* razorExtensionIn(root)
    if (Option.isSome(found)) return found
  }
  return Option.none<ReturnType<typeof razorFiles>>()
})

export const FSharp: Info = {
  id: "fsharp",
  root: NearestRoot([".slnx", ".sln", ".fsproj", "global.json"]),
  extensions: [".fs", ".fsi", ".fsx", ".fsscript"],
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const found = yield* which("fsautocomplete")
    if (Option.isSome(found)) return yield* start(found.value, [], { cwd: root })
    if (Option.isNone(yield* which("dotnet"))) return Option.none()
    if (flags.disableLspDownload) return Option.none()

    const exit = yield* install(["dotnet", "tool", "install", "fsautocomplete", "--tool-path", Global.Path.bin])
    if (exit !== 0) return Option.none()
    const bin = path.join(Global.Path.bin, "fsautocomplete" + (process.platform === "win32" ? ".exe" : ""))
    return yield* start(bin, [], { cwd: root })
  }),
}

export const SourceKit: Info = {
  id: "sourcekit-lsp",
  extensions: [".swift", ".objc", "objcpp"],
  root: NearestRoot(["Package.swift", "*.xcodeproj", "*.xcworkspace"]),
  spawn: Effect.fnUntraced(function* (root) {
    // The Swift toolchain installs sourcekit-lsp on PATH.
    const sourcekit = yield* which("sourcekit-lsp")
    if (Option.isSome(sourcekit)) return yield* start(sourcekit.value, [], { cwd: root })

    // On macOS, Xcode installs sourcekit-lsp, and xcrun finds it.
    if (Option.isNone(yield* which("xcrun"))) return Option.none()
    const lspLoc = yield* output(["xcrun", "--find", "sourcekit-lsp"])
    if (lspLoc.code !== 0) return Option.none()
    return yield* start(lspLoc.text.trim(), [], { cwd: root })
  }),
}

// The nearest Cargo workspace at or above `dir` that stays inside the worktree.
const cargoWorkspace = (dir: string, worktree: string): Effect.Effect<Option.Option<string>, never, FSUtil.Service> =>
  Effect.gen(function* () {
    const parent = path.dirname(dir)
    if (parent === dir) return Option.none()
    const fsu = yield* FSUtil.Service
    // A missing or unreadable manifest does not stop the search.
    const manifest = yield* Effect.option(fsu.readFileString(path.join(dir, "Cargo.toml")))
    if (Option.isSome(manifest) && manifest.value.includes("[workspace]")) return Option.some(dir)
    if (!parent.startsWith(worktree)) return Option.none()
    return yield* cargoWorkspace(parent, worktree)
  })

export const RustAnalyzer: Info = {
  id: "rust",
  root: (file, ctx) =>
    Effect.gen(function* () {
      const crateRoot = yield* NearestRoot(["Cargo.toml", "Cargo.lock"])(file, ctx)
      if (Option.isNone(crateRoot)) return crateRoot
      const workspace = yield* cargoWorkspace(crateRoot.value, ctx.worktree)
      return Option.isSome(workspace) ? workspace : crateRoot
    }),
  extensions: [".rs"],
  spawn: Effect.fnUntraced(function* (root) {
    const bin = yield* which("rust-analyzer")
    if (Option.isNone(bin)) return Option.none()
    return yield* start(bin.value, [], { cwd: root })
  }),
}

export const Clangd: Info = {
  id: "clangd",
  root: NearestRoot(["compile_commands.json", "compile_flags.txt", ".clangd"]),
  extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"],
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const args = ["--background-index", "--clang-tidy"]
    const fromPath = yield* which("clangd")
    if (Option.isSome(fromPath)) return yield* start(fromPath.value, args, { cwd: root })

    const fsu = yield* FSUtil.Service
    const ext = process.platform === "win32" ? ".exe" : ""
    const direct = path.join(Global.Path.bin, "clangd" + ext)
    if (yield* fsu.existsSafe(direct)) return yield* start(direct, args, { cwd: root })

    const entries = yield* fsu.readDirectoryEntries(Global.Path.bin).pipe(Effect.orElseSucceed(() => []))
    const installed = yield* firstExisting(
      entries
        .filter((entry) => entry.type === "directory" && entry.name.startsWith("clangd_"))
        .map((entry) => path.join(Global.Path.bin, entry.name, "bin", "clangd" + ext)),
    )
    if (Option.isSome(installed)) return yield* start(installed.value, args, { cwd: root })

    if (flags.disableLspDownload) return Option.none()

    const release = yield* fetchJson("https://api.github.com/repos/clangd/clangd/releases/latest", decodeGithubRelease)
    if (Option.isNone(release)) return Option.none()

    const tag = release.value.tag_name
    if (!tag) return Option.none()
    const platform = process.platform
    const tokens: Record<string, string> = {
      darwin: "mac",
      linux: "linux",
      win32: "windows",
    }
    const token = tokens[platform]
    if (!token) return Option.none()

    const assets = release.value.assets ?? []
    const valid = (item: (typeof assets)[number]) => {
      if (!item.name) return false
      if (!item.browser_download_url) return false
      if (!item.name.includes(token)) return false
      return item.name.includes(tag)
    }

    const asset =
      assets.find((item) => valid(item) && item.name?.endsWith(".zip")) ??
      assets.find((item) => valid(item) && item.name?.endsWith(".tar.xz")) ??
      assets.find((item) => valid(item))
    if (!asset?.name || !asset.browser_download_url) return Option.none()

    const name = asset.name
    const downloadResponse = yield* fetchOk(asset.browser_download_url)
    if (Option.isNone(downloadResponse)) return Option.none()

    const archive = path.join(Global.Path.bin, name)
    const buf = yield* attempt(`Could not read ${name}`, () => downloadResponse.value.arrayBuffer())
    if (buf.byteLength === 0) return Option.none()
    yield* fsu.writeWithDirs(archive, new Uint8Array(buf))

    const zip = name.endsWith(".zip")
    const tar = name.endsWith(".tar.xz")
    if (!zip && !tar) return Option.none()
    if (zip && !(yield* unzip(archive, Global.Path.bin))) return Option.none()
    if (tar) yield* run(["tar", "-xf", archive], { cwd: Global.Path.bin })
    yield* fsu.remove(archive, { force: true })

    const bin = path.join(Global.Path.bin, "clangd_" + tag, "bin", "clangd" + ext)
    if (!(yield* fsu.existsSafe(bin))) return Option.none()
    yield* makeExecutable(bin)

    const link = path.join(Global.Path.bin, "clangd")
    yield* fsu.remove(link).pipe(Effect.ignore)
    yield* fsu.symlink(bin, link).pipe(Effect.ignore)

    return yield* start(bin, args, { cwd: root })
  }),
}

export const Svelte: Info = {
  id: "svelte",
  extensions: [".svelte"],
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const binary = yield* findBinary("svelteserver", flags, "svelte-language-server")
    if (Option.isNone(binary)) return Option.none()
    return yield* start(binary.value, ["--stdio"], { cwd: root, env: { ...process.env } }, {})
  }),
}

export const Astro: Info = {
  id: "astro",
  extensions: [".astro"],
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  spawn: Effect.fnUntraced(function* (root, ctx, flags) {
    const tsserver = Module.resolve("typescript/lib/tsserver.js", ctx.directory)
    if (!tsserver) return Option.none()
    const tsdk = path.dirname(tsserver)

    const binary = yield* findBinary("astro-ls", flags, "@astrojs/language-server")
    if (Option.isNone(binary)) return Option.none()
    return yield* start(
      binary.value,
      ["--stdio"],
      { cwd: root, env: { ...process.env } },
      { typescript: { tsdk } },
    )
  }),
}

function isModuleOf(pomContent: string, modulePath: string): boolean {
  const normalized = modulePath.replace(/\\/g, "/").replace(/\/$/, "")
  if (!normalized) return false
  const modulesBlocks = pomContent.match(/<modules>([\s\S]*?)<\/modules>/g) ?? []
  for (const block of modulesBlocks) {
    const stripped = block.replace(/<!--[\s\S]*?-->/g, "")
    for (const m of stripped.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
      const decl = m[1].replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "")
      if (decl === normalized) return true
    }
  }
  return false
}

// Follows the <module> declarations from the nearest pom.xml up to the top-level project.
const mavenRoot = Effect.fnUntraced(function* (pomFiles: ReadonlyArray<string>) {
  const fsu = yield* FSUtil.Service
  let root = path.dirname(pomFiles[0])
  for (const pom of pomFiles.slice(1)) {
    const parentDir = path.dirname(pom)
    const content = yield* Effect.option(fsu.readFileString(pom))
    if (Option.isNone(content) || !isModuleOf(content.value, path.relative(parentDir, root))) break
    root = parentDir
  }
  return root
})

export const JDTLS: Info = {
  id: "jdtls",
  root: (file, ctx) =>
    Effect.gen(function* () {
      const settingsMarkers = ["settings.gradle", "settings.gradle.kts"]
      const gradleMarkers = ["gradlew", "gradlew.bat"]
      // 1. Gradle (unchanged from original logic)
      const [wrapperRoot, settingsRoot] = yield* Effect.all(
        [StrictNearestRoot(gradleMarkers, settingsMarkers)(file, ctx), StrictNearestRoot(settingsMarkers)(file, ctx)],
        { concurrency: "unbounded" },
      )
      if (Option.isSome(wrapperRoot)) return wrapperRoot
      if (Option.isSome(settingsRoot)) return settingsRoot

      // 2. Gradle single-project fallback (build.gradle without settings.gradle)
      const buildRoot = yield* StrictNearestRoot(["build.gradle", "build.gradle.kts"])(file, ctx)
      if (Option.isSome(buildRoot)) return buildRoot

      // 3. Maven: walk up pom.xml chain verifying <module> relationships
      const pomFiles = yield* everyUp("pom.xml", path.dirname(file), ctx.directory)
      if (pomFiles.length > 0) return Option.some(yield* mavenRoot(pomFiles))

      // 4. Eclipse native project fallback
      return yield* StrictNearestRoot([".project", ".classpath"])(file, ctx)
    }),
  extensions: [".java"],
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const java = yield* which("java")
    if (Option.isNone(java)) return Option.none()
    const version = yield* run(["java", "-version"])
    const javaMajorVersion = Option.fromNullishOr(/"(\d+)\.\d+\.\d+"/.exec(version.stderr.toString())).pipe(
      Option.map((m) => parseInt(m[1])),
    )
    if (Option.isNone(javaMajorVersion) || javaMajorVersion.value < 21) return Option.none()

    const fsu = yield* FSUtil.Service
    const distPath = path.join(Global.Path.bin, "jdtls")
    const launcherDir = path.join(distPath, "plugins")
    if (!(yield* fsu.existsSafe(launcherDir))) {
      if (flags.disableLspDownload) return Option.none()
      yield* fsu.makeDirectory(distPath, { recursive: true })
      const releaseURL =
        "https://www.eclipse.org/downloads/download.php?file=/jdtls/snapshots/jdt-language-server-latest.tar.gz"
      const archiveName = "release.tar.gz"

      if (!(yield* download(releaseURL, path.join(distPath, archiveName)))) return Option.none()
      const tarResult = yield* run(["tar", "-xzf", archiveName], { cwd: distPath })
      if (tarResult.code !== 0) return Option.none()
      yield* fsu.remove(path.join(distPath, archiveName), { force: true })
    }

    const launchers = yield* fsu.readDirectory(launcherDir).pipe(Effect.orElseSucceed(() => []))
    const jarFileName = launchers.find((item) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(item))?.trim() ?? ""
    const launcherJar = path.join(launcherDir, jarFileName)
    if (!(yield* fsu.existsSafe(launcherJar))) return Option.none()

    const configFile = path.join(
      distPath,
      (() => {
        switch (process.platform) {
          case "darwin":
            return "config_mac"
          case "linux":
            return "config_linux"
          case "win32":
            return "config_win"
          default:
            return "config_linux"
        }
      })(),
    )
    const dataDir = yield* fsu.makeTempDirectory({ prefix: "opencode-jdtls-data" })
    return yield* start(
      java.value,
      [
        "-jar",
        launcherJar,
        "-configuration",
        configFile,
        "-data",
        dataDir,
        "-Declipse.application=org.eclipse.jdt.ls.core.id1",
        "-Dosgi.bundles.defaultStartLevel=4",
        "-Declipse.product=org.eclipse.jdt.ls.core.product",
        "-Dlog.level=ALL",
        "--add-modules=ALL-SYSTEM",
        "--add-opens java.base/java.util=ALL-UNNAMED",
        "--add-opens java.base/java.lang=ALL-UNNAMED",
      ],
      { cwd: root },
    )
  }),
}

export const KotlinLS: Info = {
  id: "kotlin-ls",
  extensions: [".kt", ".kts"],
  root: (file, ctx) =>
    Effect.gen(function* () {
      // 1) Nearest Gradle root (multi-project or included build)
      const settingsRoot = yield* NearestRoot(["settings.gradle.kts", "settings.gradle"])(file, ctx)
      if (Option.isSome(settingsRoot)) return settingsRoot
      // 2) Gradle wrapper (strong root signal)
      const wrapperRoot = yield* NearestRoot(["gradlew", "gradlew.bat"])(file, ctx)
      if (Option.isSome(wrapperRoot)) return wrapperRoot
      // 3) Single-project or module-level build
      const buildRoot = yield* NearestRoot(["build.gradle.kts", "build.gradle"])(file, ctx)
      if (Option.isSome(buildRoot)) return buildRoot
      // 4) Maven fallback
      return yield* NearestRoot(["pom.xml"])(file, ctx)
    }),
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const fsu = yield* FSUtil.Service
    const distPath = path.join(Global.Path.bin, "kotlin-ls")
    const launcherScript =
      process.platform === "win32" ? path.join(distPath, "kotlin-lsp.cmd") : path.join(distPath, "kotlin-lsp.sh")
    if (!(yield* fsu.existsSafe(launcherScript))) {
      if (flags.disableLspDownload) return Option.none()

      const release = yield* fetchJson(
        "https://api.github.com/repos/Kotlin/kotlin-lsp/releases/latest",
        decodeGithubRelease,
      )
      if (Option.isNone(release)) return Option.none()
      const version = release.value.name?.replace(/^v/, "")
      if (!version) return Option.none()

      const platform = process.platform
      const arch = process.arch
      const kotlinArch = arch === "arm64" ? "aarch64" : arch
      const kotlinPlatform = platform === "darwin" ? "mac" : platform === "win32" ? "win" : platform
      const supportedCombos = ["mac-x64", "mac-aarch64", "linux-x64", "linux-aarch64", "win-x64", "win-aarch64"]
      if (!supportedCombos.includes(`${kotlinPlatform}-${kotlinArch}`)) return Option.none()

      const assetName = `kotlin-lsp-${version}-${kotlinPlatform}-${kotlinArch}.zip`
      const releaseURL = `https://download-cdn.jetbrains.com/kotlin-lsp/${version}/${assetName}`

      yield* fsu.makeDirectory(distPath, { recursive: true })
      const archivePath = path.join(distPath, "kotlin-ls.zip")
      if (!(yield* download(releaseURL, archivePath))) return Option.none()
      if (!(yield* unzip(archivePath, distPath))) return Option.none()
      yield* fsu.remove(archivePath, { force: true })
      yield* makeExecutable(launcherScript)
    }
    if (!(yield* fsu.existsSafe(launcherScript))) return Option.none()
    return yield* start(launcherScript, ["--stdio"], { cwd: root })
  }),
}

export const YamlLS: Info = {
  id: "yaml-ls",
  extensions: [".yaml", ".yml"],
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const binary = yield* findBinary("yaml-language-server", flags, "yaml-language-server")
    if (Option.isNone(binary)) return Option.none()
    return yield* start(binary.value, ["--stdio"], { cwd: root, env: { ...process.env } })
  }),
}

export const LuaLS: Info = {
  id: "lua-ls",
  root: NearestRoot([
    ".luarc.json",
    ".luarc.jsonc",
    ".luacheckrc",
    ".stylua.toml",
    "stylua.toml",
    "selene.toml",
    "selene.yml",
  ]),
  extensions: [".lua"],
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const found = yield* which("lua-language-server")
    if (Option.isSome(found)) return yield* start(found.value, [], { cwd: root })
    if (flags.disableLspDownload) return Option.none()

    const release = yield* fetchJson(
      "https://api.github.com/repos/LuaLS/lua-language-server/releases/latest",
      decodeGithubRelease,
    )
    if (Option.isNone(release)) return Option.none()
    const tag = release.value.tag_name
    if (!tag) return Option.none()

    // The release assets use the Node platform and architecture names.
    const platform = process.platform
    const arch = process.arch
    const ext = platform === "win32" ? "zip" : "tar.gz"
    const assetName = `lua-language-server-${tag}-${platform}-${arch}.${ext}`

    const supportedCombos = [
      "darwin-arm64.tar.gz",
      "darwin-x64.tar.gz",
      "linux-x64.tar.gz",
      "linux-arm64.tar.gz",
      "win32-x64.zip",
      "win32-ia32.zip",
    ]
    if (!supportedCombos.includes(`${platform}-${arch}.${ext}`)) return Option.none()

    const asset = release.value.assets?.find((a) => a.name === assetName)
    if (!asset?.browser_download_url) return Option.none()

    const fsu = yield* FSUtil.Service
    const tempPath = path.join(Global.Path.bin, assetName)
    if (!(yield* download(asset.browser_download_url, tempPath))) return Option.none()

    // Unlike zls, which is a single self-contained binary, lua-language-server needs its
    // supporting files (meta/, locale/, and so on), so the whole archive goes into its own folder.
    const installDir = path.join(Global.Path.bin, `lua-language-server-${arch}-${platform}`)
    if (Option.isSome(yield* Effect.option(fsu.stat(installDir)))) {
      yield* fsu.remove(installDir, { force: true, recursive: true })
    }
    yield* fsu.makeDirectory(installDir, { recursive: true })

    const extracted =
      ext === "zip"
        ? yield* unzip(tempPath, installDir)
        : yield* run(["tar", "-xzf", tempPath, "-C", installDir]).pipe(
            Effect.map((result) => result.code === 0),
            Effect.orElseSucceed(() => false),
          )
    if (!extracted) return Option.none()
    yield* fsu.remove(tempPath, { force: true })

    // The binary is in the bin/ folder of the extracted archive.
    const bin = path.join(installDir, "bin", "lua-language-server" + (platform === "win32" ? ".exe" : ""))
    if (!(yield* fsu.existsSafe(bin))) return Option.none()
    if (platform !== "win32") {
      const executable = yield* fsu.chmod(bin, 0o755).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (!executable) return Option.none()
    }

    return yield* start(bin, [], { cwd: root })
  }),
}

export const PHPIntelephense: Info = {
  id: "php intelephense",
  extensions: [".php"],
  root: NearestRoot(["composer.json", "composer.lock", ".php-version"]),
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const binary = yield* findBinary("intelephense", flags, "intelephense")
    if (Option.isNone(binary)) return Option.none()
    return yield* start(
      binary.value,
      ["--stdio"],
      { cwd: root, env: { ...process.env } },
      { telemetry: { enabled: false } },
    )
  }),
}

export const Prisma: Info = {
  id: "prisma",
  extensions: [".prisma"],
  root: NearestRoot(["schema.prisma", "prisma/schema.prisma", "prisma"], ["package.json"]),
  spawn: Effect.fnUntraced(function* (root) {
    const prisma = yield* which("prisma")
    if (Option.isNone(prisma)) return Option.none()
    return yield* start(prisma.value, ["language-server"], { cwd: root })
  }),
}

export const Dart: Info = {
  id: "dart",
  extensions: [".dart"],
  root: NearestRoot(["pubspec.yaml", "analysis_options.yaml"]),
  spawn: Effect.fnUntraced(function* (root) {
    const dart = yield* which("dart")
    if (Option.isNone(dart)) return Option.none()
    return yield* start(dart.value, ["language-server", "--lsp"], { cwd: root })
  }),
}

export const Ocaml: Info = {
  id: "ocaml-lsp",
  extensions: [".ml", ".mli"],
  root: NearestRoot(["dune-project", "dune-workspace", ".merlin", "opam"]),
  spawn: Effect.fnUntraced(function* (root) {
    const bin = yield* which("ocamllsp")
    if (Option.isNone(bin)) return Option.none()
    return yield* start(bin.value, [], { cwd: root })
  }),
}

export const BashLS: Info = {
  id: "bash",
  extensions: [".sh", ".bash", ".zsh", ".ksh"],
  root: instanceRoot,
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const binary = yield* findBinary("bash-language-server", flags, "bash-language-server")
    if (Option.isNone(binary)) return Option.none()
    return yield* start(binary.value, ["start"], { cwd: root, env: { ...process.env } })
  }),
}

export const TerraformLS: Info = {
  id: "terraform",
  extensions: [".tf", ".tfvars"],
  root: NearestRoot([".terraform.lock.hcl", "terraform.tfstate", "*.tf"]),
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const initialization = {
      experimentalFeatures: {
        prefillRequiredFields: true,
        validateOnSave: true,
      },
    }
    const found = yield* which("terraform-ls")
    if (Option.isSome(found)) return yield* start(found.value, ["serve"], { cwd: root }, initialization)
    if (flags.disableLspDownload) return Option.none()

    const release = yield* fetchJson(
      "https://api.releases.hashicorp.com/v1/releases/terraform-ls/latest",
      decodeTerraformRelease,
    )
    if (Option.isNone(release)) return Option.none()

    const platform = process.platform
    const tfArch = process.arch === "arm64" ? "arm64" : "amd64"
    const tfPlatform = platform === "win32" ? "windows" : platform
    const build = release.value.builds?.find((b) => b.arch === tfArch && b.os === tfPlatform)
    if (!build?.url) return Option.none()

    const fsu = yield* FSUtil.Service
    const tempPath = path.join(Global.Path.bin, "terraform-ls.zip")
    if (!(yield* download(build.url, tempPath))) return Option.none()
    if (!(yield* unzip(tempPath, Global.Path.bin))) return Option.none()
    yield* fsu.remove(tempPath, { force: true })

    const bin = path.join(Global.Path.bin, "terraform-ls" + (platform === "win32" ? ".exe" : ""))
    if (!(yield* fsu.existsSafe(bin))) return Option.none()
    yield* makeExecutable(bin)
    return yield* start(bin, ["serve"], { cwd: root }, initialization)
  }),
}

export const TexLab: Info = {
  id: "texlab",
  extensions: [".tex", ".bib"],
  root: NearestRoot([".latexmkrc", "latexmkrc", ".texlabroot", "texlabroot"]),
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const found = yield* which("texlab")
    if (Option.isSome(found)) return yield* start(found.value, [], { cwd: root })
    if (flags.disableLspDownload) return Option.none()

    const release = yield* fetchJson(
      "https://api.github.com/repos/latex-lsp/texlab/releases/latest",
      decodeGithubRelease,
    )
    if (Option.isNone(release)) return Option.none()
    const version = release.value.tag_name?.replace("v", "")
    if (!version) return Option.none()

    const platform = process.platform
    const texArch = process.arch === "arm64" ? "aarch64" : "x86_64"
    const texPlatform = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux"
    const ext = platform === "win32" ? "zip" : "tar.gz"
    const assetName = `texlab-${texArch}-${texPlatform}.${ext}`

    const asset = release.value.assets?.find((a) => a.name === assetName)
    if (!asset?.browser_download_url) return Option.none()

    const fsu = yield* FSUtil.Service
    const tempPath = path.join(Global.Path.bin, assetName)
    if (!(yield* download(asset.browser_download_url, tempPath))) return Option.none()
    if (ext === "zip" && !(yield* unzip(tempPath, Global.Path.bin))) return Option.none()
    if (ext === "tar.gz") yield* run(["tar", "-xzf", tempPath], { cwd: Global.Path.bin })
    yield* fsu.remove(tempPath, { force: true })

    const bin = path.join(Global.Path.bin, "texlab" + (platform === "win32" ? ".exe" : ""))
    if (!(yield* fsu.existsSafe(bin))) return Option.none()
    yield* makeExecutable(bin)
    return yield* start(bin, [], { cwd: root })
  }),
}

export const DockerfileLS: Info = {
  id: "dockerfile",
  extensions: [".dockerfile", "Dockerfile"],
  root: instanceRoot,
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const binary = yield* findBinary("docker-langserver", flags, "dockerfile-language-server-nodejs")
    if (Option.isNone(binary)) return Option.none()
    return yield* start(binary.value, ["--stdio"], { cwd: root, env: { ...process.env } })
  }),
}

export const Gleam: Info = {
  id: "gleam",
  extensions: [".gleam"],
  root: NearestRoot(["gleam.toml"]),
  spawn: Effect.fnUntraced(function* (root) {
    const gleam = yield* which("gleam")
    if (Option.isNone(gleam)) return Option.none()
    return yield* start(gleam.value, ["lsp"], { cwd: root })
  }),
}

export const Clojure: Info = {
  id: "clojure-lsp",
  extensions: [".clj", ".cljs", ".cljc", ".edn"],
  root: NearestRoot(["deps.edn", "project.clj", "shadow-cljs.edn", "bb.edn", "build.boot"]),
  spawn: Effect.fnUntraced(function* (root) {
    const found = yield* which("clojure-lsp")
    const bin = Option.isNone(found) && process.platform === "win32" ? yield* which("clojure-lsp.exe") : found
    if (Option.isNone(bin)) return Option.none()
    return yield* start(bin.value, ["listen"], { cwd: root })
  }),
}

export const Nixd: Info = {
  id: "nixd",
  extensions: [".nix"],
  root: (file, ctx) =>
    Effect.gen(function* () {
      // First, look for flake.nix - the most reliable Nix project root indicator
      const flakeRoot = yield* NearestRoot(["flake.nix"])(file, ctx)
      if (Option.isSome(flakeRoot) && flakeRoot.value !== ctx.directory) return flakeRoot

      // If no flake.nix, fall back to git repository root
      if (ctx.worktree && ctx.worktree !== ctx.directory) return Option.some(ctx.worktree)

      // Finally, use the instance directory as fallback
      return Option.some(ctx.directory)
    }),
  spawn: Effect.fnUntraced(function* (root) {
    const nixd = yield* which("nixd")
    if (Option.isNone(nixd)) return Option.none()
    return yield* start(nixd.value, [], { cwd: root, env: { ...process.env } })
  }),
}

const tinymistTargets = {
  darwin: { platform: "apple-darwin", ext: "tar.gz" },
  win32: { platform: "pc-windows-msvc", ext: "zip" },
  linux: { platform: "unknown-linux-gnu", ext: "tar.gz" },
}

export const Tinymist: Info = {
  id: "tinymist",
  extensions: [".typ", ".typc"],
  root: NearestRoot(["typst.toml"]),
  spawn: Effect.fnUntraced(function* (root, _ctx, flags) {
    const found = yield* which("tinymist")
    if (Option.isSome(found)) return yield* start(found.value, [], { cwd: root })
    if (flags.disableLspDownload) return Option.none()

    const release = yield* fetchJson(
      "https://api.github.com/repos/Myriad-Dreamin/tinymist/releases/latest",
      decodeGithubRelease,
    )
    if (Option.isNone(release)) return Option.none()

    const platform = process.platform
    const tinymistArch = process.arch === "arm64" ? "aarch64" : "x86_64"
    const target =
      platform === "darwin" ? tinymistTargets.darwin : platform === "win32" ? tinymistTargets.win32 : tinymistTargets.linux
    const assetName = `tinymist-${tinymistArch}-${target.platform}.${target.ext}`

    const asset = release.value.assets?.find((a) => a.name === assetName)
    if (!asset?.browser_download_url) return Option.none()

    const fsu = yield* FSUtil.Service
    const tempPath = path.join(Global.Path.bin, assetName)
    if (!(yield* download(asset.browser_download_url, tempPath))) return Option.none()
    if (target.ext === "zip" && !(yield* unzip(tempPath, Global.Path.bin))) return Option.none()
    if (target.ext !== "zip") {
      yield* run(["tar", "-xzf", tempPath, "--strip-components=1"], { cwd: Global.Path.bin })
    }
    yield* fsu.remove(tempPath, { force: true })

    const bin = path.join(Global.Path.bin, "tinymist" + (platform === "win32" ? ".exe" : ""))
    if (!(yield* fsu.existsSafe(bin))) return Option.none()
    yield* makeExecutable(bin)
    return yield* start(bin, [], { cwd: root })
  }),
}

export const HLS: Info = {
  id: "haskell-language-server",
  extensions: [".hs", ".lhs"],
  root: NearestRoot(["stack.yaml", "cabal.project", "hie.yaml", "*.cabal"]),
  spawn: Effect.fnUntraced(function* (root) {
    const bin = yield* which("haskell-language-server-wrapper")
    if (Option.isNone(bin)) return Option.none()
    return yield* start(bin.value, ["--lsp"], { cwd: root })
  }),
}

export const JuliaLS: Info = {
  id: "julials",
  extensions: [".jl"],
  root: NearestRoot(["Project.toml", "Manifest.toml", "*.jl"]),
  spawn: Effect.fnUntraced(function* (root) {
    const julia = yield* which("julia")
    if (Option.isNone(julia)) return Option.none()
    return yield* start(
      julia.value,
      ["--startup-file=no", "--history-file=no", "-e", "using LanguageServer; runserver()"],
      { cwd: root },
    )
  }),
}
