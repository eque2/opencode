import { Option } from "effect"

export function lazy<T>(fn: () => T) {
  let value: Option.Option<T> = Option.none()

  const result = (): T => {
    if (Option.isSome(value)) return value.value
    const loaded = fn()
    value = Option.some(loaded)
    return loaded
  }

  result.reset = () => {
    value = Option.none()
  }

  result.loaded = () => Option.isSome(value)

  return result
}
