import type { EditorTraits } from "@opentui/core"
import { Option } from "effect"

export type PromptMode = "normal" | "shell"

export interface PromptTraitsInput {
  mode: PromptMode
  autocompleteVisible: boolean
}

export type PromptTraits = EditorTraits & {
  owner: "opencode"
  role: "prompt"
}

type PromptCapture = NonNullable<EditorTraits["capture"]>

/**
 * The managed textarea keymap owns `suspend`; these traits only describe capture and status.
 * The prompt spreads these traits over the current textarea traits, so an absent capture or
 * status stays an explicit `undefined` key that clears the previous value.
 */
export function computePromptTraits(input: PromptTraitsInput): PromptTraits {
  const capture: Option.Option<PromptCapture> =
    input.mode === "normal"
      ? Option.some(input.autocompleteVisible ? ["escape", "navigate", "submit", "tab"] : ["tab"])
      : Option.none()
  const status: Option.Option<string> = input.mode === "shell" ? Option.some("SHELL") : Option.none()
  return {
    capture: Option.getOrUndefined(capture),
    status: Option.getOrUndefined(status),
    owner: "opencode",
    role: "prompt",
  }
}
