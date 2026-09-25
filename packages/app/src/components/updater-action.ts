import { Data, Effect } from "effect"
import { createMemo } from "solid-js"
import type { UpdaterState } from "@/updater"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export function updaterAction(state: UpdaterState | undefined) {
  if (!state) return { label: "settings.updates.action.checkNow" as const }
  switch (state.status) {
    case "checking":
      return { label: "settings.updates.action.checking" as const }
    case "downloading":
      return { label: "settings.updates.action.downloading" as const }
    case "ready":
      return { label: "toast.update.action.installRestart" as const, run: "install" as const }
    case "installing":
      return { label: "settings.updates.action.installing" as const }
    case "disabled":
      return { label: "settings.updates.action.checkNow" as const }
    default:
      return { label: "settings.updates.action.checkNow" as const, run: "check" as const }
  }
}

/** A desktop updater request that rejected. `cause` is the original rejection. */
class UpdaterActionError extends Data.TaggedError("App.UpdaterActionError")<{ readonly cause: unknown }> {}

const updaterRequest = <A>(request: () => Promise<A>) =>
  Effect.tryPromise({ try: request, catch: (cause) => new UpdaterActionError({ cause }) })

export function useUpdaterAction() {
  const platform = usePlatform()
  const language = useLanguage()
  const action = createMemo(() => updaterAction(platform.updater?.state()))

  return {
    action,
    /** Runs the current action. The Promise rejects with UpdaterActionError when the updater request rejects. */
    run: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const run = action().run
          const updater = platform.updater
          if (!updater) return
          if (run === "install") {
            yield* updaterRequest(() => updater.install())
            return
          }
          if (run !== "check") return

          const state = yield* updaterRequest(() => updater.check())
          if (state.status === "up-to-date") {
            showToast({
              variant: "success",
              icon: "circle-check",
              title: language.t("settings.updates.toast.latest.title"),
              description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
            })
          }
          if (state.status === "error") {
            showToast({ title: language.t("common.requestFailed"), description: state.message })
          }
        }),
      ),
  }
}
