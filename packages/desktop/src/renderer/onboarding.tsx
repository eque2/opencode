import { ServerConnection, useServer, useSettings, useTabs } from "@opencode-ai/app"
import { Data, Effect } from "effect"
import { onMount } from "solid-js"

/** A step of first launch onboarding rejected. */
class OnboardingError extends Data.TaggedError("OnboardingError")<{ readonly cause: unknown }> {}

const attempt = <A,>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => new OnboardingError({ cause }) })

export function DesktopFirstLaunchOnboarding(props: { initialUrl: string; onLoaded: () => void }) {
  const server = useServer()
  const settings = useSettings()
  const tabs = useTabs()

  const runFirstLaunchOnboarding = Effect.gen(function* () {
    yield* Effect.all(
      [server.ready.promise, tabs.ready.promise, tabs.recentReady.promise].map((ready) =>
        ready ? attempt(() => ready) : Effect.void,
      ),
      { concurrency: "unbounded", discard: true },
    )
    const existingInstall = yield* attempt(() => window.api.isOldLayoutEligible())
    settings.general.setOldLayoutEligible(existingInstall)
    settings.general.initializeAgentVisibility(existingInstall)
    if (!server.isLocal()) return

    const pending = yield* attempt(() => window.api.isFirstLaunchOnboardingPending())
    if (!pending) return

    const shouldTrigger =
      !existingInstall &&
      props.initialUrl === "/" &&
      tabs.store.length === 0 &&
      server.list.every(ServerConnection.builtin)

    yield* Effect.logInfo("[desktop-onboarding] first launch onboarding evaluated", {
      pending,
      shouldTrigger,
      existingInstall,
      initialUrl: props.initialUrl,
      tabs: tabs.store.length,
      servers: server.list.map(ServerConnection.key),
    })

    const directory = yield* attempt(() => window.api.finishFirstLaunchOnboarding(shouldTrigger))
    if (!shouldTrigger || !directory) return

    yield* Effect.logInfo("[desktop-onboarding] starting first launch draft", { directory })
    server.projects.open(directory)
    server.projects.touch(directory)
    tabs.select(yield* attempt(() => tabs.newDraft({ server: server.key, directory })))
  }).pipe(
    // Like the former try/catch, this also logs a synchronous throw from the settings, server or tabs calls.
    Effect.catchCause((cause) => Effect.logError("[desktop-onboarding] first launch onboarding failed", cause)),
  )

  onMount(() => {
    Effect.runFork(runFirstLaunchOnboarding.pipe(Effect.ensuring(Effect.sync(props.onLoaded))))
  })

  // eslint-disable-next-line effect/no-null-use-option -- (a) a Solid component returns null to render nothing; this one only runs onMount
  return null
}
