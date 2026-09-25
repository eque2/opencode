import { base64Decode } from "@opencode-ai/core/util/encode"
import { Option } from "effect"

/** Decodes base64 text, or gives none when the text is not valid base64. */
const decode = Option.liftThrowable(base64Decode)

export function decode64(value: string | undefined) {
  if (value === undefined) return undefined
  return Option.getOrUndefined(decode(value))
}
