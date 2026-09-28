import { Effect, Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { Process } from "@/util/process"
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

export function ide() {
  // eslint-disable-next-line effect/no-process-env-use-config -- (c) public contract: Ide.ide() is a synchronous API exported through the package "./*" export and pinned by test/ide/ide.test.ts, which sets process.env after start; an Effect Config read would change the signature
  if (process.env["TERM_PROGRAM"] === "vscode") {
    // eslint-disable-next-line effect/no-process-env-use-config -- (c) public contract: Ide.ide() is a synchronous API exported through the package "./*" export and pinned by test/ide/ide.test.ts, which sets process.env after start; an Effect Config read would change the signature
    const v = process.env["GIT_ASKPASS"]
    for (const ide of SUPPORTED_IDES) {
      if (v?.includes(ide.name)) return ide.name
    }
  }
  return "unknown"
}

export function alreadyInstalled() {
  // eslint-disable-next-line effect/no-process-env-use-config -- (c) public contract: Ide.alreadyInstalled() is a synchronous API exported through the package "./*" export and pinned by test/ide/ide.test.ts, which sets process.env after start; an Effect Config read would change the signature
  const caller = process.env["OPENCODE_CALLER"]
  return caller === "vscode" || caller === "vscode-insiders"
}

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

  // nothrow turns every spawn or exit failure into a result, so this Promise does not reject.
  const p = yield* Effect.promise(() =>
    Process.run([entry.cmd, "--install-extension", "sst-dev.opencode"], {
      nothrow: true,
    }),
  )
  const stdout = p.stdout.toString()
  const stderr = p.stderr.toString()

  if (p.code !== 0) return yield* Effect.fail(new InstallFailedError({ stderr }))
  return yield* stdout.includes("already installed") ? Effect.fail(new AlreadyInstalledError({})) : Effect.void
})

export * as Ide from "."
