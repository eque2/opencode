import { Predicate } from "effect"

type RecordValue = Record<string, unknown>

// Arrays pass too, as with the old `typeof value === "object"` check.
const isRecord = (value: unknown): value is RecordValue => Predicate.isObjectOrArray(value)

export const isDisposable = (value: unknown): value is { dispose: () => void } => {
  return isRecord(value) && typeof value.dispose === "function"
}

export const disposeIfDisposable = (value: unknown) => {
  if (!isDisposable(value)) return
  value.dispose()
}

export const hasSetOption = (value: unknown): value is { setOption: (key: string, next: unknown) => void } => {
  return isRecord(value) && typeof value.setOption === "function"
}

export const setOptionIfSupported = (value: unknown, key: string, next: unknown) => {
  if (!hasSetOption(value)) return
  value.setOption(key, next)
}

export const getHoveredLinkText = (value: unknown) => {
  if (!isRecord(value)) return undefined
  const link = value.currentHoveredLink
  if (!isRecord(link)) return undefined
  if (typeof link.text !== "string") return undefined
  return link.text
}

/** The speech recognition constructor of a window-like value, webkit first. The check proves only that it is a function. */
export const getSpeechRecognitionCtor = (value: unknown): Function | undefined => {
  if (!isRecord(value)) return undefined
  const ctor =
    typeof value.webkitSpeechRecognition === "function" ? value.webkitSpeechRecognition : value.SpeechRecognition
  if (!Predicate.isFunction(ctor)) return undefined
  return ctor
}
