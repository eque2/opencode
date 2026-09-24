export function memo<T>(fn: () => T, cleanup?: (input: T) => Promise<void>) {
  let state: { loaded: false } | { loaded: true; value: T } = { loaded: false }

  const result = (): T => {
    if (state.loaded) return state.value
    const value = fn()
    state = { loaded: true, value }
    return value
  }
  result.reset = async () => {
    if (cleanup && state.loaded && state.value) await cleanup(state.value)
    state = { loaded: false }
  }

  return result
}
