import { createProviderToolFactoryWithOutputSchema } from "@ai-sdk/provider-utils"
import { Schema } from "effect"

export const localShellInputSchema = Schema.Struct({
  action: Schema.Struct({
    type: Schema.Literal("exec"),
    command: Schema.mutable(Schema.Array(Schema.String)),
    timeoutMs: Schema.optional(Schema.Finite),
    user: Schema.optional(Schema.String),
    workingDirectory: Schema.optional(Schema.String),
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
}).annotate({ identifier: "CopilotResponses.LocalShellInput" })

export const localShellOutputSchema = Schema.Struct({
  output: Schema.String,
}).annotate({ identifier: "CopilotResponses.LocalShellOutput" })

export const localShell = createProviderToolFactoryWithOutputSchema<
  {
    /**
     * Execute a shell command on the server.
     */
    action: {
      type: "exec"

      /**
       * The command to run.
       */
      command: string[]

      /**
       * Optional timeout in milliseconds for the command.
       */
      timeoutMs?: number

      /**
       * Optional user to run the command as.
       */
      user?: string

      /**
       * Optional working directory to run the command in.
       */
      workingDirectory?: string

      /**
       * Environment variables to set for the command.
       */
      env?: Record<string, string>
    }
  },
  {
    /**
     * The output of local shell tool call.
     */
    output: string
  },
  {}
>({
  id: "openai.local_shell",
  inputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(localShellInputSchema)),
  outputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(localShellOutputSchema)),
})
