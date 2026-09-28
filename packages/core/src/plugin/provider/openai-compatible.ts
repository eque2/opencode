import { Effect } from "effect"
import { define } from "../internal"

export const OpenAICompatiblePlugin = define({
  id: "openai-compatible",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.sdk) return
        if (!evt.package.includes("@ai-sdk/openai-compatible")) return
        if (evt.options.includeUsage !== false) evt.options.includeUsage = true
        const mod = yield* Effect.promise(() => import("@ai-sdk/openai-compatible"))
        evt.sdk = mod.createOpenAICompatible({
          ...evt.options,
          // Name the two settings that the SDK type requires; both come from the host's SDK options.
          name: evt.options.name,
          baseURL: evt.options.baseURL,
        })
      }),
    )
  }),
})
