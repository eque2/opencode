import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Effect } from "effect"

export function CerebrasPlugin(_input: PluginInput): Promise<Hooks> {
  const hooks: Hooks = {
    "chat.params": (input, output) =>
      Effect.runPromise(
        Effect.sync(() => {
          if (input.model.api.npm !== "@ai-sdk/cerebras") return
          if (output.options.max_completion_tokens === undefined) return
          // eslint-disable-next-line effect/no-undefined-use-option -- (c) the plugin SDK chat.params output declares maxOutputTokens as number | undefined, and the JavaScript undefined value clears the generic cap
          output.maxOutputTokens = undefined
        }),
      ),
  }
  return Effect.runPromise(Effect.succeed(hooks))
}
