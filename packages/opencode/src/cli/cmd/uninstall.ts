import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Array as Arr, Config, Effect, Option } from "effect"
import path from "path"
import os from "os"
import { AppProcess } from "@opencode-ai/core/process"
import { ChildProcess } from "effect/unstable/process"
import { makeRuntime } from "@/effect/run-service"
import * as Prompt from "../effect/prompt"

interface UninstallArgs {
  keepConfig: boolean
  keepData: boolean
  dryRun: boolean
  force: boolean
}

interface RemovalTargets {
  directories: Array<{ path: string; label: string; keep: boolean }>
  shellConfig: Option.Option<string>
  binary: Option.Option<string>
}

// uninstall removes the data directory, so it must not run under AppRuntime: AppRuntime opens the
// database in that directory, and an open file cannot be removed on Windows. The command needs
// only the filesystem service.
const { runPromise } = makeRuntime(FSUtil.Service, AppNodeBuilder.build(FSUtil.node))

export const UninstallCommand = {
  command: "uninstall",
  describe: "uninstall opencode and remove all related files",
  builder: (yargs: Argv) =>
    yargs
      .option("keep-config", {
        alias: "c",
        type: "boolean",
        describe: "keep configuration files",
        default: false,
      })
      .option("keep-data", {
        alias: "d",
        type: "boolean",
        describe: "keep session data and snapshots",
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "show what would be removed without removing",
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "skip confirmation prompts",
        default: false,
      }),

  handler: (args: UninstallArgs) => runPromise(() => uninstall(args)),
}

const uninstall = Effect.fn("Cli.uninstall")(function* (args: UninstallArgs) {
  yield* Effect.sync(() => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
  })
  yield* Prompt.intro("Uninstall OpenCode")

  const method = yield* Effect.promise(() => Installation.method())
  yield* Prompt.log.info(`Installation method: ${method}`)

  const targets = yield* collectRemovalTargets(args, method)

  yield* showRemovalSummary(targets, method)

  if (!args.force && !args.dryRun) {
    const confirm = yield* Effect.promise(() =>
      prompts.confirm({
        message: "Are you sure you want to uninstall?",
        initialValue: false,
      }),
    )
    if (!confirm || prompts.isCancel(confirm)) {
      yield* Prompt.outro("Cancelled")
      return
    }
  }

  if (args.dryRun) {
    yield* Prompt.log.warn("Dry run - no changes made")
    yield* Prompt.outro("Done")
    return
  }

  yield* executeUninstall(method, targets)

  yield* Prompt.outro("Done")
})

const collectRemovalTargets = Effect.fnUntraced(function* (args: UninstallArgs, method: Installation.Method) {
  const directories: RemovalTargets["directories"] = [
    { path: Global.Path.data, label: "Data", keep: args.keepData },
    { path: Global.Path.cache, label: "Cache", keep: false },
    { path: Global.Path.config, label: "Config", keep: args.keepConfig },
    { path: Global.Path.state, label: "State", keep: false },
  ]

  const shellConfig = method === "curl" ? yield* getShellConfigFile() : Option.none<string>()
  const binary = method === "curl" ? Option.some(process.execPath) : Option.none<string>()

  return { directories, shellConfig, binary } satisfies RemovalTargets
})

const showRemovalSummary = Effect.fnUntraced(function* (targets: RemovalTargets, method: Installation.Method) {
  const fs = yield* FSUtil.Service
  yield* Effect.sync(() => prompts.log.message("The following will be removed:"))

  for (const dir of targets.directories) {
    if (!(yield* fs.existsSafe(dir.path))) continue

    const size = yield* getDirectorySize(dir.path)
    const sizeStr = formatSize(size)
    const status = dir.keep ? UI.Style.TEXT_DIM + "(keeping)" : ""
    const prefix = dir.keep ? "○" : "✓"

    yield* Prompt.log.info(`  ${prefix} ${dir.label}: ${shortenPath(dir.path)} ${UI.Style.TEXT_DIM}(${sizeStr})${status}`)
  }

  if (Option.isSome(targets.binary)) {
    yield* Prompt.log.info(`  ✓ Binary: ${shortenPath(targets.binary.value)}`)
  }

  if (Option.isSome(targets.shellConfig)) {
    yield* Prompt.log.info(`  ✓ Shell PATH in ${shortenPath(targets.shellConfig.value)}`)
  }

  if (method !== "curl" && method !== "unknown") {
    const cmds: Record<string, string> = {
      npm: "npm uninstall -g opencode-ai",
      pnpm: "pnpm uninstall -g opencode-ai",
      bun: "bun remove -g opencode-ai",
      yarn: "yarn global remove opencode-ai",
      brew: "brew uninstall opencode",
      choco: "choco uninstall opencode",
      scoop: "scoop uninstall opencode",
    }
    yield* Prompt.log.info(`  ✓ Package: ${cmds[method] || method}`)
  }
})

// Each removal step reports its failure as Some(message), so the summary can list them afterwards.
const failureMessage = <E extends { readonly message: string }>(effect: Effect.Effect<void, E, FSUtil.Service>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => Option.some(error.message),
      onSuccess: () => Option.none<string>(),
    }),
  )

const removeDirectory = Effect.fnUntraced(function* (
  dir: RemovalTargets["directories"][number],
  spinner: ReturnType<typeof Prompt.spinner>,
) {
  const fs = yield* FSUtil.Service
  if (dir.keep) {
    yield* Effect.sync(() => prompts.log.step(`Skipping ${dir.label} (--keep-${dir.label.toLowerCase()})`))
    return Option.none<string>()
  }

  if (!(yield* fs.existsSafe(dir.path))) return Option.none<string>()

  yield* spinner.start(`Removing ${dir.label}...`)
  const failure = yield* failureMessage(fs.remove(dir.path, { recursive: true, force: true }))
  if (Option.isSome(failure)) {
    yield* spinner.stop(`Failed to remove ${dir.label}`, 1)
    return Option.some(`${dir.label}: ${failure.value}`)
  }
  yield* spinner.stop(`Removed ${dir.label}`)
  return Option.none<string>()
})

const cleanShellConfigStep = Effect.fnUntraced(function* (
  shellConfig: string,
  spinner: ReturnType<typeof Prompt.spinner>,
) {
  yield* spinner.start("Cleaning shell config...")
  const failure = yield* failureMessage(cleanShellConfig(shellConfig))
  if (Option.isSome(failure)) {
    yield* spinner.stop("Failed to clean shell config", 1)
    return Option.some(`Shell config: ${failure.value}`)
  }
  yield* spinner.stop("Cleaned shell config")
  return Option.none<string>()
})

const executeUninstall = Effect.fnUntraced(function* (method: Installation.Method, targets: RemovalTargets) {
  const spinner = Prompt.spinner()

  const directoryErrors = yield* Effect.forEach(targets.directories, (dir) => removeDirectory(dir, spinner))
  const shellError = Option.isSome(targets.shellConfig)
    ? yield* cleanShellConfigStep(targets.shellConfig.value, spinner)
    : Option.none<string>()
  const errors = Arr.getSomes(Arr.append(directoryErrors, shellError))

  if (method !== "curl" && method !== "unknown") {
    const cmds: Record<string, string[]> = {
      npm: ["npm", "uninstall", "-g", "opencode-ai"],
      pnpm: ["pnpm", "uninstall", "-g", "opencode-ai"],
      bun: ["bun", "remove", "-g", "opencode-ai"],
      yarn: ["yarn", "global", "remove", "opencode-ai"],
      brew: ["brew", "uninstall", "opencode"],
      choco: ["choco", "uninstall", "opencode"],
      scoop: ["scoop", "uninstall", "opencode"],
    }

    const cmd = cmds[method]
    if (cmd) {
      yield* spinner.start(`Running ${cmd.join(" ")}...`)
      const argv = method === "choco" ? ["choco", "uninstall", "opencode", "-y", "-r"] : cmd
      // A package manager that cannot start counts as a failed command, with exit code 1 and the
      // failure text as its output.
      const result = yield* AppProcess.Service.use((appProcess) =>
        appProcess.run(ChildProcess.make(argv[0], argv.slice(1), { stdin: "ignore" })),
      ).pipe(
        Effect.map((out) => ({
          code: out.exitCode,
          text: `${out.stdout.toString("utf8")}\n${out.stderr.toString("utf8")}`,
        })),
        Effect.catch((error) => Effect.succeed({ code: 1, text: `\n${error.message}` })),
        Effect.provide(AppNodeBuilder.build(AppProcess.node)),
      )
      if (result.code !== 0) {
        yield* spinner.stop(`Package manager uninstall failed: exit code ${result.code}`, 1)
        if (method === "choco" && result.text.includes("not running from an elevated command shell")) {
          yield* Prompt.log.warn(`You may need to run '${cmd.join(" ")}' from an elevated command shell`)
        } else {
          yield* Prompt.log.warn(`You may need to run manually: ${cmd.join(" ")}`)
        }
      } else {
        yield* spinner.stop("Package removed")
      }
    }
  }

  if (method === "curl" && Option.isSome(targets.binary)) {
    const binary = targets.binary.value
    yield* Effect.sync(() => {
      UI.empty()
      prompts.log.message("To finish removing the binary, run:")
    })
    yield* Prompt.log.info(`  rm "${binary}"`)

    const binDir = path.dirname(binary)
    if (binDir.includes(".opencode")) {
      yield* Prompt.log.info(`  rmdir "${binDir}" 2>/dev/null`)
    }
  }

  if (errors.length > 0) {
    yield* Effect.sync(() => UI.empty())
    yield* Prompt.log.warn("Some operations failed:")
    yield* Effect.forEach(errors, (err) => Prompt.log.error(`  ${err}`), { discard: true })
  }

  yield* Effect.sync(() => UI.empty())
  yield* Prompt.log.success("Thank you for using OpenCode!")
})

// Config.withDefault also covers an empty variable, because the env provider drops empty strings,
// as the former `process.env.X || default` reads did.
const getShellConfigFile = Effect.fnUntraced(function* () {
  const fs = yield* FSUtil.Service
  const shell = path.basename(yield* Config.String("SHELL").pipe(Config.withDefault("bash")))
  const home = os.homedir()
  const xdgConfig = yield* Config.String("XDG_CONFIG_HOME").pipe(Config.withDefault(path.join(home, ".config")))

  const configFiles: Record<string, string[]> = {
    fish: [path.join(xdgConfig, "fish", "config.fish")],
    zsh: [
      path.join(home, ".zshrc"),
      path.join(home, ".zshenv"),
      path.join(xdgConfig, "zsh", ".zshrc"),
      path.join(xdgConfig, "zsh", ".zshenv"),
    ],
    bash: [
      path.join(home, ".bashrc"),
      path.join(home, ".bash_profile"),
      path.join(home, ".profile"),
      path.join(xdgConfig, "bash", ".bashrc"),
      path.join(xdgConfig, "bash", ".bash_profile"),
    ],
    ash: [path.join(home, ".ashrc"), path.join(home, ".profile")],
    sh: [path.join(home, ".profile")],
  }

  const candidates = configFiles[shell] || configFiles.bash

  for (const file of candidates) {
    if (!(yield* fs.existsSafe(file))) continue

    const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
    if (content.includes("# opencode") || content.includes(".opencode/bin")) {
      return Option.some(file)
    }
  }

  return Option.none<string>()
}, Effect.orDie)

const cleanShellConfig = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FSUtil.Service
  const content = yield* fs.readFileString(file)
  const lines = content.split("\n")

  const filtered: string[] = []
  let skip = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === "# opencode") {
      skip = true
      continue
    }

    if (skip) {
      skip = false
      if (trimmed.includes(".opencode/bin") || trimmed.includes("fish_add_path")) {
        continue
      }
    }

    if (
      (trimmed.startsWith("export PATH=") && trimmed.includes(".opencode/bin")) ||
      (trimmed.startsWith("fish_add_path") && trimmed.includes(".opencode"))
    ) {
      continue
    }

    filtered.push(line)
  }

  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
    filtered.pop()
  }

  const output = filtered.join("\n") + "\n"
  yield* fs.writeWithDirs(file, output)
})

// Symlinks count as neither files nor directories, as the former Dirent checks did.
const getDirectorySize = (dir: string): Effect.Effect<number, never, FSUtil.Service> =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.orElseSucceed((): FSUtil.DirEntry[] => []))
    const sizes = yield* Effect.forEach(entries, (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.type === "directory") return getDirectorySize(full)
      if (entry.type === "file")
        return fs.stat(full).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => 0),
        )
      return Effect.succeed(0)
    })
    return sizes.reduce((total, size) => total + size, 0)
  })

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) {
    return p.replace(home, "~")
  }
  return p
}
