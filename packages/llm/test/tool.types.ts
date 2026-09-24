import { Effect, Schema } from "effect"
import { LLM, LLMRequest, ToolCallPart, ToolRuntime, toDefinitions } from "../src"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { Auth } from "../src/route"
import { Tool } from "../src/tool"

const request = LLM.request({
  model: OpenAIChat.route.with({ auth: Auth.bearer("fixture") }).model({ id: "gpt-4o-mini" }),
  prompt: "Use the tool.",
})

const executable = Tool.make({
  description: "Get weather.",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ forecast: Schema.String }),
  execute: (input) => Effect.succeed({ forecast: input.city }),
})

const schemaOnly = Tool.make({
  description: "Get weather.",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ forecast: Schema.String }),
})

Tool.make({
  description: "Encode success before projection.",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ forecast: Schema.NumberFromString }),
  execute: () => Effect.succeed({ forecast: 1 }),
  toModelOutput: ({ callID, parameters, output }) => [
    { type: "text", text: `${callID}:${parameters.city}:${output.forecast}` },
  ],
})

export const streamed = LLM.stream(request)
export const generated = LLM.generate(LLMRequest.update(request, { tools: toDefinitions({ schemaOnly }) }))
export const dispatched = ToolRuntime.dispatch(
  { executable },
  ToolCallPart.make({ id: "call_1", name: "executable", input: { city: "Paris" } }),
)

// @ts-expect-error High-level tool orchestration overloads are intentionally not supported.
export const orchestrated = LLM.stream({ request, tools: { schemaOnly } })
