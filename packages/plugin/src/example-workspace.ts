import type { Plugin } from "@opencode-ai/plugin"
import { Effect, Random, Schema } from "effect"
import { mkdir, rm } from "node:fs/promises"

class FolderWorkspaceError extends Schema.TaggedError<FolderWorkspaceError>()("FolderWorkspaceError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const FolderWorkspacePlugin: Plugin = ({ experimental_workspace }) => {
  experimental_workspace.register("folder", {
    name: "Folder",
    description: "Create a blank folder",
    configure(config) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const rand = "" + (yield* Random.next)

          return {
            ...config,
            directory: `/tmp/folder/folder-${rand}`,
          }
        }),
      )
    },
    create(config) {
      const directory = config.directory
      if (!directory) return Effect.runPromise(Effect.void)
      return Effect.runPromise(
        Effect.tryPromise({
          try: () => mkdir(directory, { recursive: true }),
          catch: (cause) => new FolderWorkspaceError({ message: `Failed to create folder ${directory}`, cause }),
        }).pipe(Effect.asVoid),
      )
    },
    remove(config) {
      return Effect.runPromise(
        Effect.tryPromise({
          try: () => rm(config.directory!, { recursive: true, force: true }),
          catch: (cause) => new FolderWorkspaceError({ message: "Failed to remove folder", cause }),
        }),
      )
    },
    target(config) {
      return {
        type: "local",
        directory: config.directory!,
      }
    },
  })

  return Effect.runPromise(Effect.succeed({}))
}

export default FolderWorkspacePlugin
