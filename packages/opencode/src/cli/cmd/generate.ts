import type { CommandModule } from "yargs"
import { Effect, Schema } from "effect"

type Args = {}

const encodePrettyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

// generate writes the OpenAPI document to stdout for the SDK build scripts. It does not need AppRuntime,
// so it runs without it, as it did before, and opens no database.
const generate = Effect.gen(function* () {
  const { Server } = yield* Effect.promise(() => import("../../server/server"))
  const specs = (yield* Effect.promise(() => Server.openapi())) as {
    paths: Record<string, Record<string, any>>
  }
  for (const item of Object.values(specs.paths)) {
    for (const method of ["get", "post", "put", "delete", "patch"] as const) {
      const operation = item[method]
      if (!operation?.operationId) continue
      operation["x-codeSamples"] = [
        {
          lang: "js",
          source: [
            `import { createOpencodeClient } from "@opencode-ai/sdk`,
            ``,
            `const client = createOpencodeClient()`,
            `await client.${operation.operationId}({`,
            `  ...`,
            `})`,
          ].join("\n"),
        },
      ]
    }
  }
  const raw = yield* encodePrettyJson(specs).pipe(Effect.orDie)

  // Format through prettier so output is byte-identical to committed file
  // regardless of whether ./script/format.ts runs afterward.
  const prettier = yield* Effect.promise(() => import("prettier"))
  const babel = yield* Effect.promise(() => import("prettier/plugins/babel"))
  const estree = yield* Effect.promise(() => import("prettier/plugins/estree"))
  const format = prettier.format ?? prettier.default?.format
  // A formatting failure stays a defect, as it was when this was a rejected Promise.
  const json = yield* Effect.promise(() =>
    format(raw, {
      parser: "json",
      plugins: [babel.default ?? babel, estree.default ?? estree],
      printWidth: 120,
    }),
  )

  // Wait for stdout to finish writing before process.exit() is called
  yield* Effect.callback<void>((resume) => {
    process.stdout.write(json, (err) => resume(err ? Effect.die(err) : Effect.void))
  })
})

export const GenerateCommand = {
  command: "generate",
  builder: (yargs) => yargs,
  handler: () => Effect.runPromise(generate),
} satisfies CommandModule<object, Args>
