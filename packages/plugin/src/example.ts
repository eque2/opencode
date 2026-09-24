import { Effect } from "effect"
import { Plugin } from "./index.js"
import { tool } from "./tool.js"

export const ExamplePlugin: Plugin = (_ctx) => {
  return Effect.runPromise(
    Effect.succeed({
      tool: {
        mytool: tool({
          description: "This is a custom tool",
          args: {
            foo: tool.schema.string().describe("foo"),
          },
          execute(args) {
            return Effect.runPromise(Effect.succeed(`Hello ${args.foo}!`))
          },
        }),
      },
    }),
  )
}
