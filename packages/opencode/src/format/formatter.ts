import { Npm } from "@opencode-ai/core/npm"
import { Effect, Option } from "effect"
import type { InstanceContext } from "../project/instance-context"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { which } from "@opencode-ai/core/util/which"

export interface Context extends Pick<InstanceContext, "directory" | "worktree"> {
  experimentalOxfmt: boolean
}

export interface Info {
  name: string
  environment?: Record<string, string>
  extensions: string[]
  /** Gives the command that formats a file, or None when the formatter is not available here. */
  enabled: (context: Context) => Effect.Effect<Option.Option<string[]>>
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface ComposerJson {
  require?: Record<string, string>
  "require-dev"?: Record<string, string>
}

// Gives the command for a binary on PATH, or None when the binary is not installed.
const onPath = (bin: string, ...args: string[]) =>
  which(bin).pipe(Effect.map(Option.map((match) => [match, ...args])))

// The Filesystem, Npm and Process helpers below are Promise APIs. A rejection is a defect,
// as it was when the enabled checks were async functions.
const findUp = (target: string, context: Context) =>
  Effect.promise(() => Filesystem.findUp(target, context.directory, context.worktree))

const readJson = <T>(file: string) => Effect.promise(() => Filesystem.readJson<T>(file))

const readText = (file: string) => Effect.promise(() => Filesystem.readText(file))

// Npm.which recovers every failure as a missing binary, so it does not reject.
const npmBin = (pkg: string) => Effect.promise(() => Npm.which(pkg)).pipe(Effect.map(Option.fromNullishOr))

export const gofmt: Info = {
  name: "gofmt",
  extensions: [".go"],
  enabled: () => onPath("gofmt", "-w", "$FILE"),
}

export const mix: Info = {
  name: "mix",
  extensions: [".ex", ".exs", ".eex", ".heex", ".leex", ".neex", ".sface"],
  enabled: () => onPath("mix", "format", "$FILE"),
}

export const prettier: Info = {
  name: "prettier",
  environment: {
    BUN_BE_BUN: "1",
  },
  extensions: [
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".vue",
    ".svelte",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".md",
    ".mdx",
    ".graphql",
    ".gql",
  ],
  enabled: Effect.fnUntraced(function* (context: Context) {
    const items = yield* findUp("package.json", context)
    for (const item of items) {
      const json = yield* readJson<PackageJson>(item)
      if (json.dependencies?.prettier || json.devDependencies?.prettier) {
        const bin = yield* npmBin("prettier")
        if (Option.isSome(bin)) return Option.some([bin.value, "--write", "$FILE"])
      }
    }
    return Option.none()
  }),
}

export const oxfmt: Info = {
  name: "oxfmt",
  environment: {
    BUN_BE_BUN: "1",
  },
  extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"],
  enabled: Effect.fnUntraced(function* (context: Context) {
    if (!context.experimentalOxfmt) return Option.none()
    const items = yield* findUp("package.json", context)
    for (const item of items) {
      const json = yield* readJson<PackageJson>(item)
      if (json.dependencies?.oxfmt || json.devDependencies?.oxfmt) {
        const bin = yield* npmBin("oxfmt")
        if (Option.isSome(bin)) return Option.some([bin.value, "$FILE"])
      }
    }
    return Option.none()
  }),
}

export const biome: Info = {
  name: "biome",
  environment: {
    BUN_BE_BUN: "1",
  },
  extensions: [
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".vue",
    ".svelte",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".md",
    ".mdx",
    ".graphql",
    ".gql",
  ],
  enabled: Effect.fnUntraced(function* (context: Context) {
    const configs = ["biome.json", "biome.jsonc"]
    for (const config of configs) {
      const found = yield* findUp(config, context)
      if (found.length > 0) {
        const bin = yield* npmBin("@biomejs/biome")
        if (Option.isSome(bin)) return Option.some([bin.value, "format", "--write", "$FILE"])
      }
    }
    return Option.none()
  }),
}

export const zig: Info = {
  name: "zig",
  extensions: [".zig", ".zon"],
  enabled: () => onPath("zig", "fmt", "$FILE"),
}

export const clang: Info = {
  name: "clang-format",
  extensions: [".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".h++", ".ino", ".C", ".H"],
  enabled: Effect.fnUntraced(function* (context: Context) {
    const items = yield* findUp(".clang-format", context)
    if (items.length === 0) return Option.none()
    return yield* onPath("clang-format", "-i", "$FILE")
  }),
}

export const ktlint: Info = {
  name: "ktlint",
  extensions: [".kt", ".kts"],
  enabled: () => onPath("ktlint", "-F", "$FILE"),
}

export const ruff: Info = {
  name: "ruff",
  extensions: [".py", ".pyi"],
  enabled: Effect.fnUntraced(function* (context: Context) {
    if (Option.isNone(yield* which("ruff"))) return Option.none()
    const configs = ["pyproject.toml", "ruff.toml", ".ruff.toml"]
    for (const config of configs) {
      const found = yield* findUp(config, context)
      if (found.length > 0) {
        if (config === "pyproject.toml") {
          const content = yield* readText(found[0])
          if (content.includes("[tool.ruff]")) return Option.some(["ruff", "format", "$FILE"])
        } else {
          return Option.some(["ruff", "format", "$FILE"])
        }
      }
    }
    const deps = ["requirements.txt", "pyproject.toml", "Pipfile"]
    for (const dep of deps) {
      const found = yield* findUp(dep, context)
      if (found.length > 0) {
        const content = yield* readText(found[0])
        if (content.includes("ruff")) return Option.some(["ruff", "format", "$FILE"])
      }
    }
    return Option.none()
  }),
}

export const rlang: Info = {
  name: "air",
  extensions: [".R"],
  enabled: Effect.fnUntraced(function* () {
    const air = yield* which("air")
    if (Option.isNone(air)) return Option.none()

    // Process.text with nothrow reports a spawn failure as a non-zero code, so it does not reject.
    const output = yield* Effect.promise(() => Process.text([air.value, "--help"], { nothrow: true }))

    // Check for "Air: An R language server and formatter"
    const firstLine = output.text.split("\n")[0]
    const hasR = firstLine.includes("R language")
    const hasFormatter = firstLine.includes("formatter")
    if (output.code === 0 && hasR && hasFormatter) return Option.some([air.value, "format", "$FILE"])
    return Option.none()
  }),
}

export const uvformat: Info = {
  name: "uv",
  extensions: [".py", ".pyi"],
  enabled: Effect.fnUntraced(function* (context: Context) {
    if (Option.isSome(yield* ruff.enabled(context))) return Option.none()
    const uv = yield* which("uv")
    if (Option.isNone(uv)) return Option.none()
    // Process.run with nothrow reports a spawn failure as a non-zero code, so it does not reject.
    const output = yield* Effect.promise(() => Process.run([uv.value, "format", "--help"], { nothrow: true }))
    if (output.code === 0) return Option.some([uv.value, "format", "--", "$FILE"])
    return Option.none()
  }),
}

export const rubocop: Info = {
  name: "rubocop",
  extensions: [".rb", ".rake", ".gemspec", ".ru"],
  enabled: () => onPath("rubocop", "--autocorrect", "$FILE"),
}

export const standardrb: Info = {
  name: "standardrb",
  extensions: [".rb", ".rake", ".gemspec", ".ru"],
  enabled: () => onPath("standardrb", "--fix", "$FILE"),
}

export const htmlbeautifier: Info = {
  name: "htmlbeautifier",
  extensions: [".erb", ".html.erb"],
  enabled: () => onPath("htmlbeautifier", "$FILE"),
}

export const dart: Info = {
  name: "dart",
  extensions: [".dart"],
  enabled: () => onPath("dart", "format", "$FILE"),
}

export const ocamlformat: Info = {
  name: "ocamlformat",
  extensions: [".ml", ".mli"],
  enabled: Effect.fnUntraced(function* (context: Context) {
    if (Option.isNone(yield* which("ocamlformat"))) return Option.none()
    const items = yield* findUp(".ocamlformat", context)
    if (items.length > 0) return Option.some(["ocamlformat", "-i", "$FILE"])
    return Option.none()
  }),
}

export const terraform: Info = {
  name: "terraform",
  extensions: [".tf", ".tfvars"],
  enabled: () => onPath("terraform", "fmt", "$FILE"),
}

export const latexindent: Info = {
  name: "latexindent",
  extensions: [".tex"],
  enabled: () => onPath("latexindent", "-w", "-s", "$FILE"),
}

export const gleam: Info = {
  name: "gleam",
  extensions: [".gleam"],
  enabled: () => onPath("gleam", "format", "$FILE"),
}

export const shfmt: Info = {
  name: "shfmt",
  extensions: [".sh", ".bash"],
  enabled: () => onPath("shfmt", "-w", "$FILE"),
}

export const nixfmt: Info = {
  name: "nixfmt",
  extensions: [".nix"],
  enabled: () => onPath("nixfmt", "$FILE"),
}

export const rustfmt: Info = {
  name: "rustfmt",
  extensions: [".rs"],
  enabled: () => onPath("rustfmt", "$FILE"),
}

export const pint: Info = {
  name: "pint",
  extensions: [".php"],
  enabled: Effect.fnUntraced(function* (context: Context) {
    const items = yield* findUp("composer.json", context)
    for (const item of items) {
      const json = yield* readJson<ComposerJson>(item)
      if (json.require?.["laravel/pint"] || json["require-dev"]?.["laravel/pint"])
        return Option.some(["./vendor/bin/pint", "$FILE"])
    }
    return Option.none()
  }),
}

export const ormolu: Info = {
  name: "ormolu",
  extensions: [".hs"],
  enabled: () => onPath("ormolu", "-i", "$FILE"),
}

export const cljfmt: Info = {
  name: "cljfmt",
  extensions: [".clj", ".cljs", ".cljc", ".edn"],
  enabled: () => onPath("cljfmt", "fix", "--quiet", "$FILE"),
}

export const dfmt: Info = {
  name: "dfmt",
  extensions: [".d"],
  enabled: () => onPath("dfmt", "-i", "$FILE"),
}
