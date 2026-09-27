import { join } from "node:path"
import { app } from "electron"
import { NodeFileSystem } from "@effect/platform-node"
import { Data, Effect, FileSystem, Option } from "effect"
import { getStore } from "./store"
import { FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY, OLD_LAYOUT_ELIGIBLE_KEY } from "./store-keys"
import { write as writeLog } from "./logging"
import { hasExistingAppState } from "./install-state"

const DEFAULT_PROJECT_DIR = "Default Project"

export const initializeOldLayoutEligibility = Effect.fnUntraced(function* (userDataPath: string) {
  const store = getStore()
  const current = store.get(OLD_LAYOUT_ELIGIBLE_KEY)
  if (typeof current === "boolean") return current

  const eligible = hasExistingAppState(yield* listEntries(userDataPath))
  store.set(OLD_LAYOUT_ELIGIBLE_KEY, eligible)
  return eligible
})

// Lists the folder with a directory flag for each entry. A missing folder has no entries.
// A folder that exists but cannot be listed stops startup, as the thrown error did.
const listEntries = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) return []
  const names = yield* fs.readDirectory(path).pipe(Effect.orDie)
  return yield* Effect.forEach(
    names,
    (name) =>
      fs.stat(join(path, name)).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
        Effect.map((directory) => ({ name, isDirectory: () => directory })),
      ),
    { concurrency: "unbounded" },
  )
})

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
  return Effect.runPromise(
    finishOnboarding(createDefaultProject).pipe(Effect.map(Option.getOrNull), Effect.provide(NodeFileSystem.layer)),
  )
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
    const fs = yield* FileSystem.FileSystem
    // The renderer receives the Node.js message text, which PlatformError keeps as its cause.
    yield* fs.makeDirectory(defaultProject.value, { recursive: true }).pipe(
      Effect.mapError((error) => {
        const cause = error.cause ?? error
        return new OnboardingError({ message: cause instanceof Error ? cause.message : error.message, cause })
      }),
    )
  }

  getStore().set(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY, true)
  writeLog("onboarding", "first launch onboarding completed", {
    createDefaultProject,
    defaultProject: Option.getOrNull(defaultProject),
  })
  return defaultProject
})
