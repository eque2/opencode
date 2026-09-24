import { registerCustomTheme } from "@pierre/diffs"
import { Effect } from "effect"
import { OpenCodeTheme } from "./marked-theme"

let registered = false

export function registerOpenCodeTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("OpenCode", () => Effect.runPromise(Effect.succeed(OpenCodeTheme)))
}
