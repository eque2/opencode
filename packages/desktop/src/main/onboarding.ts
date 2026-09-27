import { existsSync, readdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { app } from "electron"
import { Data, Effect, Option } from "effect"
import { getStore } from "./store"
import { FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY, OLD_LAYOUT_ELIGIBLE_KEY } from "./store-keys"
import { write as writeLog } from "./logging"
import { hasExistingAppState } from "./install-state"

const DEFAULT_PROJECT_DIR = "Default Project"

export function initializeOldLayoutEligibility(userDataPath: string) {
  const entries = existsSync(userDataPath) ? readdirSync(userDataPath, { withFileTypes: true }) : []
  const store = getStore()
  const current = store.get(OLD_LAYOUT_ELIGIBLE_KEY)
  if (typeof current === "boolean") return current

  const eligible = hasExistingAppState(entries)
  store.set(OLD_LAYOUT_ELIGIBLE_KEY, eligible)
  return eligible
}

export function isOldLayoutEligible() {
  return getStore().get(OLD_LAYOUT_ELIGIBLE_KEY) === true
}

export function isFirstLaunchOnboardingPending() {
  const pending = getStore().get(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY) !== true
  writeLog("onboarding", "first launch onboarding pending checked", { pending })
  return pending
}

class OnboardingError extends Data.TaggedError("OnboardingError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export function finishFirstLaunchOnboarding(createDefaultProject: boolean) {
  return Effect.runPromise(finishOnboarding(createDefaultProject).pipe(Effect.map(Option.getOrNull)))
}

const finishOnboarding = Effect.fnUntraced(function* (createDefaultProject: boolean) {
  if (!isFirstLaunchOnboardingPending()) {
    writeLog("onboarding", "first launch onboarding already completed")
    return Option.none<string>()
  }

  const defaultProject = createDefaultProject
    ? Option.some(join(app.getPath("documents"), DEFAULT_PROJECT_DIR))
    : Option.none<string>()
  if (Option.isSome(defaultProject)) {
    yield* Effect.tryPromise({
      try: () => mkdir(defaultProject.value, { recursive: true }),
      catch: (cause) => new OnboardingError({ message: cause instanceof Error ? cause.message : String(cause), cause }),
    })
  }

  getStore().set(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY, true)
  writeLog("onboarding", "first launch onboarding completed", {
    createDefaultProject,
    defaultProject: Option.getOrNull(defaultProject),
  })
  return defaultProject
})
