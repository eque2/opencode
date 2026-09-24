import { Option } from "effect"

export function lazy<T>(fn: () => T) {
  let cached: Option.Option<T> = Option.none()

  return (): T => {
    if (Option.isSome(cached)) return cached.value
    const value = fn()
    cached = Option.some(value)
    return value
  }
}
