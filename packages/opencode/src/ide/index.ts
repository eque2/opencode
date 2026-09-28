import { Config, ConfigProvider, Effect, Option, Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { AppProcess } from "@opencode-ai/core/process"
import { ChildProcess } from "effect/unstable/process"
import { IdeEvent } from "@opencode-ai/schema/ide-event"

const SUPPORTED_IDES = [
  { name: "Windsurf" as const, cmd: "windsurf" },
  { name: "Visual Studio Code - Insiders" as const, cmd: "code-insiders" },
  { name: "Visual Studio Code" as const, cmd: "code" },
  { name: "Cursor" as const, cmd: "cursor" },
  { name: "VSCodium" as const, cmd: "codium" },
]

export const Event = IdeEvent

export const AlreadyInstalledError = NamedError.create("AlreadyInstalledError", {})

export const InstallFailedError = NamedError.create("InstallFailedError", {
  stderr: Schema.String,
})

// Reads a variable from the live process environment on each run, keeping empty values as set.
const processEnv = (key: string) =>
  Effect.suspend(() =>
    Config.option(Config.String(key)).parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
  ).pipe(Effect.orDie)

/** The IDE whose integrated terminal runs this process, or "unknown". */
export const ide = Effect.fn("Ide.ide")(function* () {
  const term = yield* processEnv("TERM_PROGRAM")
  if (Option.getOrUndefined(term) !== "vscode") return "unknown"
  const askpass = Option.getOrElse(yield* processEnv("GIT_ASKPASS"), () => "")
  return SUPPORTED_IDES.find((entry) => askpass.includes(entry.name))?.name ?? "unknown"
})

/** True when a VS Code extension started this process, so the extension is already installed. */
export const alreadyInstalled = Effect.fn("Ide.alreadyInstalled")(function* () {
  const caller = yield* processEnv("OPENCODE_CALLER")
  return Option.exists(caller, (value) => value === "vscode" || value === "vscode-insiders")
})

/** The IDE name has no entry in SUPPORTED_IDES. */
export class UnknownIdeError extends Schema.TaggedError<UnknownIdeError>()("UnknownIdeError", {
  ide: Schema.String,
}) {
  override get message() {
    return `Unknown IDE: ${this.ide}`
  }
}

export const install = Effect.fn("Ide.install")(function* (ide: (typeof SUPPORTED_IDES)[number]["name"]) {
  const entry = SUPPORTED_IDES.find((i) => i.name === ide)
  if (!entry) return yield* new UnknownIdeError({ ide })

  const appProcess = yield* AppProcess.Service
  // An IDE command that cannot start fails the install with the failure text as its stderr.
  const p = yield* appProcess
    .run(ChildProcess.make(entry.cmd, ["--install-extension", "sst-dev.opencode"], { stdin: "ignore" }))
    .pipe(Effect.mapError((error) => new InstallFailedError({ stderr: error.message })))
  const stdout = p.stdout.toString()
  const stderr = p.stderr.toString()

  if (p.exitCode !== 0) return yield* Effect.fail(new InstallFailedError({ stderr }))
  return yield* stdout.includes("already installed") ? Effect.fail(new AlreadyInstalledError({})) : Effect.void
})

export * as Ide from "."
