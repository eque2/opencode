import { type LanguageModelV3CallOptions, type SharedV3Warning, UnsupportedFunctionalityError } from "@ai-sdk/provider"
import { Effect, Predicate } from "effect"

export function prepareTools({
  tools,
  toolChoice,
}: {
  tools: LanguageModelV3CallOptions["tools"]
  toolChoice?: LanguageModelV3CallOptions["toolChoice"]
}): Effect.Effect<
  {
    tools:
      | undefined
      | Array<{
          type: "function"
          function: {
            name: string
            description: string | undefined
            parameters: unknown
          }
        }>
    toolChoice: { type: "function"; function: { name: string } } | "auto" | "none" | "required" | undefined
    toolWarnings: SharedV3Warning[]
  },
  UnsupportedFunctionalityError
> {
  // when the tools array is empty, change it to undefined to prevent errors:
  tools = tools?.length ? tools : undefined

  if (Predicate.isNullish(tools)) {
    return Effect.succeed({ tools: undefined, toolChoice: undefined, toolWarnings: [] })
  }

  const toolWarnings = tools.flatMap((tool): SharedV3Warning[] =>
    tool.type === "provider" ? [{ type: "unsupported", feature: `tool type: ${tool.type}` }] : [],
  )
  const openaiCompatTools = tools.flatMap((tool) =>
    tool.type === "provider"
      ? []
      : [
          {
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          },
        ],
  )

  if (Predicate.isNullish(toolChoice)) {
    return Effect.succeed({ tools: openaiCompatTools, toolChoice: undefined, toolWarnings })
  }

  const type = toolChoice.type

  switch (type) {
    case "auto":
    case "none":
    case "required":
      return Effect.succeed({ tools: openaiCompatTools, toolChoice: type, toolWarnings })
    case "tool":
      return Effect.succeed({
        tools: openaiCompatTools,
        toolChoice: {
          type: "function" as const,
          function: { name: toolChoice.toolName },
        },
        toolWarnings,
      })
    default: {
      const _exhaustiveCheck: never = type
      return Effect.fail(
        new UnsupportedFunctionalityError({
          functionality: `tool choice type: ${String(_exhaustiveCheck)}`,
        }),
      )
    }
  }
}
