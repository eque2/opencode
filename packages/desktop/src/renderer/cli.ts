import { Data, Effect } from "effect"
import { initI18n, t } from "./i18n"

/** The main process rejected the CLI install request. */
class CliInstallError extends Data.TaggedError("CliInstallError")<{ readonly cause: unknown }> {}

export function installCli(): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.promise(() => initI18n())

      yield* Effect.tryPromise({
        try: () => window.api.installCli(),
        catch: (cause) => new CliInstallError({ cause }),
      }).pipe(
        Effect.match({
          onSuccess: (path) => window.alert(t("desktop.cli.installed.message", { path })),
          // The alert shows the rejection exactly as the IPC bridge delivered it.
          onFailure: (failure) => window.alert(t("desktop.cli.failed.message", { error: String(failure.cause) })),
        }),
      )
    }),
  )
}
