import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { FlagConfig } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"
import { Effect } from "effect"

export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  const flags = await Effect.runPromise(
    Effect.all({
      disableAutoupdate: FlagConfig.OPENCODE_DISABLE_AUTOUPDATE,
      alwaysNotifyUpdate: FlagConfig.OPENCODE_ALWAYS_NOTIFY_UPDATE,
    }),
  )
  if (config.autoupdate === false || flags.disableAutoupdate) return
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch(() => {})
  if (!latest) return

  if (flags.alwaysNotifyUpdate) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (InstallationVersion === latest) return

  const kind = Installation.getReleaseType(InstallationVersion, latest)

  if (config.autoupdate === "notify" || kind !== "patch") {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (method === "unknown") return
  await Installation.upgrade(method, latest)
    .then(() =>
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: latest },
        },
      }),
    )
    .catch(() => {})
}
