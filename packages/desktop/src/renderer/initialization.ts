import { Data } from "effect"

/** A local server startup failure that did not arrive as an Error instance. */
class LocalServerStartupError extends Data.TaggedError("LocalServerStartupError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export function initializationData<A>(state: (() => A | undefined) & { readonly error?: unknown }) {
  // eslint-disable-next-line effect/no-throw-use-effect -- (a) Solid computations report errors to ErrorBoundary only by throwing
  if (state.error !== undefined) throw markLocalServerStartup(state.error)
  return state()
}

function markLocalServerStartup(error: unknown) {
  const failure = error instanceof Error ? error : new LocalServerStartupError({ message: String(error), cause: error })
  const prefix = "Error invoking remote method 'await-initialization': Error: "
  if (failure.message.startsWith(prefix)) {
    const previous = failure.message
    failure.message = failure.message.slice(prefix.length)
    if (failure.stack) failure.stack = failure.stack.replace(`Error: ${previous}`, `Error: ${failure.message}`)
  }
  Object.defineProperty(failure, "localServerStartup", { value: true })
  return failure
}

export function initializationReady(state: (() => unknown) & { readonly error?: unknown; readonly loading: boolean }) {
  if (state.loading) return false
  initializationData(state)
  return true
}
