import { Config } from "@/config/config"
import { FlagConfig } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"
import { Effect } from "effect"

const emitVersion = (type: string, version: string) =>
  GlobalBus.publish({
    directory: "global",
    payload: { type, properties: { version } },
  })

// Background auto-update check. Every lookup or upgrade failure is swallowed, so it never fails its caller.
export const upgrade = Effect.fn("Cli.upgrade")(function* () {
  const cfg = yield* Config.Service
  const config = yield* cfg.getGlobal()
  const flags = yield* Effect.all({
    disableAutoupdate: FlagConfig.OPENCODE_DISABLE_AUTOUPDATE,
    alwaysNotifyUpdate: FlagConfig.OPENCODE_ALWAYS_NOTIFY_UPDATE,
  })
  if (config.autoupdate === false || flags.disableAutoupdate) return
  const installation = yield* Installation.Service
  const method = yield* installation.method()
  // Installation.latest turns lookup errors into defects, so catch the whole cause.
  const latest = yield* installation.latest(method).pipe(Effect.catchCause(() => Effect.succeed("")))
  if (!latest) return

  if (flags.alwaysNotifyUpdate) {
    yield* emitVersion(Installation.Event.UpdateAvailable.type, latest)
    return
  }

  if (InstallationVersion === latest) return

  const kind = Installation.getReleaseType(InstallationVersion, latest)

  if (config.autoupdate === "notify" || kind !== "patch") {
    yield* emitVersion(Installation.Event.UpdateAvailable.type, latest)
    return
  }

  if (method === "unknown") return
  yield* installation.upgrade(method, latest).pipe(
    Effect.andThen(emitVersion(Installation.Event.Updated.type, latest)),
    Effect.catchCause(() => Effect.void),
  )
})
